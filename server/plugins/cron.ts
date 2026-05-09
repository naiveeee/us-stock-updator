/**
 * Cron 定时任务插件
 *
 * 每个工作日美东 17:00（收盘后 1 小时）自动执行：
 *   1. 采集前一个工作日的日线数据（Grouped Daily）
 *      注意：Polygon Free/Basic 计划不允许在当天收盘前请求当天数据，
 *      因此改为采集"前一个工作日"确保数据已就绪。
 *   2. 计算该日 RS Rating
 *
 * 控制逻辑：
 * - 每分钟检查一次是否到了触发时间
 * - 已执行过的日期跳过（幂等）
 * - 采集失败后自动延迟 30 分钟重试一次
 * - 支持通过 CRON_DISABLED=true 环境变量关闭
 */
import { getDb } from "../utils/db";
import { fetchGroupedDaily } from "../utils/massive";
import { computeAndSaveRS } from "../utils/rs-rating";
import { refreshRsDatesFile } from "../utils/rs-dates-cache";
import { scheduleStatsRefresh, incrementDbStats } from "../utils/db-stats";

// ── 配置 ──
const TARGET_HOUR_ET = 17; // 美东 17:00（收盘后 1 小时）
const TARGET_MINUTE_ET = 0;
const CHECK_INTERVAL = 60_000; // 每分钟检查一次
const RETRY_DELAY = 30 * 60_000; // 失败后 30 分钟重试

// 记录已跑过的日期，避免重复
const executedDates = new Set<string>();
// 记录已重试过的日期，每天最多重试 1 次
const retriedDates = new Set<string>();
let cronTimer: ReturnType<typeof setInterval> | null = null;
const processStartTime = Date.now();

/**
 * 获取当前美东时间
 */
function getETNow(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

/**
 * 判断是否为工作日（周一~周五）
 */
function isWeekday(date: Date): boolean {
  const dow = date.getDay();
  return dow >= 1 && dow <= 5;
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 采集单天数据
 */
async function fetchToday(dateStr: string, apiKey: string): Promise<number> {
  const db = getDb();

  // 检查是否已经采集过
  const existing = db
    .prepare("SELECT status FROM fetch_progress WHERE date = ?")
    .get(dateStr) as { status: string } | undefined;

  if (existing && (existing.status === "done" || existing.status === "empty")) {
    console.log(`[Cron] ${dateStr} 已采集，跳过`);
    return 0;
  }

  console.log(`[Cron] 开始采集 ${dateStr}...`);

  try {
    const data = await fetchGroupedDaily(dateStr, apiKey);
    const results = data.results || [];

    if (results.length === 0) {
      db.prepare(
        "INSERT OR REPLACE INTO fetch_progress (date, status, result_count, fetched_at, http_status) VALUES (?, 'empty', 0, ?, 200)"
      ).run(dateStr, new Date().toISOString());
      console.log(`[Cron] ${dateStr}: 非交易日/无数据`);
      return 0;
    }

    // 批量写入
    const insertBar = db.prepare(`
      INSERT OR REPLACE INTO daily_bars
      (ticker, date, open, high, low, close, volume, vwap, num_trades, is_otc, timestamp_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProgress = db.prepare(`
      INSERT OR REPLACE INTO fetch_progress
      (date, status, result_count, fetched_at, http_status)
      VALUES (?, 'done', ?, ?, 200)
    `);

    const insertAll = db.transaction(() => {
      for (const r of results) {
        if (!r.T) continue;
        insertBar.run(
          r.T,
          dateStr,
          r.o ?? null,
          r.h ?? null,
          r.l ?? null,
          r.c ?? null,
          r.v ?? null,
          r.vw ?? null,
          r.n ?? null,
          r.otc ? 1 : 0,
          r.t ?? null
        );
      }
      insertProgress.run(dateStr, results.length, new Date().toISOString());
    });

    insertAll();
    console.log(`[Cron] ${dateStr}: 采集完成, ${results.length} 只股票`);

    // 增量更新数据库统计
    try {
      incrementDbStats(results.length, dateStr);
    } catch (e: any) {
      console.error(`[Cron] 统计更新失败: ${e?.message || e}`);
    }

    return results.length;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[Cron] ${dateStr} 采集失败: ${msg}`);
    db.prepare(
      "INSERT OR REPLACE INTO fetch_progress (date, status, error_msg, fetched_at) VALUES (?, 'error', ?, ?)"
    ).run(dateStr, msg, new Date().toISOString());
    return -1;
  }
}

/**
 * 获取前一个工作日日期（跳过周末）
 */
function getPreviousWeekday(from: Date): Date {
  const d = new Date(from);
  d.setDate(d.getDate() - 1);
  while (!isWeekday(d)) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/**
 * 每分钟检查，到点就跑
 */
async function cronCheck() {
  const etNow = getETNow();

  // 不是工作日直接跳
  if (!isWeekday(etNow)) return;

  // 还没到点
  if (etNow.getHours() !== TARGET_HOUR_ET || etNow.getMinutes() !== TARGET_MINUTE_ET) return;

  const todayStr = formatDate(etNow);

  // 今天已跑过
  if (executedDates.has(todayStr)) return;

  // 标记已执行（先标记防止重入）
  executedDates.add(todayStr);

  // 采集前一个工作日的数据（Polygon Free/Basic 当天数据在收盘后仍需延迟才可用）
  const targetDate = getPreviousWeekday(etNow);
  const targetDateStr = formatDate(targetDate);

  const sysNow = new Date();
  console.log(`\n[Cron] ════════════════════════════════════════`);
  console.log(`[Cron] 自动任务触发: ${todayStr} ET ${TARGET_HOUR_ET}:00`);
  console.log(`[Cron] 采集目标日期: ${targetDateStr}（前一个工作日）`);
  console.log(`[Cron] 系统时间: ${sysNow.toISOString()} | 美东: ${etNow.toLocaleString()}`);
  console.log(`[Cron] 进程已运行: ${Math.round((sysNow.getTime() - processStartTime) / 1000)}s`);
  console.log(`[Cron] ════════════════════════════════════════\n`);

  try {
    const config = useRuntimeConfig();
    const apiKey = config.massiveApiKey;

    console.log(`[Cron] API Key: ${apiKey ? apiKey.slice(0, 4) + '****' + apiKey.slice(-4) : '(空)'}`);
    console.log(`[Cron] 请求目标: https://api.massive.com/v2/aggs/grouped/.../stocks/${targetDateStr}`);

    if (!apiKey) {
      console.error("[Cron] ❌ MASSIVE_API_KEY 未配置！生产模式下需要通过系统环境变量注入，.env 文件不会被自动加载");
      console.error("[Cron] 解决方式: pm2 的 ecosystem.config.js 里配置 env，或启动前 export MASSIVE_API_KEY=xxx");
      return;
    }

    // 采集前一个工作日数据
    const count = await fetchToday(targetDateStr, apiKey);

    if (count < 0) {
      console.error("[Cron] ❌ 采集失败");

      // 自动重试：30 分钟后再试一次
      if (!retriedDates.has(targetDateStr)) {
        retriedDates.add(targetDateStr);
        console.log(`[Cron] ⏳ 将在 ${RETRY_DELAY / 60000} 分钟后自动重试...`);
        setTimeout(async () => {
          console.log(`\n[Cron] 🔄 重试采集 ${targetDateStr}...`);
          try {
            // 先清除 error 状态，让 fetchToday 可以重新采集
            const db = getDb();
            db.prepare("DELETE FROM fetch_progress WHERE date = ? AND status = 'error'").run(targetDateStr);

            const retryCount = await fetchToday(targetDateStr, apiKey);
            if (retryCount >= 0) {
              console.log(`[Cron] ✅ 重试成功: ${retryCount} 只股票`);
              // 重试成功后也算 RS
              try {
                const rsCount = computeAndSaveRS(db, targetDateStr);
                console.log(`[Cron] RS Rating 计算完成: ${rsCount} 只股票`);
              } catch (e: any) {
                console.error(`[Cron] RS Rating 计算失败: ${e?.message || e}`);
              }
            } else {
              console.error(`[Cron] ❌ 重试仍然失败，需要手动处理`);
            }
          } catch (e: any) {
            console.error(`[Cron] ❌ 重试异常: ${e?.message || e}`);
          }
        }, RETRY_DELAY);
      }
      return;
    }

    console.log(`[Cron] 采集完成: ${count} 只股票`);

    // 计算该日 RS Rating
    try {
      console.log("[Cron] 开始计算 RS Rating...");
      const db = getDb();
      const rsCount = computeAndSaveRS(db, targetDateStr);
      console.log(`[Cron] RS Rating 计算完成: ${rsCount} 只股票`);
    } catch (err: any) {
      console.error(`[Cron] RS Rating 计算失败: ${err?.message || err}`);
    }

    console.log(`[Cron] ════════════════════════════════════════\n`);
  } catch (err: any) {
    console.error(`[Cron] 执行异常: ${err?.message || err}`);
  }
}

// ── WAL Checkpoint ──
// 防止 WAL 文件无限增长导致查询变慢/服务卡顿
const WAL_CHECKPOINT_INTERVAL = 5 * 60_000; // 每 5 分钟执行一次
let walTimer: ReturnType<typeof setInterval> | null = null;

function walCheckpoint() {
  try {
    const db = getDb();
    // 先尝试 TRUNCATE（最彻底，清空 WAL 文件）
    // 如果 backfill worker 正在写，TRUNCATE 可能失败，退回 PASSIVE
    let result = db.pragma("wal_checkpoint(TRUNCATE)") as any[];
    let row = result?.[0];
    if (row && row.busy === 1) {
      // TRUNCATE 被阻塞，退回 PASSIVE 做部分 checkpoint
      result = db.pragma("wal_checkpoint(PASSIVE)") as any[];
      row = result?.[0];
    }
    if (row && (row.pages_to_checkpoint > 0 || row.checkpointed_pages > 0)) {
      console.log(`[WAL] Checkpoint: ${row.checkpointed_pages}/${row.pages_to_checkpoint} pages`);
    }
    // checkpoint 后刷新 dates JSON 文件（此时 DB 读取快）
    refreshRsDatesFile(db);
  } catch (err: any) {
    // 不影响主流程
    console.error(`[WAL] Checkpoint 失败: ${err?.message || err}`);
  }
}

// ── Nitro 插件入口 ──
export default defineNitroPlugin((nitro) => {
  const disabled = process.env.CRON_DISABLED === "true";

  if (disabled) {
    console.log("[Cron] 定时任务已禁用 (CRON_DISABLED=true)");
    return;
  }

  console.log(`[Cron] 定时任务已启动, 每工作日美东 ${TARGET_HOUR_ET}:${String(TARGET_MINUTE_ET).padStart(2, '0')} 自动采集数据并计算 RS Rating`);

  // 启动时立即生成 rs-dates.json（dates API 依赖此文件）
  try {
    const db = getDb();
    refreshRsDatesFile(db);
    console.log("[Cron] rs-dates.json 初始化完成");
  } catch (e: any) {
    console.error(`[Cron] rs-dates.json 初始化失败: ${e?.message || e}`);
  }

  // 启动时后台刷新数据库统计（不阻塞请求）
  scheduleStatsRefresh();

  // 启动时检查最近 5 个工作日是否有缺失数据，自动补采
  setTimeout(async () => {
    try {
      const config = useRuntimeConfig();
      const apiKey = config.massiveApiKey;
      if (!apiKey) return;

      const db = getDb();
      const etNow = getETNow();
      const missingDates: string[] = [];

      // 往回检查最近 7 天（覆盖周末间隔）
      for (let i = 1; i <= 7; i++) {
        const d = new Date(etNow);
        d.setDate(d.getDate() - i);
        if (!isWeekday(d)) continue;
        const dateStr = formatDate(d);
        const existing = db
          .prepare("SELECT status FROM fetch_progress WHERE date = ?")
          .get(dateStr) as { status: string } | undefined;
        if (!existing || existing.status === "error") {
          missingDates.push(dateStr);
        }
      }

      if (missingDates.length > 0) {
        console.log(`[Cron] 发现 ${missingDates.length} 个工作日数据缺失: ${missingDates.join(", ")}`);
        console.log("[Cron] 启动自动补采...");

        for (const dateStr of missingDates.sort()) {
          // 先清 error 状态
          db.prepare("DELETE FROM fetch_progress WHERE date = ? AND status = 'error'").run(dateStr);
          const count = await fetchToday(dateStr, apiKey);
          if (count > 0) {
            try {
              const rsCount = computeAndSaveRS(db, dateStr);
              console.log(`[Cron] 补采 ${dateStr}: RS ${rsCount} tickers`);
            } catch (e: any) {
              console.error(`[Cron] 补采 ${dateStr} RS 计算失败: ${e?.message || e}`);
            }
          } else if (count < 0) {
            // 采集失败（可能是 403），停止补采避免无效重试
            console.error(`[Cron] 补采 ${dateStr} 失败，停止后续补采`);
            break;
          }
          // 每次请求间隔 13 秒，与主采集引擎一致，避免触发 rate limit
          await new Promise((r) => setTimeout(r, 13_000));
        }
        // 补采完成后刷新 dates 文件
        refreshRsDatesFile(db);
        console.log("[Cron] 自动补采完成");
      } else {
        console.log("[Cron] 最近 7 天数据完整，无需补采");
      }
    } catch (e: any) {
      console.error(`[Cron] 补采检查异常: ${e?.message || e}`);
    }
  }, 15_000); // 延迟 15 秒启动，等服务就绪

  // 启动定时检查
  cronTimer = setInterval(() => {
    cronCheck().catch((err) => {
      console.error("[Cron] 检查异常:", err);
    });
  }, CHECK_INTERVAL);

  // 启动 WAL checkpoint 定时器
  walTimer = setInterval(walCheckpoint, WAL_CHECKPOINT_INTERVAL);
  // 启动时也做一次
  setTimeout(walCheckpoint, 10_000);

  // 服务关闭时清理
  nitro.hooks.hook("close", () => {
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
    }
    if (walTimer) {
      clearInterval(walTimer);
      walTimer = null;
    }
    console.log("[Cron] 定时任务已停止");
  });
});

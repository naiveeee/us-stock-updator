/**
 * Cron 定时任务插件
 *
 * 每个工作日美东 17:00（收盘后 1 小时）自动执行：
 *   采集当天日线数据（Grouped Daily）
 *
 * 控制逻辑：
 * - 每分钟检查一次是否到了触发时间
 * - 已执行过的日期跳过（幂等）
 * - 支持通过 CRON_DISABLED=true 环境变量关闭
 */
import { getDb } from "../utils/db";
import { fetchGroupedDaily } from "../utils/massive";

// ── 配置 ──
const TARGET_HOUR_ET = 17; // 美东 17:00
const TARGET_MINUTE_ET = 0;
const CHECK_INTERVAL = 60_000; // 每分钟检查一次

// 记录已跑过的日期，避免重复
const executedDates = new Set<string>();
let cronTimer: ReturnType<typeof setInterval> | null = null;

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

  console.log(`\n[Cron] ════════════════════════════════════════`);
  console.log(`[Cron] 自动任务触发: ${todayStr} ET ${TARGET_HOUR_ET}:00`);
  console.log(`[Cron] ════════════════════════════════════════\n`);

  try {
    const config = useRuntimeConfig();
    const apiKey = config.massiveApiKey;

    if (!apiKey) {
      console.error("[Cron] ❌ MASSIVE_API_KEY 未配置，跳过采集");
      return;
    }

    // 采集当天数据
    const count = await fetchToday(todayStr, apiKey);

    if (count < 0) {
      console.error("[Cron] ❌ 采集失败");
      return;
    }

    console.log(`[Cron] 采集完成: ${count} 只股票`);
    console.log(`[Cron] ════════════════════════════════════════\n`);
  } catch (err: any) {
    console.error(`[Cron] 执行异常: ${err?.message || err}`);
  }
}

// ── Nitro 插件入口 ──
export default defineNitroPlugin((nitro) => {
  const disabled = process.env.CRON_DISABLED === "true";

  if (disabled) {
    console.log("[Cron] 定时任务已禁用 (CRON_DISABLED=true)");
    return;
  }

  console.log(`[Cron] 定时任务已启动, 每工作日美东 ${TARGET_HOUR_ET}:00 自动采集当日数据`);

  // 启动定时检查
  cronTimer = setInterval(() => {
    cronCheck().catch((err) => {
      console.error("[Cron] 检查异常:", err);
    });
  }, CHECK_INTERVAL);

  // 服务关闭时清理
  nitro.hooks.hook("close", () => {
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
      console.log("[Cron] 定时任务已停止");
    }
  });
});

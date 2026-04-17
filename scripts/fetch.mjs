#!/usr/bin/env node
/**
 * 独立采集脚本 — 可直接 node 运行，不需要启动 Nuxt 服务
 *
 * 用法：
 *   node scripts/fetch.mjs                  # 首次 / 断点续传
 *   node scripts/fetch.mjs --retry-errors   # 重试失败日期
 *   node scripts/fetch.mjs --status         # 查看进度
 *
 * 环境变量：
 *   MASSIVE_API_KEY  - Massive API Key (必填)
 *   DB_PATH          - 数据库路径 (可选，默认 ./data/stocks.db)
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ============================================================
// 配置
// ============================================================
const API_KEY = process.env.MASSIVE_API_KEY || "";
const DB_PATH = resolve(process.env.DB_PATH || resolve(PROJECT_ROOT, "data/stocks.db"));
const RATE_LIMIT_DELAY = 13_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE = 65_000;
const HISTORY_YEARS = 2;

let shouldStop = false;
process.on("SIGINT", () => {
  console.log("\n\n⏸️  收到中断信号，完成当前请求后安全退出...");
  shouldStop = true;
});
process.on("SIGTERM", () => {
  shouldStop = true;
});

// ============================================================
// 数据库
// ============================================================
function initDb() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_bars (
      ticker       TEXT NOT NULL,
      date         TEXT NOT NULL,
      open         REAL,
      high         REAL,
      low          REAL,
      close        REAL,
      volume       REAL,
      vwap         REAL,
      num_trades   INTEGER,
      is_otc       INTEGER DEFAULT 0,
      timestamp_ms INTEGER,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_bars_date ON daily_bars(date);
    CREATE INDEX IF NOT EXISTS idx_daily_bars_ticker ON daily_bars(ticker);

    CREATE TABLE IF NOT EXISTS fetch_progress (
      date         TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      error_msg    TEXT,
      fetched_at   TEXT,
      http_status  INTEGER DEFAULT 0
    );
  `);
  return db;
}

// ============================================================
// API 请求
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchGroupedDaily(date) {
  const url = `https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&include_otc=false&apiKey=${API_KEY}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
        headers: { Accept: "application/json" },
      });

      if (resp.ok) return await resp.json();

      if (resp.status === 404) {
        return { status: "NOT_FOUND", resultsCount: 0, results: [] };
      }
      if (resp.status === 403) {
        throw new Error("403 Forbidden - API Key 无效或无权限");
      }
      if (resp.status === 429) {
        const wait = BACKOFF_BASE * attempt;
        console.log(`    ⚠️ 429 (attempt ${attempt}/${MAX_RETRIES}), wait ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }

      if (attempt === MAX_RETRIES) {
        throw new Error(`HTTP ${resp.status} after ${MAX_RETRIES} retries`);
      }
      await sleep(10_000 * attempt);
    } catch (err) {
      if (err.message?.includes("403")) throw err;
      if (attempt === MAX_RETRIES) throw err;
      console.log(`    ⚠️ ${err.message} (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(10_000 * attempt);
    }
  }
}

// ============================================================
// 工具函数
// ============================================================
function generateWeekdays(start, end) {
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getDay() >= 1 && cur.getDay() <= 5) {
      days.push(cur.toISOString().slice(0, 10));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// ============================================================
// 状态查询
// ============================================================
function showStatus(db) {
  const rows = db
    .prepare("SELECT status, COUNT(*) as cnt, COALESCE(SUM(result_count),0) as records FROM fetch_progress GROUP BY status")
    .all();

  console.log("\n📊 采集进度");
  console.log("─".repeat(55));
  let totalDays = 0, totalRecords = 0;
  for (const r of rows) {
    const label = { done: "✅ 成功", error: "❌ 失败", empty: "⬜ 非交易日" }[r.status] || r.status;
    console.log(`  ${label.padEnd(14)} ${String(r.cnt).padStart(5)} 天   ${r.records.toLocaleString().padStart(10)} 条`);
    totalDays += r.cnt;
    totalRecords += r.records;
  }
  console.log("─".repeat(55));
  console.log(`  ${"📁 总计".padEnd(14)} ${String(totalDays).padStart(5)} 天   ${totalRecords.toLocaleString().padStart(10)} 条`);

  const range = db.prepare("SELECT MIN(date) as a, MAX(date) as b FROM fetch_progress WHERE status='done'").get();
  if (range?.a) console.log(`  📅 范围: ${range.a} → ${range.b}`);

  const last = db.prepare("SELECT MAX(fetched_at) as t FROM fetch_progress").get();
  if (last?.t) console.log(`  🕐 最后活动: ${last.t}`);

  const errors = db.prepare("SELECT date, error_msg FROM fetch_progress WHERE status='error' ORDER BY date LIMIT 5").all();
  if (errors.length) {
    console.log(`\n  ⚠️ 失败记录 (${errors.length} 条):`);
    for (const e of errors) console.log(`     ${e.date}: ${e.error_msg}`);
  }
  console.log();
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const args = new Set(process.argv.slice(2));

  const db = initDb();

  if (args.has("--status")) {
    showStatus(db);
    db.close();
    return;
  }

  if (!API_KEY) {
    console.error("❌ 请设置环境变量 MASSIVE_API_KEY");
    console.error("   export MASSIVE_API_KEY=your_key_here");
    process.exit(1);
  }

  const retryErrors = args.has("--retry-errors");

  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - HISTORY_YEARS);
  const allWeekdays = generateWeekdays(start, end);

  let pending;
  if (retryErrors) {
    pending = db.prepare("SELECT date FROM fetch_progress WHERE status='error' ORDER BY date").all().map((r) => r.date);
    console.log(`\n🔄 重试失败日期: ${pending.length} 天`);
  } else {
    const doneSet = new Set(
      db.prepare("SELECT date FROM fetch_progress WHERE status IN ('done','empty')").all().map((r) => r.date)
    );
    pending = allWeekdays.filter((d) => !doneSet.has(d));
    console.log(`\n📋 日期范围: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`);
    console.log(`   工作日: ${allWeekdays.length}, 已完成: ${doneSet.size}, 待采集: ${pending.length}`);
  }

  if (!pending.length) {
    console.log("\n✅ 所有日期已采集完成！");
    showStatus(db);
    db.close();
    return;
  }

  console.log(`\n🚀 开始采集 ${pending.length} 天`);
  console.log(`   间隔: ${RATE_LIMIT_DELAY / 1000}s, 预计: ${formatDuration(pending.length * RATE_LIMIT_DELAY)}`);
  console.log(`   数据库: ${DB_PATH}`);
  console.log(`   Ctrl+C 安全中断\n`);

  // 预编译语句
  const insertBar = db.prepare(`
    INSERT OR REPLACE INTO daily_bars
    (ticker,date,open,high,low,close,volume,vwap,num_trades,is_otc,timestamp_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertProgress = db.prepare(`
    INSERT OR REPLACE INTO fetch_progress (date,status,result_count,error_msg,fetched_at,http_status)
    VALUES (?,?,?,?,?,?)
  `);
  const batchInsert = db.transaction((rows, dateStr, count) => {
    for (const row of rows) insertBar.run(...row);
    insertProgress.run(dateStr, "done", count, null, new Date().toISOString(), 200);
  });

  const t0 = Date.now();
  let success = 0, errors = 0, empty = 0, totalStocks = 0;

  for (let i = 0; i < pending.length; i++) {
    if (shouldStop) {
      console.log(`\n⏸️ 已安全退出 (${i}/${pending.length})，下次运行自动续传`);
      break;
    }

    const d = pending[i];
    try {
      const data = await fetchGroupedDaily(d);
      const results = data?.results || [];

      if (!results.length) {
        insertProgress.run(d, "empty", 0, null, new Date().toISOString(), 200);
        empty++;
      } else {
        const rows = results.filter((r) => r.T).map((r) => [
          r.T, d, r.o ?? null, r.h ?? null, r.l ?? null, r.c ?? null,
          r.v ?? null, r.vw ?? null, r.n ?? null, r.otc ? 1 : 0, r.t ?? null,
        ]);
        batchInsert(rows, d, rows.length);
        success++;
        totalStocks += rows.length;
      }

      // 进度
      const elapsed = Date.now() - t0;
      const pct = ((i + 1) / pending.length * 100).toFixed(1);
      const eta = formatDuration(elapsed / (i + 1) * (pending.length - i - 1));
      const bar = "█".repeat(Math.floor((i + 1) / pending.length * 30)).padEnd(30, "░");
      process.stdout.write(
        `\r  [${bar}] ${pct}%  ${i + 1}/${pending.length}  ${d}  ${(results.length || 0).toString().padStart(6)} stocks  ETA ${eta}  `
      );
    } catch (err) {
      insertProgress.run(d, "error", 0, err.message, new Date().toISOString(), 0);
      errors++;
      console.log(`\n  ❌ ${d}: ${err.message}`);
      if (err.message.includes("403")) {
        console.error("\n🚫 API Key 问题，停止");
        break;
      }
    }

    if (i < pending.length - 1 && !shouldStop) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  const elapsed = formatDuration(Date.now() - t0);
  console.log(`\n\n${"─".repeat(55)}`);
  console.log(`  🏁 完成! ✅${success} ❌${errors} ⬜${empty}  共 ${totalStocks.toLocaleString()} 条  耗时 ${elapsed}`);
  console.log("─".repeat(55));

  showStatus(db);
  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

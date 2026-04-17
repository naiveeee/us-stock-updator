/**
 * 采集引擎 — 核心逻辑
 *
 * - 生成交易日列表
 * - 断点续传（跳过已完成日期）
 * - 频率控制（13s 间隔）
 * - 支持停止/状态查询
 */
import { getDb } from "./db";
import { fetchGroupedDaily } from "./massive";

const RATE_LIMIT_DELAY = 13_000; // 13s between requests
const HISTORY_YEARS = 2;

// 采集状态（进程内单例）
interface FetcherState {
  running: boolean;
  shouldStop: boolean;
  currentDate: string;
  progress: {
    total: number;
    completed: number;
    success: number;
    errors: number;
    empty: number;
    totalStocks: number;
  };
  startedAt: string | null;
  lastActivity: string | null;
}

const state: FetcherState = {
  running: false,
  shouldStop: false,
  currentDate: "",
  progress: {
    total: 0,
    completed: 0,
    success: 0,
    errors: 0,
    empty: 0,
    totalStocks: 0,
  },
  startedAt: null,
  lastActivity: null,
};

export function getFetcherState(): FetcherState {
  return { ...state, progress: { ...state.progress } };
}

export function stopFetcher(): boolean {
  if (!state.running) return false;
  state.shouldStop = true;
  return true;
}

/**
 * 生成工作日列表（周一至周五）
 */
function generateWeekdays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    const dow = current.getDay();
    if (dow >= 1 && dow <= 5) {
      days.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }
  return days;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动采集（会在后台持续运行）
 */
export async function startFetcher(apiKey: string, retryErrors = false): Promise<string> {
  if (state.running) {
    return "already_running";
  }

  const db = getDb();

  // 生成日期范围
  const end = new Date();
  end.setDate(end.getDate() - 1); // 昨天
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - HISTORY_YEARS);

  const allWeekdays = generateWeekdays(start, end);

  let pendingDates: string[];

  if (retryErrors) {
    // 仅重试失败的
    const errorRows = db
      .prepare("SELECT date FROM fetch_progress WHERE status = 'error' ORDER BY date")
      .all() as { date: string }[];
    pendingDates = errorRows.map((r) => r.date);
  } else {
    // 断点续传：跳过 done + empty
    const doneRows = db
      .prepare("SELECT date FROM fetch_progress WHERE status IN ('done', 'empty')")
      .all() as { date: string }[];
    const skipSet = new Set(doneRows.map((r) => r.date));
    pendingDates = allWeekdays.filter((d) => !skipSet.has(d));
  }

  if (pendingDates.length === 0) {
    return "all_done";
  }

  // 重置状态
  state.running = true;
  state.shouldStop = false;
  state.currentDate = "";
  state.startedAt = new Date().toISOString();
  state.lastActivity = null;
  state.progress = {
    total: pendingDates.length,
    completed: 0,
    success: 0,
    errors: 0,
    empty: 0,
    totalStocks: 0,
  };

  // 后台执行（不 await）
  runFetchLoop(pendingDates, apiKey, db).catch((err) => {
    console.error("Fetcher crashed:", err);
    state.running = false;
  });

  return "started";
}

async function runFetchLoop(
  dates: string[],
  apiKey: string,
  db: ReturnType<typeof getDb>
) {
  const insertBar = db.prepare(`
    INSERT OR REPLACE INTO daily_bars
    (ticker, date, open, high, low, close, volume, vwap, num_trades, is_otc, timestamp_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertProgress = db.prepare(`
    INSERT OR REPLACE INTO fetch_progress
    (date, status, result_count, error_msg, fetched_at, http_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(
    (rows: any[], dateStr: string, count: number) => {
      for (const row of rows) {
        insertBar.run(...row);
      }
      insertProgress.run(dateStr, "done", count, null, new Date().toISOString(), 200);
    }
  );

  console.log(`🚀 开始采集 ${dates.length} 个交易日...`);

  for (let i = 0; i < dates.length; i++) {
    if (state.shouldStop) {
      console.log(`⏸️ 采集已停止，完成 ${i}/${dates.length}`);
      break;
    }

    const dateStr = dates[i];
    state.currentDate = dateStr;

    try {
      const data = await fetchGroupedDaily(dateStr, apiKey);
      const results = data.results || [];

      if (results.length === 0) {
        // 非交易日
        insertProgress.run(dateStr, "empty", 0, null, new Date().toISOString(), 200);
        state.progress.empty++;
      } else {
        // 构建行数据
        const rows = results
          .filter((r) => r.T)
          .map((r) => [
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
            r.t ?? null,
          ]);

        // 批量事务写入
        insertMany(rows, dateStr, rows.length);
        state.progress.success++;
        state.progress.totalStocks += rows.length;

        console.log(
          `  [${i + 1}/${dates.length}] ${dateStr}: ${rows.length} stocks`
        );
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`  ❌ ${dateStr}: ${msg}`);
      insertProgress.run(dateStr, "error", 0, msg, new Date().toISOString(), 0);
      state.progress.errors++;

      // 403 直接停
      if (msg.includes("403")) {
        console.error("🚫 API Key 无效，停止采集");
        break;
      }
    }

    state.progress.completed = i + 1;
    state.lastActivity = new Date().toISOString();

    // 频率控制（最后一个不等）
    if (i < dates.length - 1 && !state.shouldStop) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  state.running = false;
  state.shouldStop = false;
  console.log(
    `🏁 采集完成: ${state.progress.success} 成功, ${state.progress.errors} 失败, ${state.progress.empty} 非交易日`
  );
}

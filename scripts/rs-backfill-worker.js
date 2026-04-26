/**
 * RS Backfill Worker — 独立进程
 *
 * 通过 child_process.fork() 从主进程启动，
 * 通过 IPC (process.send / process.on('message')) 与主进程通信。
 *
 * 启动参数通过 IPC 消息传入:
 *   { type: 'start', dbPath: string, startDate?: string, endDate?: string }
 *
 * 输出消息:
 *   { type: 'progress', date, index, total, count }
 *   { type: 'done', processed, durationMs }
 *   { type: 'error', message }
 */

const Database = require("better-sqlite3");
const path = require("path");

// ---- RS 计算逻辑（从 rs-rating.ts 移植，纯 JS 版本） ----

function getQuarterBounds(asOfDate) {
  const d = new Date(asOfDate + "T00:00:00Z");
  const quarters = [];
  for (let i = 0; i < 4; i++) {
    const endDate = new Date(d);
    endDate.setUTCMonth(endDate.getUTCMonth() - i * 3);
    const startDate = new Date(d);
    startDate.setUTCMonth(startDate.getUTCMonth() - (i + 1) * 3);
    quarters.push({
      start: startDate.toISOString().slice(0, 10),
      end: endDate.toISOString().slice(0, 10),
    });
  }
  return quarters;
}

function findClosestClose(bars, targetDate, direction) {
  if (direction === "before") {
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].date <= targetDate) return bars[i].close;
    }
  } else {
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].date >= targetDate) return bars[i].close;
    }
  }
  return null;
}

function computeRSForDate(db, asOfDate) {
  const quarters = getQuarterBounds(asOfDate);
  const oldestDate = quarters[3].start;

  const rows = db
    .prepare(
      `SELECT ticker, date, close
       FROM daily_bars
       WHERE date >= ? AND date <= ? AND close IS NOT NULL AND close > 0
       ORDER BY ticker, date`
    )
    .all(oldestDate, asOfDate);

  if (rows.length === 0) return [];

  const tickerData = new Map();
  for (const row of rows) {
    let arr = tickerData.get(row.ticker);
    if (!arr) {
      arr = [];
      tickerData.set(row.ticker, arr);
    }
    arr.push({ date: row.date, close: row.close });
  }

  const scores = [];
  for (const [ticker, bars] of tickerData) {
    if (bars.length < 20) continue;
    const qReturns = [];
    let valid = true;
    for (const q of quarters) {
      const startPrice = findClosestClose(bars, q.start, "after");
      const endPrice = findClosestClose(bars, q.end, "before");
      if (startPrice === null || endPrice === null || startPrice <= 0) {
        valid = false;
        break;
      }
      qReturns.push(((endPrice - startPrice) / startPrice) * 100);
    }
    if (!valid || qReturns.length < 4) continue;
    const score =
      qReturns[0] * 0.4 +
      qReturns[1] * 0.2 +
      qReturns[2] * 0.2 +
      qReturns[3] * 0.2;
    scores.push({ ticker, score });
  }

  if (scores.length === 0) return [];

  scores.sort((a, b) => a.score - b.score);
  const n = scores.length;

  return scores.map((item, index) => {
    const percentile = Math.round((index / (n - 1)) * 10000) / 100;
    const rating = Math.max(
      1,
      Math.min(99, Math.round((index / (n - 1)) * 98) + 1)
    );
    return {
      ticker: item.ticker,
      score: Math.round(item.score * 100) / 100,
      rating,
      percentile,
    };
  });
}

function computeAndSaveRS(db, asOfDate) {
  const results = computeRSForDate(db, asOfDate);
  if (results.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO rs_ratings (ticker, date, score, rating, percentile)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const r of results) {
      insert.run(r.ticker, asOfDate, r.score, r.rating, r.percentile);
    }
  });

  insertAll();
  return results.length;
}

// ---- 主流程 ----

process.on("message", (msg) => {
  if (msg.type !== "start") return;

  const { dbPath, startDate, endDate } = msg;
  const startTime = Date.now();

  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -64000");

    // 确定日期范围
    const minDate =
      startDate ||
      (() => {
        const row = db
          .prepare("SELECT MIN(date) as d FROM daily_bars")
          .get();
        if (!row?.d) return null;
        const d = new Date(row.d + "T00:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + 12);
        return d.toISOString().slice(0, 10);
      })();

    if (!minDate) {
      process.send({ type: "done", processed: 0, durationMs: 0 });
      process.exit(0);
      return;
    }

    const maxDate =
      endDate ||
      (() => {
        const row = db
          .prepare("SELECT MAX(date) as d FROM daily_bars")
          .get();
        return row?.d || null;
      })();

    if (!maxDate) {
      process.send({ type: "done", processed: 0, durationMs: 0 });
      process.exit(0);
      return;
    }

    const tradingDays = db
      .prepare(
        `SELECT DISTINCT date FROM daily_bars
         WHERE date >= ? AND date <= ?
         ORDER BY date`
      )
      .all(minDate, maxDate);

    const existingDates = new Set(
      db
        .prepare(
          `SELECT DISTINCT date FROM rs_ratings
           WHERE date >= ? AND date <= ?`
        )
        .all(minDate, maxDate)
        .map((r) => r.date)
    );

    const pendingDays = tradingDays.filter((d) => !existingDates.has(d.date));

    let processed = 0;
    for (let i = 0; i < pendingDays.length; i++) {
      const dateStr = pendingDays[i].date;
      const count = computeAndSaveRS(db, dateStr);
      processed++;

      // 每天都报告进度
      if (process.send) {
        process.send({
          type: "progress",
          date: dateStr,
          index: i + 1,
          total: pendingDays.length,
          count,
        });
      }
    }

    db.close();
    const durationMs = Date.now() - startTime;
    if (process.send) {
      process.send({ type: "done", processed, durationMs });
    }
    process.exit(0);
  } catch (err) {
    if (process.send) {
      process.send({ type: "error", message: err.message || String(err) });
    }
    process.exit(1);
  }
});

// 告诉主进程 worker 已准备好
if (process.send) {
  process.send({ type: "ready" });
}

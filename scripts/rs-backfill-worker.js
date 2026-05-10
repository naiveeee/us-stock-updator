/**
 * RS Backfill Worker — 独立进程（月度池子版）
 *
 * 通过 child_process.fork() 从主进程启动，
 * 通过 IPC (process.send / process.on('message')) 与主进程通信。
 *
 * 关键改动：
 * 1. 每月初取上月平均成交额 Top 1000（排除 ETF/ETN）作为计算池
 * 2. 池子存入 rs_pool 表，当月每天只对池中 ticker 计算
 * 3. 新增 dollar_volume_rank 字段
 */

const Database = require("better-sqlite3");
const { writeFileSync } = require("fs");
const { resolve } = require("path");

const RS_POOL_SIZE = 1000;
const EXCLUDED_TYPES = ["ETF", "ETN", "ETV", "ETS"];

/**
 * 将已完成的日期列表写入 JSON 文件（dates API 直接读取此文件）
 */
function refreshRsDatesFile(db, dbPath) {
  try {
    const rows = db
      .prepare("SELECT date FROM fetch_progress WHERE status = 'done' ORDER BY date ASC")
      .all();
    const dates = rows.map((r) => r.date);
    const filePath = resolve(dbPath, "..", "rs-dates.json");
    writeFileSync(filePath, JSON.stringify({ dates, updatedAt: new Date().toISOString() }));
  } catch (e) {
    // 非关键操作，失败不影响回填
  }
}

// ---- 月度池子逻辑 ----

function getPrevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

function getMonth(date) {
  return date.slice(0, 7);
}

function buildMonthlyPool(db, month) {
  const prevMonth = getPrevMonth(month);
  const prevMonthStart = `${prevMonth}-01`;
  const currentMonthStart = `${month}-01`;

  db.prepare("DELETE FROM rs_pool WHERE month = ?").run(month);

  const excludePlaceholders = EXCLUDED_TYPES.map(() => "?").join(",");

  const sql = `
    INSERT INTO rs_pool (month, ticker, avg_dollar_volume)
    SELECT ?, ticker, AVG(close * volume) as avg_dv
    FROM daily_bars
    WHERE date >= ? AND date < ?
      AND close > 0 AND volume > 0
      AND ticker NOT IN (
        SELECT ticker FROM ticker_info
        WHERE ticker_type IN (${excludePlaceholders})
      )
    GROUP BY ticker
    HAVING COUNT(*) >= 15
    ORDER BY avg_dv DESC
    LIMIT ?
  `;

  const result = db.prepare(sql).run(
    month,
    prevMonthStart,
    currentMonthStart,
    ...EXCLUDED_TYPES,
    RS_POOL_SIZE
  );

  return result.changes;
}

// ---- RS 计算逻辑 ----

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
  return quarters; // [0]=Q4(最近), [3]=Q1(最远)
}

/**
 * 计算单日 RS Rating — 月度池子版
 */
function computeRSForDate(db, asOfDate, month) {
  const quarters = getQuarterBounds(asOfDate);

  // 从月度池取 ticker 列表
  const poolTickers = db
    .prepare("SELECT ticker FROM rs_pool WHERE month = ?")
    .all(month);

  if (poolTickers.length === 0) return [];

  const tickerSet = new Set(poolTickers.map(t => t.ticker));

  // 查当天所有 ticker 的成交额排名
  const dayBars = db
    .prepare(
      `SELECT ticker, (close * volume) as dollar_vol
       FROM daily_bars
       WHERE date = ? AND close > 0 AND volume > 0
       ORDER BY dollar_vol DESC`
    )
    .all(asOfDate);

  const dollarVolumeRankMap = new Map();
  let rank = 0;
  for (const bar of dayBars) {
    rank++;
    if (tickerSet.has(bar.ticker)) {
      dollarVolumeRankMap.set(bar.ticker, rank);
    }
  }

  // 准备查询语句
  const stmtAfter = db.prepare(
    `SELECT close FROM daily_bars
     WHERE ticker = ? AND date >= ? AND date <= ? AND close IS NOT NULL AND close > 0
     ORDER BY date ASC LIMIT 1`
  );
  const stmtBefore = db.prepare(
    `SELECT close FROM daily_bars
     WHERE ticker = ? AND date >= ? AND date <= ? AND close IS NOT NULL AND close > 0
     ORDER BY date DESC LIMIT 1`
  );

  const GAP_THRESHOLD_DAYS = 90;
  const stmtMaxGap = db.prepare(
    `SELECT gap, gap_after FROM (
       SELECT julianday(LEAD(date) OVER (ORDER BY date)) - julianday(date) AS gap,
              LEAD(date) OVER (ORDER BY date) AS gap_after
       FROM daily_bars
       WHERE ticker = ? AND date >= ? AND date <= ?
     )
     WHERE gap > ?
     ORDER BY gap DESC
     LIMIT 1`
  );

  const oldestQuarterStart = quarters[3].start;

  const scores = [];

  for (const { ticker } of poolTickers) {
    // 当天没有交易数据的 ticker 跳过
    if (!dollarVolumeRankMap.has(ticker)) continue;

    const gapRow = stmtMaxGap.get(ticker, oldestQuarterStart, asOfDate, GAP_THRESHOLD_DAYS);

    let validFrom = null;
    if (gapRow && gapRow.gap > 0 && gapRow.gap_after) {
      validFrom = gapRow.gap_after;
    }

    const qReturns = [];
    let valid = true;

    for (const q of quarters) {
      if (validFrom && q.start < validFrom) {
        valid = false;
        break;
      }

      const startRow = stmtAfter.get(ticker, q.start, q.end);
      const endRow = stmtBefore.get(ticker, q.start, q.end);

      if (!startRow || !endRow || startRow.close <= 0) {
        valid = false;
        break;
      }

      qReturns.push(
        ((endRow.close - startRow.close) / startRow.close) * 100
      );
    }

    if (!valid || qReturns.length < 4) continue;

    const score =
      qReturns[0] * 0.4 +
      qReturns[1] * 0.2 +
      qReturns[2] * 0.2 +
      qReturns[3] * 0.2;

    scores.push({ ticker, score, dollar_volume_rank: dollarVolumeRankMap.get(ticker) || 0 });
  }

  if (scores.length === 0) return [];

  scores.sort((a, b) => a.score - b.score);
  const n = scores.length;

  return scores.map((item, index) => {
    const percentile =
      n > 1 ? Math.round((index / (n - 1)) * 10000) / 100 : 50;
    const rating =
      n > 1
        ? Math.max(1, Math.min(99, Math.round((index / (n - 1)) * 98) + 1))
        : 50;
    return {
      ticker: item.ticker,
      score: Math.round(item.score * 100) / 100,
      rating,
      percentile,
      dollar_volume_rank: item.dollar_volume_rank,
    };
  });
}

function computeAndSaveRS(db, asOfDate, month) {
  const results = computeRSForDate(db, asOfDate, month);
  if (results.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO rs_ratings (ticker, date, score, rating, percentile, dollar_volume_rank)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const r of results) {
      insert.run(r.ticker, asOfDate, r.score, r.rating, r.percentile, r.dollar_volume_rank);
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
    db.pragma("cache_size = -32000"); // 32MB cache

    // 确保索引和表存在
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_daily_bars_date_volume
        ON daily_bars(date, volume DESC);

      CREATE TABLE IF NOT EXISTS rs_pool (
        month             TEXT NOT NULL,
        ticker            TEXT NOT NULL,
        avg_dollar_volume REAL,
        PRIMARY KEY (month, ticker)
      );
    `);

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

    // 全量回填：清空旧数据
    db.prepare("DELETE FROM rs_ratings").run();
    db.prepare("DELETE FROM rs_pool").run();

    if (process.send) {
      process.send({
        type: "progress",
        date: "",
        index: 0,
        total: tradingDays.length,
        count: 0,
      });
    }

    const CHECKPOINT_EVERY = 5;
    const REFRESH_DATES_EVERY = 50;

    let processed = 0;
    let currentMonth = "";

    for (let i = 0; i < tradingDays.length; i++) {
      const dateStr = tradingDays[i].date;
      const month = getMonth(dateStr);

      // 月份变化时构建新池子
      if (month !== currentMonth) {
        currentMonth = month;
        buildMonthlyPool(db, month);
      }

      const count = computeAndSaveRS(db, dateStr, month);
      processed++;

      if (process.send) {
        process.send({
          type: "progress",
          date: dateStr,
          index: i + 1,
          total: tradingDays.length,
          count,
        });
      }

      if (processed % CHECKPOINT_EVERY === 0) {
        try {
          db.pragma("wal_checkpoint(TRUNCATE)");
        } catch (e) {
          // checkpoint 失败不阻塞流程
        }
      }

      if (processed % REFRESH_DATES_EVERY === 0) {
        refreshRsDatesFile(db, dbPath);
      }
    }

    // 完成后最终刷新一次
    refreshRsDatesFile(db, dbPath);

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

if (process.send) {
  process.send({ type: "ready" });
}

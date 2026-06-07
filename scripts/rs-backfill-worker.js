/**
 * RS Backfill Worker — EMA + R² 版
 *
 * 算法:
 *   1. 月度池子: 上月日均成交额 Top 2000 (排除 ETF/ETN)
 *   2. 得分 = 原始涨幅(63天) × R² 系数
 *     - 涨幅: (close_today - close_63天前) / close_63天前 × 100
 *     - R² 系数: 0.5 + 0.5 × R²(63天收盘价线性回归)
 *   3. 池内排名 → 1-99 rating + percentile
 */

const Database = require("better-sqlite3");
const { writeFileSync } = require("fs");
const { resolve } = require("path");

const RS_POOL_SIZE = 2000;
const EXCLUDED_TYPES = ["ETF", "ETN", "ETV", "ETS"];
const PCT_WINDOW = 63; // 一个季度
const R2_WINDOW = 63;

// ---- 工具函数 ----

function refreshRsDatesFile(db, dbPath) {
  try {
    const rows = db
      .prepare("SELECT date FROM fetch_progress WHERE status = 'done' ORDER BY date ASC")
      .all();
    const dates = rows.map((r) => r.date);
    const filePath = resolve(dbPath, "..", "rs-dates.json");
    writeFileSync(filePath, JSON.stringify({ dates, updatedAt: new Date().toISOString() }));
  } catch (e) {
    // 非关键操作
  }
}

function getPrevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

function getMonth(date) {
  return date.slice(0, 7);
}

// ---- R² 线性回归 ----

/**
 * 计算 R²（决定系数）
 * 对 prices 做 y = a + b*x 的线性回归，返回 R²
 * @param {number[]} prices - 价格数组 (按时间正序)
 * @returns {number} R² 值 [0, 1]
 */
function calcR2(prices) {
  const n = prices.length;
  if (n < 5) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += prices[i];
    sumXY += i * prices[i];
    sumX2 += i * i;
  }

  const meanY = sumY / n;
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;

  const b = (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;

  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = a + b * i;
    ssRes += (prices[i] - predicted) ** 2;
    ssTot += (prices[i] - meanY) ** 2;
  }

  if (ssTot === 0) return 0;
  const r2 = 1 - ssRes / ssTot;
  return Math.max(0, Math.min(1, r2));
}

// ---- 月度池子 ----

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

// ---- RS 核心计算 ----

function computeRSForDate(db, asOfDate, month) {
  const poolTickers = db
    .prepare("SELECT ticker FROM rs_pool WHERE month = ?")
    .all(month);

  if (poolTickers.length === 0) return [];

  const tickerSet = new Set(poolTickers.map((t) => t.ticker));

  // 当天成交额排名
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

  // 回溯日期：多取一些确保能取到 63 天前的收盘价
  const lookbackDate = new Date(asOfDate + "T00:00:00Z");
  lookbackDate.setUTCDate(lookbackDate.getUTCDate() - Math.ceil(PCT_WINDOW * 1.5));
  const lookbackStr = lookbackDate.toISOString().slice(0, 10);

  // 取价格序列
  const stmtPrices = db.prepare(
    `SELECT date, close FROM daily_bars
     WHERE ticker = ? AND date >= ? AND date <= ?
       AND close IS NOT NULL AND close > 0
     ORDER BY date ASC`
  );

  // ticker 复用检测
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

  const scores = [];

  for (const { ticker } of poolTickers) {
    if (!dollarVolumeRankMap.has(ticker)) continue;

    const rows = stmtPrices.all(ticker, lookbackStr, asOfDate);
    if (rows.length < 10) continue;

    // 检查数据断裂
    const gapRow = stmtMaxGap.get(ticker, lookbackStr, asOfDate, GAP_THRESHOLD_DAYS);
    let validRows = rows;
    if (gapRow && gapRow.gap > 0 && gapRow.gap_after) {
      const gapIdx = rows.findIndex((r) => r.date >= gapRow.gap_after);
      if (gapIdx > 0) {
        validRows = rows.slice(gapIdx);
      }
    }

    if (validRows.length < 10) continue;

    const prices = validRows.map((r) => r.close);

    // 原始涨幅：首尾收盘价
    const closeToday = prices[prices.length - 1];
    const refIdx = Math.max(0, prices.length - 1 - PCT_WINDOW);
    const closeRef = prices[refIdx];

    if (!closeRef || closeRef <= 0 || !closeToday || closeToday <= 0) continue;

    const pct = ((closeToday - closeRef) / closeRef) * 100;

    // 计算 R²：用最近 R2_WINDOW 天的收盘价
    const r2Prices = prices.slice(-R2_WINDOW);
    const r2 = calcR2(r2Prices);

    // R² 系数: 0.5 + 0.5 * R²
    const r2Factor = 0.5 + 0.5 * r2;

    // 最终得分
    const score = pct * r2Factor;

    scores.push({
      ticker,
      score: Math.round(score * 100) / 100,
      pct_3m: Math.round(pct * 100) / 100,
      r2: Math.round(r2 * 10000) / 10000,
      dollar_volume_rank: dollarVolumeRankMap.get(ticker) || 0,
    });
  }

  if (scores.length === 0) return [];

  // 排名
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
      ...item,
      rating,
      percentile,
    };
  });
}

function computeAndSaveRS(db, asOfDate, month) {
  const results = computeRSForDate(db, asOfDate, month);
  if (results.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO rs_ratings (ticker, date, score, rating, percentile, dollar_volume_rank, pct_3m, pct_6m, pct_9m, pct_12m, r2)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const r of results) {
      insert.run(
        r.ticker, asOfDate, r.score, r.rating, r.percentile,
        r.dollar_volume_rank, r.pct_3m,
        0, 0, 0, // pct_6m, pct_9m, pct_12m 置 0（向后兼容）
        r.r2
      );
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
    db.pragma("cache_size = -32000");

    // 确保表和索引存在
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

    // 新增 r2 字段（如果不存在）
    try {
      db.exec("ALTER TABLE rs_ratings ADD COLUMN r2 REAL DEFAULT 0");
    } catch (e) {
      // 字段已存在，忽略
    }

    // 确定日期范围
    const minDate =
      startDate ||
      (() => {
        const row = db.prepare("SELECT MIN(date) as d FROM daily_bars").get();
        if (!row?.d) return null;
        const d = new Date(row.d + "T00:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + 3);
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
        const row = db.prepare("SELECT MAX(date) as d FROM daily_bars").get();
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
        } catch (e) {}
      }

      if (processed % REFRESH_DATES_EVERY === 0) {
        refreshRsDatesFile(db, dbPath);
      }
    }

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

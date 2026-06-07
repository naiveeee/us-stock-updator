/**
 * IBD RS Rating 计算引擎（原始涨幅 + R² 版）
 *
 * 算法：
 *   1. 月度池子：上月日均成交额 Top 2000（排除 ETF/ETN）
 *   2. 得分 = 原始涨幅(63天) × R² 系数
 *     - 涨幅: (close_today - close_63天前) / close_63天前 × 100
 *     - R² 系数: 0.5 + 0.5 × R²(63天收盘价线性回归)
 *   3. 池内排名 → 1-99 rating + percentile
 */
import type Database from "better-sqlite3";

export interface RSResult {
  ticker: string;
  score: number;      // 最终得分（涨幅 × R²系数）
  rating: number;     // 1-99
  percentile: number; // 0.00-100.00
  dollar_volume_rank: number;
  pct_3m: number;     // 原始涨幅(%)
  pct_6m: number;     // 保留字段，置 0
  pct_9m: number;     // 保留字段，置 0
  pct_12m: number;    // 保留字段，置 0
  r2: number;         // R² 值 [0, 1]
}

/** 月度池子大小 */
const RS_POOL_SIZE = 2000;

/** ETF/ETN 类型列表 */
const EXCLUDED_TYPES = ["ETF", "ETN", "ETV", "ETS"];

/** 涨幅和 R² 窗口 */
const PCT_WINDOW = 63;
const R2_WINDOW = 63;

// ---- R² 线性回归 ----

function calcR2(prices: number[]): number {
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

// ---- 月度池子工具函数 ----

function getPrevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

function getMonth(date: string): string {
  return date.slice(0, 7);
}

/**
 * 为指定月份构建 RS 计算池
 */
export function buildMonthlyPool(
  db: Database.Database,
  month: string
): number {
  const prevMonth = getPrevMonth(month);
  const prevMonthStart = `${prevMonth}-01`;
  const currentMonthStart = `${month}-01`;

  db.prepare("DELETE FROM rs_pool WHERE month = ?").run(month);

  const excludePlaceholders = EXCLUDED_TYPES.map(() => "?").join(",");

  const sql = `
    INSERT INTO rs_pool (month, ticker, avg_dollar_volume)
    SELECT ?, ticker, AVG(COALESCE(vwap, close) * volume) as avg_dv
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

/**
 * 确保月度池子存在（如果没有就构建）
 */
function ensureMonthlyPool(db: Database.Database, month: string): void {
  const count = db
    .prepare("SELECT COUNT(*) as cnt FROM rs_pool WHERE month = ?")
    .get(month) as { cnt: number };

  if (!count || count.cnt === 0) {
    buildMonthlyPool(db, month);
  }
}

/**
 * 计算单日 RS（原始涨幅 + R² 版）
 */
export function computeRSForDate(
  db: Database.Database,
  asOfDate: string
): RSResult[] {
  const month = getMonth(asOfDate);

  ensureMonthlyPool(db, month);

  const poolTickers = db
    .prepare("SELECT ticker FROM rs_pool WHERE month = ?")
    .all(month) as { ticker: string }[];

  if (poolTickers.length === 0) return [];

  const tickerSet = new Set(poolTickers.map(t => t.ticker));

  // 当天成交额排名
  const dayBars = db
    .prepare(
      `SELECT ticker, (COALESCE(vwap, close) * volume) as dollar_vol
       FROM daily_bars
       WHERE date = ? AND close > 0 AND volume > 0
       ORDER BY dollar_vol DESC`
    )
    .all(asOfDate) as { ticker: string; dollar_vol: number }[];

  const dollarVolumeRankMap = new Map<string, number>();
  let rank = 0;
  for (const bar of dayBars) {
    rank++;
    if (tickerSet.has(bar.ticker)) {
      dollarVolumeRankMap.set(bar.ticker, rank);
    }
  }

  // 回溯日期
  const lookbackDate = new Date(asOfDate + "T00:00:00Z");
  lookbackDate.setUTCDate(lookbackDate.getUTCDate() - Math.ceil(PCT_WINDOW * 1.5));
  const lookbackStr = lookbackDate.toISOString().slice(0, 10);

  const stmtPrices = db.prepare(
    `SELECT date, close FROM daily_bars
     WHERE ticker = ? AND date >= ? AND date <= ?
       AND close IS NOT NULL AND close > 0
     ORDER BY date ASC`
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

  const scores: { ticker: string; score: number; pct_3m: number; r2: number; dollar_volume_rank: number }[] = [];

  for (const { ticker } of poolTickers) {
    if (!dollarVolumeRankMap.has(ticker)) continue;

    const rows = stmtPrices.all(ticker, lookbackStr, asOfDate) as { date: string; close: number }[];
    if (rows.length < 10) continue;

    // 数据断裂检测
    const gapRow = stmtMaxGap.get(ticker, lookbackStr, asOfDate, GAP_THRESHOLD_DAYS) as { gap: number; gap_after: string } | undefined;
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

    // R²
    const r2Prices = prices.slice(-R2_WINDOW);
    const r2 = calcR2(r2Prices);
    const r2Factor = 0.5 + 0.5 * r2;

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

  scores.sort((a, b) => a.score - b.score);
  const n = scores.length;

  return scores.map((item, index) => {
    const percentile = n > 1 ? Math.round((index / (n - 1)) * 10000) / 100 : 50;
    const rating = n > 1
      ? Math.max(1, Math.min(99, Math.round((index / (n - 1)) * 98) + 1))
      : 50;

    return {
      ticker: item.ticker,
      score: item.score,
      rating,
      percentile,
      dollar_volume_rank: item.dollar_volume_rank,
      pct_3m: item.pct_3m,
      pct_6m: 0,
      pct_9m: 0,
      pct_12m: 0,
      r2: item.r2,
    };
  });
}

/**
 * 计算并写入单日 RS Rating 到数据库
 */
export function computeAndSaveRS(
  db: Database.Database,
  asOfDate: string
): number {
  const results = computeRSForDate(db, asOfDate);
  if (results.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO rs_ratings (ticker, date, score, rating, percentile, dollar_volume_rank, pct_3m, pct_6m, pct_9m, pct_12m, r2)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const r of results) {
      insert.run(r.ticker, asOfDate, r.score, r.rating, r.percentile, r.dollar_volume_rank, r.pct_3m, r.pct_6m, r.pct_9m, r.pct_12m, r.r2);
    }
  });

  insertAll();
  return results.length;
}

/**
 * 批量回填历史 RS Rating（原始涨幅 + R² 版）
 */
export async function backfillRS(
  db: Database.Database,
  startDate?: string,
  endDate?: string,
  onProgress?: (date: string, index: number, total: number, count: number) => void
): Promise<number> {
  const minDate = startDate || (() => {
    const row = db
      .prepare("SELECT MIN(date) as d FROM daily_bars")
      .get() as { d: string } | undefined;
    if (!row?.d) return null;
    const d = new Date(row.d + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 3);
    return d.toISOString().slice(0, 10);
  })();

  if (!minDate) return 0;

  const maxDate = endDate || (() => {
    const row = db
      .prepare("SELECT MAX(date) as d FROM daily_bars")
      .get() as { d: string } | undefined;
    return row?.d || null;
  })();

  if (!maxDate) return 0;

  const tradingDays = db
    .prepare(
      `SELECT DISTINCT date FROM daily_bars
       WHERE date >= ? AND date <= ?
       ORDER BY date`
    )
    .all(minDate, maxDate) as { date: string }[];

  db.prepare("DELETE FROM rs_ratings").run();
  db.prepare("DELETE FROM rs_pool").run();

  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  let processed = 0;
  let currentMonth = "";

  for (let i = 0; i < tradingDays.length; i++) {
    const dateStr = tradingDays[i].date;
    const month = getMonth(dateStr);

    if (month !== currentMonth) {
      currentMonth = month;
      buildMonthlyPool(db, month);
    }

    const count = computeAndSaveRS(db, dateStr);
    processed++;
    onProgress?.(dateStr, i + 1, tradingDays.length, count);

    await yieldLoop();
  }

  return processed;
}

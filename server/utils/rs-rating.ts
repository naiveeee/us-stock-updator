/**
 * IBD RS Rating 计算引擎（月度池子版）
 *
 * 算法：
 *   1. 每月第一个交易日，取上月平均成交额 (close × volume) Top 1000 的非 ETF/ETN 股票
 *      写入 rs_pool 表作为该月的计算池
 *   2. 当月每天只对池中的 ticker 计算 RS：
 *      - 取过去 12 个月分 4 个季度的涨跌幅
 *      - 加权得分 = 0.2*Q1 + 0.2*Q2 + 0.2*Q3 + 0.4*Q4（近期权重更高）
 *   3. 在池内排名，映射到 1-99 rating + 精确 percentile
 */
import type Database from "better-sqlite3";

export interface RSResult {
  ticker: string;
  score: number;      // 加权原始得分
  rating: number;     // 1-99
  percentile: number; // 0.00-100.00
  dollar_volume_rank: number; // 当日成交额排名
}

interface QuarterBounds {
  start: string; // YYYY-MM-DD
  end: string;
}

/** 月度池子大小 */
const RS_POOL_SIZE = 1000;

/** ETF/ETN 类型列表（从 Polygon ticker type 字段过滤） */
const EXCLUDED_TYPES = ["ETF", "ETN", "ETV", "ETS"];

/**
 * 计算距 asOfDate 往前的 4 个季度边界
 * Q4 = 最近 3 个月（权重 40%）
 * Q3 = 3-6 个月
 * Q2 = 6-9 个月
 * Q1 = 9-12 个月（最远，权重 20%）
 */
function getQuarterBounds(asOfDate: string): QuarterBounds[] {
  const d = new Date(asOfDate + "T00:00:00Z");
  const quarters: QuarterBounds[] = [];

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

  // quarters[0] = Q4 (最近), quarters[3] = Q1 (最远)
  return quarters;
}

/**
 * 获取上一个月份字符串
 * '2026-05' → '2026-04'
 * '2026-01' → '2025-12'
 */
function getPrevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * 获取日期所属月份 'YYYY-MM'
 */
function getMonth(date: string): string {
  return date.slice(0, 7);
}

/**
 * 为指定月份构建 RS 计算池
 * 取上月所有交易日的平均成交额 Top 1000（排除 ETF/ETN）
 *
 * @returns 写入的 ticker 数量
 */
export function buildMonthlyPool(
  db: Database.Database,
  month: string
): number {
  const prevMonth = getPrevMonth(month);
  const prevMonthStart = `${prevMonth}-01`;
  const currentMonthStart = `${month}-01`;

  // 先删除旧数据（如果有）
  db.prepare("DELETE FROM rs_pool WHERE month = ?").run(month);

  // 构建排除 ETF/ETN 的子查询
  // 如果 ticker_info 里有该 ticker 且 type 是 ETF/ETN，则排除
  // 如果 ticker_info 里没有该 ticker 的信息，默认不排除（保守策略）
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

/**
 * 确保指定月份有 rs_pool 数据
 * 如果已存在则跳过
 */
export function ensureMonthlyPool(
  db: Database.Database,
  month: string
): number {
  const existing = db
    .prepare("SELECT COUNT(*) as cnt FROM rs_pool WHERE month = ?")
    .get(month) as { cnt: number };

  if (existing.cnt > 0) return existing.cnt;
  return buildMonthlyPool(db, month);
}

/**
 * 计算单日 RS Rating（月度池子版）
 *
 * 策略：
 *   1. 从 rs_pool 取本月的 ticker 池
 *   2. 逐 ticker 用 SQL 查各季度边界收盘价（走主键索引）
 *   3. 计算加权得分 → 排序 → 百分位排名
 */
export function computeRSForDate(
  db: Database.Database,
  asOfDate: string
): RSResult[] {
  const month = getMonth(asOfDate);
  const quarters = getQuarterBounds(asOfDate);

  // 确保本月有池子
  ensureMonthlyPool(db, month);

  // 从月度池取 ticker 列表
  const poolTickers = db
    .prepare("SELECT ticker FROM rs_pool WHERE month = ?")
    .all(month) as { ticker: string }[];

  if (poolTickers.length === 0) return [];

  // 取当天这些 ticker 的成交额排名（用于 dollar_volume_rank 字段）
  const tickerSet = new Set(poolTickers.map(t => t.ticker));

  // 查当天有交易的池内 ticker 的成交额
  const dayBars = db
    .prepare(
      `SELECT ticker, (close * volume) as dollar_vol
       FROM daily_bars
       WHERE date = ? AND close > 0 AND volume > 0
       ORDER BY dollar_vol DESC`
    )
    .all(asOfDate) as { ticker: string; dollar_vol: number }[];

  // 构建全市场成交额排名 map（所有 ticker，不限于池子）
  const dollarVolumeRankMap = new Map<string, number>();
  let rank = 0;
  for (const bar of dayBars) {
    rank++;
    if (tickerSet.has(bar.ticker)) {
      dollarVolumeRankMap.set(bar.ticker, rank);
    }
  }

  // 准备 SQL：取某 ticker 在某日期范围内最早/最晚的收盘价
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

  // Ticker 复用检测：查该 ticker 在计算窗口内是否存在 >90 天的数据断裂
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

  const scores: { ticker: string; score: number; dollar_volume_rank: number }[] = [];

  for (const { ticker } of poolTickers) {
    // 当天没有交易数据的 ticker 跳过
    if (!dollarVolumeRankMap.has(ticker)) continue;

    // 检查 12 个月窗口内是否有数据断裂（ticker 复用）
    const gapRow = stmtMaxGap.get(ticker, oldestQuarterStart, asOfDate, GAP_THRESHOLD_DAYS) as { gap: number; gap_after: string } | undefined;

    let validFrom: string | null = null;
    if (gapRow && gapRow.gap > 0 && gapRow.gap_after) {
      validFrom = gapRow.gap_after;
    }

    const qReturns: number[] = [];
    let valid = true;

    for (const q of quarters) {
      if (validFrom && q.start < validFrom) {
        valid = false;
        break;
      }

      const startRow = stmtAfter.get(ticker, q.start, q.end) as { close: number } | undefined;
      const endRow = stmtBefore.get(ticker, q.start, q.end) as { close: number } | undefined;

      if (!startRow || !endRow || startRow.close <= 0) {
        valid = false;
        break;
      }

      qReturns.push(((endRow.close - startRow.close) / startRow.close) * 100);
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
    const percentile = n > 1 ? Math.round((index / (n - 1)) * 10000) / 100 : 50;
    const rating = n > 1
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

/**
 * 计算并写入单日 RS Rating 到数据库
 * 返回写入的记录数
 */
export function computeAndSaveRS(
  db: Database.Database,
  asOfDate: string
): number {
  const results = computeRSForDate(db, asOfDate);
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

/**
 * 批量回填历史 RS Rating（月度池子版）
 *
 * 流程：
 *   1. 找到所有待计算的交易日
 *   2. 对每个月确保 rs_pool 已生成
 *   3. 逐天计算 RS
 *
 * **异步版本**：每计算一天后通过 setImmediate 让出事件循环
 *
 * @param onProgress 进度回调
 * @returns 处理的天数
 */
export async function backfillRS(
  db: Database.Database,
  startDate?: string,
  endDate?: string,
  onProgress?: (date: string, index: number, total: number, count: number) => void
): Promise<number> {
  // 确定可用的交易日列表
  const minDate = startDate || (() => {
    const row = db
      .prepare("SELECT MIN(date) as d FROM daily_bars")
      .get() as { d: string } | undefined;
    if (!row?.d) return null;
    const d = new Date(row.d + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 12);
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

  // 获取范围内的所有交易日（从 daily_bars 中去重）
  const tradingDays = db
    .prepare(
      `SELECT DISTINCT date FROM daily_bars
       WHERE date >= ? AND date <= ?
       ORDER BY date`
    )
    .all(minDate, maxDate) as { date: string }[];

  // 全量回填：清空旧数据
  db.prepare("DELETE FROM rs_ratings").run();
  db.prepare("DELETE FROM rs_pool").run();

  // 工具函数：让出事件循环
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

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

    const count = computeAndSaveRS(db, dateStr);
    processed++;
    onProgress?.(dateStr, i + 1, tradingDays.length, count);

    // 每计算一天后让出事件循环
    await yieldLoop();
  }

  return processed;
}

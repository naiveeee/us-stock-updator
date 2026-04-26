/**
 * IBD RS Rating 计算引擎
 *
 * 算法：
 *   1. 取当天成交量 Top 1000 的股票
 *   2. 对每只取过去 12 个月分 4 个季度的涨跌幅
 *   3. 加权得分 = 0.2*Q1 + 0.2*Q2 + 0.2*Q3 + 0.4*Q4（近期权重更高）
 *   4. 在 Top 1000 内排名，映射到 1-99 rating + 精确 percentile
 */
import type Database from "better-sqlite3";

export interface RSResult {
  ticker: string;
  score: number;      // 加权原始得分
  rating: number;     // 1-99
  percentile: number; // 0.00-100.00
}

interface QuarterBounds {
  start: string; // YYYY-MM-DD
  end: string;
}

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

/** 只对当日成交量 Top N 的 ticker 计算 RS，过滤垃圾股 + 大幅提速 */
const RS_TOP_N = 1000;

/**
 * 计算单日 RS Rating（成交量 Top 1000 版）
 *
 * 策略：
 *   1. 取当天成交量前 1000 的 ticker（走 idx_daily_bars_date_volume 索引）
 *   2. 逐 ticker 用 SQL 查各季度边界收盘价（走主键索引）
 *   3. 计算加权得分 → 排序 → 百分位排名
 */
export function computeRSForDate(
  db: Database.Database,
  asOfDate: string
): RSResult[] {
  const quarters = getQuarterBounds(asOfDate);

  // 取当天成交量最大的 Top N ticker
  const tickers = db
    .prepare(
      `SELECT ticker FROM daily_bars
       WHERE date = ? AND volume IS NOT NULL AND volume > 0
         AND close IS NOT NULL AND close > 0
       ORDER BY volume DESC
       LIMIT ?`
    )
    .all(asOfDate, RS_TOP_N) as { ticker: string }[];

  if (tickers.length === 0) return [];

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

  const scores: { ticker: string; score: number }[] = [];

  for (const { ticker } of tickers) {
    const qReturns: number[] = [];
    let valid = true;

    for (const q of quarters) {
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

    scores.push({ ticker, score });
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

/**
 * 批量回填历史 RS Rating
 * 从 startDate 到 endDate，逐个交易日计算
 * 
 * **异步版本**：每计算一天后通过 setImmediate 让出事件循环，
 * 避免长时间阻塞 Node.js 导致其他请求无法响应。
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
    // 找到数据库中最早日期 + 12 个月（需要 12 个月历史才能算 RS）
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

  // 跳过已计算的日期
  const existingDates = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT date FROM rs_ratings
           WHERE date >= ? AND date <= ?`
        )
        .all(minDate, maxDate) as { date: string }[]
    ).map((r) => r.date)
  );

  const pendingDays = tradingDays.filter((d) => !existingDates.has(d.date));

  // 工具函数：让出事件循环
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  let processed = 0;
  for (let i = 0; i < pendingDays.length; i++) {
    const dateStr = pendingDays[i].date;
    const count = computeAndSaveRS(db, dateStr);
    processed++;
    onProgress?.(dateStr, i + 1, pendingDays.length, count);

    // 每计算一天后让出事件循环，让 HTTP 请求有机会被处理
    await yieldLoop();
  }

  return processed;
}

/**
 * IBD RS Rating 计算引擎
 *
 * 算法：
 *   1. 对每只股票取过去 12 个月分 4 个季度的涨跌幅
 *   2. 加权得分 = 0.2*Q1 + 0.2*Q2 + 0.2*Q3 + 0.4*Q4（近期权重更高）
 *   3. 全市场排名，映射到 1-99 rating + 精确 percentile
 *
 * 全量计算（不预先过滤），展示层再按成交量筛选
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

/**
 * 计算单日全市场 RS Rating
 *
 * 策略：一次性加载所需日期范围的所有 daily_bars 到内存，
 * 按 ticker 分组计算，避免逐只股票查询。
 */
export function computeRSForDate(
  db: Database.Database,
  asOfDate: string
): RSResult[] {
  const quarters = getQuarterBounds(asOfDate);
  const oldestDate = quarters[3].start; // Q1 start = 12 个月前

  // 1. 一次性拉出所需日期范围的收盘价
  //    对每只 ticker，取每个季度边界附近最近的收盘价
  //    这里用一个更高效的方法：取所有日期的数据，在内存中计算
  const rows = db
    .prepare(
      `SELECT ticker, date, close
       FROM daily_bars
       WHERE date >= ? AND date <= ? AND close IS NOT NULL AND close > 0
       ORDER BY ticker, date`
    )
    .all(oldestDate, asOfDate) as { ticker: string; date: string; close: number }[];

  if (rows.length === 0) return [];

  // 2. 按 ticker 分组
  const tickerData = new Map<string, { date: string; close: number }[]>();
  for (const row of rows) {
    let arr = tickerData.get(row.ticker);
    if (!arr) {
      arr = [];
      tickerData.set(row.ticker, arr);
    }
    arr.push({ date: row.date, close: row.close });
  }

  // 3. 对每只 ticker 计算加权得分
  const scores: { ticker: string; score: number }[] = [];

  for (const [ticker, bars] of tickerData) {
    // 需要至少横跨一定时间才有意义
    if (bars.length < 20) continue;

    // 找每个季度边界处最近的收盘价
    const qReturns: number[] = []; // [Q4, Q3, Q2, Q1]
    let valid = true;

    for (const q of quarters) {
      const startPrice = findClosestClose(bars, q.start, "after");
      const endPrice = findClosestClose(bars, q.end, "before");

      if (startPrice === null || endPrice === null || startPrice <= 0) {
        valid = false;
        break;
      }

      qReturns.push((endPrice - startPrice) / startPrice * 100);
    }

    if (!valid || qReturns.length < 4) continue;

    // Q4(最近)*0.4 + Q3*0.2 + Q2*0.2 + Q1(最远)*0.2
    const score =
      qReturns[0] * 0.4 + // Q4
      qReturns[1] * 0.2 + // Q3
      qReturns[2] * 0.2 + // Q2
      qReturns[3] * 0.2;  // Q1

    scores.push({ ticker, score });
  }

  if (scores.length === 0) return [];

  // 4. 排序 + 百分位排名
  scores.sort((a, b) => a.score - b.score); // 升序，最差在前
  const n = scores.length;

  return scores.map((item, index) => {
    // percentile: 该股票超过了多少比例的股票
    const percentile = Math.round((index / (n - 1)) * 10000) / 100; // 0.00-100.00
    // rating: 映射到 1-99
    const rating = Math.max(1, Math.min(99, Math.round((index / (n - 1)) * 98) + 1));

    return {
      ticker: item.ticker,
      score: Math.round(item.score * 100) / 100,
      rating,
      percentile,
    };
  });
}

/**
 * 在有序的 bars 中找最接近 targetDate 的收盘价
 * direction: "before" = 取 <= targetDate 的最近一条
 *            "after"  = 取 >= targetDate 的最近一条
 */
function findClosestClose(
  bars: { date: string; close: number }[],
  targetDate: string,
  direction: "before" | "after"
): number | null {
  if (direction === "before") {
    // 从后往前找第一个 <= targetDate
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].date <= targetDate) return bars[i].close;
    }
  } else {
    // 从前往后找第一个 >= targetDate
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].date >= targetDate) return bars[i].close;
    }
  }
  return null;
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

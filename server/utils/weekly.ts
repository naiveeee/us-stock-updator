/**
 * 周线聚合引擎
 *
 * 将 daily_bars 聚合为 weekly_bars
 * - 按 ISO 周（周一~周日）分组
 * - 支持全量重建和增量更新（仅更新最近 N 周）
 */
import type Database from "better-sqlite3";

/**
 * 获取日期所在周的周一
 */
function getMonday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // 周日往回退 6 天
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

interface WeeklyBar {
  ticker: string;
  week_start: string;
  week_end: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
  vwap: number | null;
  num_trades: number;
}

/**
 * 聚合指定 ticker 的日线为周线
 */
function aggregateTickerWeekly(
  dailyRows: Array<{
    ticker: string;
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    vwap: number | null;
    num_trades: number | null;
  }>
): WeeklyBar[] {
  if (!dailyRows.length) return [];

  // 按周分组
  const weekMap = new Map<string, typeof dailyRows>();
  for (const row of dailyRows) {
    const monday = getMonday(row.date);
    const group = weekMap.get(monday) || [];
    group.push(row);
    weekMap.set(monday, group);
  }

  const results: WeeklyBar[] = [];

  for (const [monday, days] of weekMap) {
    // 按日期排序
    days.sort((a, b) => a.date.localeCompare(b.date));

    const first = days[0];
    const last = days[days.length - 1];

    let high: number | null = null;
    let low: number | null = null;
    let totalVolume = 0;
    let totalDollarVolume = 0;
    let totalTrades = 0;

    for (const d of days) {
      if (d.high != null) {
        high = high == null ? d.high : Math.max(high, d.high);
      }
      if (d.low != null) {
        low = low == null ? d.low : Math.min(low, d.low);
      }
      totalVolume += d.volume || 0;
      if (d.vwap != null && d.volume != null) {
        totalDollarVolume += d.vwap * d.volume;
      }
      totalTrades += d.num_trades || 0;
    }

    results.push({
      ticker: first.ticker,
      week_start: monday,
      week_end: last.date,
      open: first.open,
      high,
      low,
      close: last.close,
      volume: totalVolume,
      vwap: totalVolume > 0 ? totalDollarVolume / totalVolume : null,
      num_trades: totalTrades,
    });
  }

  return results;
}

/**
 * 全量重建所有 ticker 的周线
 * @returns 处理的 ticker 数量
 */
export function rebuildAllWeekly(db: Database.Database): number {
  console.log("[Weekly] 全量重建周线...");
  const t0 = Date.now();

  // 获取所有活跃 ticker（有至少 20 天数据的）
  const tickers = db
    .prepare(
      `SELECT ticker, COUNT(*) as cnt FROM daily_bars
       GROUP BY ticker HAVING cnt >= 20
       ORDER BY ticker`
    )
    .all() as Array<{ ticker: string; cnt: number }>;

  console.log(`[Weekly] 共 ${tickers.length} 个 ticker 需要处理`);

  // 清空重建
  db.exec("DELETE FROM weekly_bars");

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO weekly_bars
    (ticker, week_start, week_end, open, high, low, close, volume, vwap, num_trades)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectDaily = db.prepare(`
    SELECT ticker, date, open, high, low, close, volume, vwap, num_trades
    FROM daily_bars WHERE ticker = ?
    ORDER BY date ASC
  `);

  const batchInsert = db.transaction((bars: WeeklyBar[]) => {
    for (const b of bars) {
      insertStmt.run(
        b.ticker,
        b.week_start,
        b.week_end,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.vwap,
        b.num_trades
      );
    }
  });

  let processed = 0;
  for (const { ticker } of tickers) {
    const dailyRows = selectDaily.all(ticker) as any[];
    const weeklyBars = aggregateTickerWeekly(dailyRows);
    if (weeklyBars.length) {
      batchInsert(weeklyBars);
    }
    processed++;
    if (processed % 1000 === 0) {
      console.log(`[Weekly] 已处理 ${processed}/${tickers.length}`);
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[Weekly] 完成，处理 ${processed} 个 ticker，耗时 ${(elapsed / 1000).toFixed(1)}s`
  );
  return processed;
}

/**
 * 增量更新周线（仅更新最近 N 周的数据）
 * @param weeksBack 回溯周数，默认 2（当前周 + 上周）
 */
export function updateRecentWeekly(
  db: Database.Database,
  weeksBack = 2
): number {
  console.log(`[Weekly] 增量更新最近 ${weeksBack} 周...`);
  const t0 = Date.now();

  // 计算起始日期（weeksBack 周前的周一）
  const now = new Date();
  const monday = getMonday(now.toISOString().slice(0, 10));
  const startDate = new Date(monday + "T00:00:00Z");
  startDate.setUTCDate(startDate.getUTCDate() - (weeksBack - 1) * 7);
  const startStr = startDate.toISOString().slice(0, 10);

  // 获取在此期间有数据的 ticker
  const tickers = db
    .prepare(
      `SELECT DISTINCT ticker FROM daily_bars WHERE date >= ?`
    )
    .all(startStr) as Array<{ ticker: string }>;

  console.log(
    `[Weekly] ${tickers.length} 个 ticker 在 ${startStr} 后有数据`
  );

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO weekly_bars
    (ticker, week_start, week_end, open, high, low, close, volume, vwap, num_trades)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 对增量更新，需要拉取从 startStr 所在周开始的所有日线
  const selectDaily = db.prepare(`
    SELECT ticker, date, open, high, low, close, volume, vwap, num_trades
    FROM daily_bars WHERE ticker = ? AND date >= ?
    ORDER BY date ASC
  `);

  const batchInsert = db.transaction((bars: WeeklyBar[]) => {
    for (const b of bars) {
      insertStmt.run(
        b.ticker,
        b.week_start,
        b.week_end,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.vwap,
        b.num_trades
      );
    }
  });

  let processed = 0;
  for (const { ticker } of tickers) {
    const dailyRows = selectDaily.all(ticker, startStr) as any[];
    const weeklyBars = aggregateTickerWeekly(dailyRows);
    if (weeklyBars.length) {
      batchInsert(weeklyBars);
    }
    processed++;
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[Weekly] 增量完成，处理 ${processed} 个 ticker，耗时 ${(elapsed / 1000).toFixed(1)}s`
  );
  return processed;
}

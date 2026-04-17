/**
 * GET /api/stocks/daily
 * 查询日线数据
 *
 * 查询参数：
 *   ticker   - 股票代码 (必填，如 AAPL)
 *   from     - 开始日期 (可选，YYYY-MM-DD，默认 30 天前)
 *   to       - 结束日期 (可选，YYYY-MM-DD，默认今天)
 *   limit    - 返回条数 (可选，默认 500，最大 5000)
 *   sort     - 排序方向 (可选，asc/desc，默认 asc)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);

  const ticker = (query.ticker as string || "").toUpperCase().trim();
  if (!ticker) {
    throw createError({
      statusCode: 400,
      message: "Missing required parameter: ticker",
    });
  }

  const to = (query.to as string) || new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const from = (query.from as string) || defaultFrom.toISOString().slice(0, 10);

  let limit = parseInt(query.limit as string) || 500;
  limit = Math.min(Math.max(1, limit), 5000);

  const sort = (query.sort as string) === "desc" ? "DESC" : "ASC";

  const db = getDb();

  const rows = db
    .prepare(
      `SELECT ticker, date, open, high, low, close, volume, vwap, num_trades, timestamp_ms
       FROM daily_bars
       WHERE ticker = ? AND date >= ? AND date <= ?
       ORDER BY date ${sort}
       LIMIT ?`
    )
    .all(ticker, from, to, limit);

  return {
    ticker,
    from,
    to,
    count: rows.length,
    results: rows,
  };
});

/**
 * GET /api/rs/history
 * 单只股票的 RS Rating 历史
 *
 * 查询参数：
 *   ticker  - 股票代码 (必填)
 *   from    - 开始日期 (可选，默认 6 个月前)
 *   to      - 结束日期 (可选，默认今天)
 *   limit   - 返回条数 (可选，默认 500，最大 2000)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  const ticker = (query.ticker as string || "").toUpperCase().trim();
  if (!ticker) {
    throw createError({
      statusCode: 400,
      message: "Missing required parameter: ticker",
    });
  }

  const to = (query.to as string) || new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date();
  defaultFrom.setMonth(defaultFrom.getMonth() - 6);
  const from = (query.from as string) || defaultFrom.toISOString().slice(0, 10);

  let limit = parseInt(query.limit as string) || 500;
  limit = Math.min(Math.max(1, limit), 2000);

  const rows = db
    .prepare(
      `SELECT r.ticker, r.date, r.score, r.rating, r.percentile,
              d.close, d.volume, d.open, d.high, d.low
       FROM rs_ratings r
       LEFT JOIN daily_bars d ON r.ticker = d.ticker AND r.date = d.date
       WHERE r.ticker = ? AND r.date >= ? AND r.date <= ?
       ORDER BY r.date ASC
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

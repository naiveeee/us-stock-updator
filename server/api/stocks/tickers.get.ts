/**
 * GET /api/stocks/tickers
 * 获取数据库中所有可用的 ticker 列表
 *
 * 查询参数：
 *   search  - 搜索 (可选，前缀匹配)
 *   limit   - 返回条数 (可选，默认 100，最大 5000)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  let limit = parseInt(query.limit as string) || 100;
  limit = Math.min(Math.max(1, limit), 5000);
  const search = (query.search as string || "").toUpperCase().trim();

  let sql = `
    SELECT ticker,
           COUNT(*) as trading_days,
           MIN(date) as first_date,
           MAX(date) as last_date
    FROM daily_bars
  `;
  const params: any[] = [];

  if (search) {
    sql += " WHERE ticker LIKE ?";
    params.push(search + "%");
  }

  sql += " GROUP BY ticker ORDER BY ticker LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  return {
    count: rows.length,
    results: rows,
  };
});

/**
 * GET /api/rs/ranking
 * RS 排名列表
 *
 * 查询参数：
 *   date         - 交易日 (可选，默认最新)
 *   min_rating   - 最低 RS rating (可选，如 80)
 *   sort_by      - 排序字段 (可选：rating/volume/change，默认 rating)
 *   order        - 排序方向 (可选：asc/desc，默认 desc)
 *   limit        - 返回条数 (可选，默认 100，最大 5000)
 *   offset       - 偏移量 (可选，默认 0)
 *   search       - ticker 前缀搜索 (可选)
 *   volume_top   - 只展示成交量前 N 名 (可选，默认 1000)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  // 日期：默认取 rs_ratings 中最新的
  let date = query.date as string;
  if (!date) {
    const latest = db
      .prepare("SELECT MAX(date) as d FROM rs_ratings")
      .get() as { d: string } | undefined;
    date = latest?.d || "";
    if (!date) {
      return { date: null, total: 0, count: 0, results: [], message: "No RS data available. Run backfill first." };
    }
  }

  const minRating = parseInt(query.min_rating as string) || 0;
  const volumeTop = parseInt(query.volume_top as string) || 1000;
  let limit = parseInt(query.limit as string) || 100;
  limit = Math.min(Math.max(1, limit), 5000);
  let offset = parseInt(query.offset as string) || 0;
  offset = Math.max(0, offset);
  const search = (query.search as string || "").toUpperCase().trim();

  const sortFields: Record<string, string> = {
    rating: "r.percentile",
    volume: "d.volume",
    change: "(d.close - d.open) / NULLIF(d.open, 0)",
  };
  const sortBy = sortFields[query.sort_by as string] || "r.percentile";
  const order = (query.order as string) === "asc" ? "ASC" : "DESC";

  // 构建 SQL：rs_ratings JOIN daily_bars，用 volume 子查询做 TOP N 过滤
  // 先找出该日成交量 TOP N 的 ticker
  let volumeFilterSql = "";
  const params: any[] = [date, date];

  if (volumeTop < 50000) {
    volumeFilterSql = `
      AND r.ticker IN (
        SELECT ticker FROM daily_bars
        WHERE date = ?
        ORDER BY volume DESC
        LIMIT ?
      )
    `;
    params.push(date, volumeTop);
  }

  let whereClauses = "r.date = ? AND d.date = ? AND r.ticker = d.ticker";
  whereClauses += volumeFilterSql;

  if (minRating > 0) {
    whereClauses += " AND r.rating >= ?";
    params.push(minRating);
  }
  if (search) {
    whereClauses += " AND r.ticker LIKE ?";
    params.push(search + "%");
  }

  // 总数
  const countSql = `
    SELECT COUNT(*) as total
    FROM rs_ratings r
    JOIN daily_bars d ON r.ticker = d.ticker AND r.date = d.date
    WHERE ${whereClauses}
  `;
  const totalRow = db.prepare(countSql).get(...params) as { total: number };

  // 数据
  const dataSql = `
    SELECT r.ticker, r.date, r.score, r.rating, r.percentile,
           d.close, d.volume, d.open, d.high, d.low, d.vwap,
           CASE WHEN d.open > 0 THEN ROUND((d.close - d.open) / d.open * 100, 2) ELSE NULL END as change_pct
    FROM rs_ratings r
    JOIN daily_bars d ON r.ticker = d.ticker AND r.date = d.date
    WHERE ${whereClauses}
    ORDER BY ${sortBy} ${order} NULLS LAST
    LIMIT ? OFFSET ?
  `;

  const dataParams = [...params, limit, offset];
  const rows = db.prepare(dataSql).all(...dataParams);

  return {
    date,
    total: totalRow?.total || 0,
    count: rows.length,
    offset,
    limit,
    volume_top: volumeTop,
    results: rows,
  };
});

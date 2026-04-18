/**
 * GET /api/stocks/snapshot
 * 查询某一天的全市场快照
 *
 * 查询参数：
 *   date     - 交易日 (可选，YYYY-MM-DD，默认最新)
 *   sort_by  - 排序字段 (可选：volume/change/ticker，默认 volume)
 *   order    - 排序方向 (可选：asc/desc，默认 desc)
 *   limit    - 返回条数 (可选，默认 100，最大 5000)
 *   offset   - 偏移量 (可选，默认 0)
 *   search   - 搜索 ticker (可选，前缀匹配)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  // 日期：如不传则取最新的交易日（从 daily_bars 查，兼容 CRSP 导入数据）
  let date = query.date as string;
  if (!date) {
    const latest = db
      .prepare(
        "SELECT date FROM daily_bars ORDER BY date DESC LIMIT 1"
      )
      .get() as { date: string } | undefined;
    date = latest?.date || new Date().toISOString().slice(0, 10);
  }

  const sortFields: Record<string, string> = {
    volume: "volume",
    change: "(close - open) / NULLIF(open, 0)",
    ticker: "ticker",
  };
  const sortBy = sortFields[query.sort_by as string] || "volume";
  const order = (query.order as string) === "asc" ? "ASC" : "DESC";

  let limit = parseInt(query.limit as string) || 100;
  limit = Math.min(Math.max(1, limit), 5000);
  let offset = parseInt(query.offset as string) || 0;
  offset = Math.max(0, offset);

  const search = (query.search as string || "").toUpperCase().trim();

  // 总数
  let countSql = "SELECT COUNT(*) as total FROM daily_bars WHERE date = ?";
  const countParams: any[] = [date];
  if (search) {
    countSql += " AND ticker LIKE ?";
    countParams.push(search + "%");
  }
  const totalRow = db.prepare(countSql).get(...countParams) as { total: number };

  // 数据
  let dataSql = `
    SELECT ticker, date, open, high, low, close, volume, vwap, num_trades,
           CASE WHEN open > 0 THEN ROUND((close - open) / open * 100, 2) ELSE NULL END as change_pct
    FROM daily_bars
    WHERE date = ?
  `;
  const dataParams: any[] = [date];
  if (search) {
    dataSql += " AND ticker LIKE ?";
    dataParams.push(search + "%");
  }
  dataSql += ` ORDER BY ${sortBy} ${order} NULLS LAST LIMIT ? OFFSET ?`;
  dataParams.push(limit, offset);

  const rows = db.prepare(dataSql).all(...dataParams);

  return {
    date,
    total: totalRow?.total || 0,
    count: rows.length,
    offset,
    limit,
    results: rows,
  };
});

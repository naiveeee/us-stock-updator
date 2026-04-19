/**
 * GET /api/screener/results
 * 查询选股结果
 *
 * 参数：
 *   side       - 'left' / 'right' (必填)
 *   ticker     - 股票代码搜索 (可选，前缀匹配)
 *   index      - 'sp500' / 'nasdaq100' (可选，只显示指数成分股)
 *   grade      - 'A' / 'B' / 'C' (可选，默认全部)
 *   min_score  - 最低分 (可选)
 *   sort       - 'score' / 'week_change_pct' / 'volume' / 'avg_dollar_volume' (默认 score)
 *   order      - 'asc' / 'desc' (默认 desc)
 *   limit      - 条数 (默认 50，最大 500)
 *   offset     - 偏移 (默认 0)
 *   scan_date  - 指定日期 (可选，默认最新)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  const side = (query.side as string) || "left";
  if (side !== "left" && side !== "right") {
    throw createError({
      statusCode: 400,
      message: 'Parameter "side" must be "left" or "right"',
    });
  }

  // 日期
  let scanDate = query.scan_date as string;
  if (!scanDate) {
    const latest = db
      .prepare(
        "SELECT MAX(scan_date) as d FROM screener_results WHERE scan_type = ?"
      )
      .get(side) as { d: string | null } | undefined;
    scanDate = latest?.d || new Date().toISOString().slice(0, 10);
  }

  // 构建查询
  const conditions: string[] = ["r.scan_date = ?", "r.scan_type = ?"];
  const params: any[] = [scanDate, side];

  // 指数过滤
  const indexFilter = (query.index as string) || "";
  const useIndexJoin = indexFilter && ["sp500", "nasdaq100"].includes(indexFilter);

  const grade = query.grade as string;
  if (grade && ["A", "B", "C"].includes(grade)) {
    conditions.push("r.grade = ?");
    params.push(grade);
  }

  // ticker 搜索（前缀匹配，支持模糊搜索）
  const ticker = ((query.ticker as string) || "").toUpperCase().trim();
  if (ticker) {
    conditions.push("r.ticker LIKE ?");
    params.push(ticker + "%");
  }

  const minScore = parseFloat(query.min_score as string);
  if (!isNaN(minScore)) {
    conditions.push("r.score >= ?");
    params.push(minScore);
  }

  // 排序
  const sortFields: Record<string, string> = {
    score: "r.score",
    week_change_pct: "r.week_change_pct",
    volume: "r.latest_volume",
    avg_dollar_volume: "r.avg_dollar_volume",
  };
  const sortBy = sortFields[query.sort as string] || "r.score";
  const order = (query.order as string) === "asc" ? "ASC" : "DESC";

  let limit = parseInt(query.limit as string) || 50;
  limit = Math.min(Math.max(1, limit), 500);
  let offset = parseInt(query.offset as string) || 0;
  offset = Math.max(0, offset);

  const where = conditions.join(" AND ");

  // 构建 FROM 子句（是否 JOIN index_components）
  let fromClause = "screener_results r";
  if (useIndexJoin) {
    fromClause += " INNER JOIN index_components ic ON r.ticker = ic.ticker AND ic.index_name = ?";
    params.push(indexFilter);
  }

  // 由于 params 会同时用于 count 和 data 查询，先组装好再用
  const countParams = [...params];
  const dataParams = [...params];

  // 总数
  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM ${fromClause} WHERE ${where}`)
    .get(...countParams) as { total: number };

  // 数据
  const rows = db
    .prepare(
      `SELECT r.id, r.scan_date, r.scan_type as side, r.ticker, r.score, r.grade, r.score_detail,
              r.latest_close, r.latest_volume, r.week_change_pct, r.avg_dollar_volume, r.created_at
       FROM ${fromClause}
       WHERE ${where}
       ORDER BY ${sortBy} ${order}
       LIMIT ? OFFSET ?`
    )
    .all(...dataParams, limit, offset) as any[];

  // 解析 score_detail JSON
  const results = rows.map((r) => ({
    ...r,
    score_detail: r.score_detail ? JSON.parse(r.score_detail) : null,
  }));

  // 获取对应的信号
  const tickerList = results.map((r: any) => r.ticker);
  const signalsMap: Record<string, any[]> = {};

  if (tickerList.length > 0) {
    const placeholders = tickerList.map(() => "?").join(",");
    const signals = db
      .prepare(
        `SELECT ticker, signal_type, side, description, value, max_value
         FROM screener_signals
         WHERE scan_date = ? AND side = ? AND ticker IN (${placeholders})`
      )
      .all(scanDate, side, ...tickerList) as any[];

    for (const sig of signals) {
      if (!signalsMap[sig.ticker]) signalsMap[sig.ticker] = [];
      signalsMap[sig.ticker].push(sig);
    }
  }

  // 合并信号到结果
  for (const r of results) {
    (r as any).signals = signalsMap[r.ticker] || [];
  }

  // 获取可用的扫描日期列表
  const scanDates = db
    .prepare(
      `SELECT DISTINCT scan_date FROM screener_results
       WHERE scan_type = ? ORDER BY scan_date DESC LIMIT 30`
    )
    .all(side) as Array<{ scan_date: string }>;

  // 获取指数统计（返回给前端显示）
  const indexStats = db
    .prepare(
      `SELECT index_name, COUNT(*) as count FROM index_components GROUP BY index_name`
    )
    .all() as Array<{ index_name: string; count: number }>;

  return {
    scan_date: scanDate,
    side,
    total: countRow?.total || 0,
    count: results.length,
    offset,
    limit,
    available_dates: scanDates.map((d) => d.scan_date),
    index_stats: indexStats,
    results,
  };
});

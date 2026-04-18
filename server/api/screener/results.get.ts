/**
 * GET /api/screener/results
 * 查询选股结果
 *
 * 参数：
 *   side       - 'left' / 'right' (必填)
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
  const conditions: string[] = ["scan_date = ?", "scan_type = ?"];
  const params: any[] = [scanDate, side];

  const grade = query.grade as string;
  if (grade && ["A", "B", "C"].includes(grade)) {
    conditions.push("grade = ?");
    params.push(grade);
  }

  const minScore = parseFloat(query.min_score as string);
  if (!isNaN(minScore)) {
    conditions.push("score >= ?");
    params.push(minScore);
  }

  // 排序
  const sortFields: Record<string, string> = {
    score: "score",
    week_change_pct: "week_change_pct",
    volume: "latest_volume",
    avg_dollar_volume: "avg_dollar_volume",
  };
  const sortBy = sortFields[query.sort as string] || "score";
  const order = (query.order as string) === "asc" ? "ASC" : "DESC";

  let limit = parseInt(query.limit as string) || 50;
  limit = Math.min(Math.max(1, limit), 500);
  let offset = parseInt(query.offset as string) || 0;
  offset = Math.max(0, offset);

  const where = conditions.join(" AND ");

  // 总数
  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM screener_results WHERE ${where}`)
    .get(...params) as { total: number };

  // 数据
  const rows = db
    .prepare(
      `SELECT id, scan_date, scan_type as side, ticker, score, grade, score_detail,
              latest_close, latest_volume, week_change_pct, avg_dollar_volume, created_at
       FROM screener_results
       WHERE ${where}
       ORDER BY ${sortBy} ${order}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[];

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

  return {
    scan_date: scanDate,
    side,
    total: countRow?.total || 0,
    count: results.length,
    offset,
    limit,
    available_dates: scanDates.map((d) => d.scan_date),
    results,
  };
});

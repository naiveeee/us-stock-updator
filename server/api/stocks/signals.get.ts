/**
 * GET /api/stocks/signals
 * 查询单只股票的信号历史
 *
 * 参数：
 *   ticker - 股票代码 (必填)
 *   limit  - 条数 (可选，默认 50)
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  const ticker = ((query.ticker as string) || "").toUpperCase().trim();
  if (!ticker) {
    throw createError({
      statusCode: 400,
      message: "Missing required parameter: ticker",
    });
  }

  let limit = parseInt(query.limit as string) || 50;
  limit = Math.min(Math.max(1, limit), 200);

  const signals = db
    .prepare(
      `SELECT scan_date, signal_type, side, description, value, max_value, week_date
       FROM screener_signals
       WHERE ticker = ?
       ORDER BY scan_date DESC
       LIMIT ?`
    )
    .all(ticker, limit);

  // 获取该股票的历史评分
  const scores = db
    .prepare(
      `SELECT scan_date, scan_type as side, score, grade, score_detail,
              latest_close, week_change_pct
       FROM screener_results
       WHERE ticker = ?
       ORDER BY scan_date DESC
       LIMIT ?`
    )
    .all(ticker, limit) as any[];

  for (const s of scores) {
    s.score_detail = s.score_detail ? JSON.parse(s.score_detail) : null;
  }

  return {
    ticker,
    signals,
    scores,
  };
});

/**
 * GET /api/ticker-info/:ticker
 * 获取单只 ticker 的元数据（名称、行业、交易所等）
 */
export default defineEventHandler((event) => {
  const ticker = (getRouterParam(event, "ticker") || "").toUpperCase();

  if (!ticker) {
    throw createError({ statusCode: 400, statusMessage: "ticker is required" });
  }

  const db = getDb();

  const row = db
    .prepare(
      `SELECT ticker, name, primary_exchange, ticker_type, sic_code, sic_description, sector, cik, market_cap, updated_at
       FROM ticker_info
       WHERE ticker = ?`
    )
    .get(ticker) as Record<string, any> | undefined;

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: `Ticker ${ticker} not found` });
  }

  return row;
});

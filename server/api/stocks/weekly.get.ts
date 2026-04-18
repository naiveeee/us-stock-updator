/**
 * GET /api/stocks/weekly
 * 查询单只股票周线 + 技术指标数据
 *
 * 参数：
 *   ticker - 股票代码 (必填)
 *   weeks  - 返回周数 (可选，默认 104 即 2 年)
 */
import { type Bar, calcAllIndicators } from "../../utils/indicators";

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

  let weeks = parseInt(query.weeks as string) || 104;
  weeks = Math.min(Math.max(10, weeks), 520); // 10周 ~ 10年

  const rows = db
    .prepare(
      `SELECT ticker, week_start as date, open, high, low, close, volume
       FROM weekly_bars WHERE ticker = ?
       ORDER BY week_start DESC LIMIT ?`
    )
    .all(ticker, weeks) as Bar[];

  if (rows.length === 0) {
    return {
      ticker,
      count: 0,
      bars: [],
      indicators: null,
    };
  }

  // 反转为升序（计算指标需要）
  rows.reverse();

  // 过滤掉 OHLC 为 null 的
  const validBars = rows.filter(
    (b) => b.open != null && b.high != null && b.low != null && b.close != null
  );

  // 计算技术指标
  const indicators = validBars.length >= 30 ? calcAllIndicators(validBars) : null;

  // 获取最新的选股信号
  const latestSignals = db
    .prepare(
      `SELECT signal_type, side, description, value, max_value, week_date
       FROM screener_signals
       WHERE ticker = ?
       ORDER BY scan_date DESC LIMIT 20`
    )
    .all(ticker);

  return {
    ticker,
    count: validBars.length,
    bars: validBars,
    indicators,
    signals: latestSignals,
  };
});

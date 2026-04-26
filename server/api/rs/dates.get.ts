/**
 * GET /api/rs/dates
 * 获取所有有 RS 数据的交易日列表
 *
 * 返回: { dates: string[], earliest, latest }
 */
export default defineEventHandler(() => {
  const db = getDb();

  const rows = db
    .prepare("SELECT DISTINCT date FROM rs_ratings ORDER BY date ASC")
    .all() as { date: string }[];

  const dates = rows.map((r) => r.date);

  return {
    dates,
    earliest: dates[0] || null,
    latest: dates[dates.length - 1] || null,
    count: dates.length,
  };
});

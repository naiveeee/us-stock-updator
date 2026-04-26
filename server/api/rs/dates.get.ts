/**
 * GET /api/rs/dates
 * 获取 RS 数据的日期范围（最早、最晚日期）
 */
export default defineEventHandler(() => {
  const db = getDb();

  const row = db
    .prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM rs_ratings")
    .get() as { earliest: string | null; latest: string | null } | undefined;

  return {
    earliest: row?.earliest || null,
    latest: row?.latest || null,
  };
});

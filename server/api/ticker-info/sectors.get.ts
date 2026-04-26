/**
 * GET /api/ticker-info/sectors
 * 获取所有板块列表和统计
 *
 * 返回: { sectors: [{ name, count }] }
 */
export default defineEventHandler(() => {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT sector, COUNT(*) as count
       FROM ticker_info
       WHERE sector IS NOT NULL AND sector != 'Unknown'
       GROUP BY sector
       ORDER BY count DESC`
    )
    .all() as { sector: string; count: number }[];

  // 也统计 Unknown 和总数
  const unknownRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM ticker_info WHERE sector IS NULL OR sector = 'Unknown'`
    )
    .get() as { count: number };

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM ticker_info`)
    .get() as { count: number };

  return {
    total: totalRow?.count || 0,
    withSector: totalRow.count - (unknownRow?.count || 0),
    sectors: rows,
  };
});

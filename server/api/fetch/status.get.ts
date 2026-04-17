/**
 * GET /api/fetch/status
 * 查询采集任务状态 + 数据库统计
 */
export default defineEventHandler(() => {
  const fetcherState = getFetcherState();
  const db = getDb();

  // 数据库统计
  const dbStats = db
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(result_count), 0) as records
       FROM fetch_progress GROUP BY status`
    )
    .all() as { status: string; count: number; records: number }[];

  // 数据范围
  const range = db
    .prepare(
      `SELECT MIN(date) as min_date, MAX(date) as max_date
       FROM fetch_progress WHERE status = 'done'`
    )
    .get() as { min_date: string | null; max_date: string | null } | undefined;

  // 总记录数
  const totalRow = db
    .prepare("SELECT COUNT(*) as count FROM daily_bars")
    .get() as { count: number };

  // 唯一 ticker 数
  const tickerRow = db
    .prepare("SELECT COUNT(DISTINCT ticker) as count FROM daily_bars")
    .get() as { count: number };

  return {
    fetcher: fetcherState,
    database: {
      stats: dbStats,
      totalRecords: totalRow?.count || 0,
      uniqueTickers: tickerRow?.count || 0,
      dateRange: range || { min_date: null, max_date: null },
    },
  };
});

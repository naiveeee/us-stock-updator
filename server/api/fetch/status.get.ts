/**
 * GET /api/fetch/status
 * 查询采集任务状态 + 数据库统计
 *
 * 优化：使用 db_stats 预计算表，所有查询 O(1)，
 * 避免对 3900 万行 daily_bars 做全表 COUNT。
 */

export default defineEventHandler(() => {
  const fetcherState = getFetcherState();
  const db = getDb();

  // 采集任务统计（fetch_progress 表很小，直接查）
  const dbStats = db
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(result_count), 0) as records
       FROM fetch_progress GROUP BY status`
    )
    .all() as { status: string; count: number; records: number }[];

  // daily_bars 统计：从预计算表读取（O(1)）
  const stats = getDbStats();

  return {
    fetcher: fetcherState,
    database: {
      stats: dbStats,
      totalRecords: stats?.totalRecords || 0,
      uniqueTickers: stats?.uniqueTickers || 0,
      dateRange: {
        min_date: stats?.minDate || null,
        max_date: stats?.maxDate || null,
      },
    },
  };
});

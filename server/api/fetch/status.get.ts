/**
 * GET /api/fetch/status
 * 查询采集任务状态 + 数据库统计
 *
 * 慢查询优化：COUNT(DISTINCT ticker) 和日期范围在千万级数据上很慢，
 * 使用内存缓存，每 5 分钟刷新一次。
 */

let _dbStatsCache: {
  totalRecords: number;
  uniqueTickers: number;
  dateRange: { min_date: string | null; max_date: string | null };
  updatedAt: number;
} | null = null;

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

export default defineEventHandler(() => {
  const fetcherState = getFetcherState();
  const db = getDb();

  // 采集任务统计（fetch_progress 表很小，不需要缓存）
  const dbStats = db
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(result_count), 0) as records
       FROM fetch_progress GROUP BY status`
    )
    .all() as { status: string; count: number; records: number }[];

  // daily_bars 统计：使用缓存避免慢查询
  const now = Date.now();
  if (!_dbStatsCache || now - _dbStatsCache.updatedAt > CACHE_TTL) {
    // 日期范围：从 daily_bars 查（而非 fetch_progress），利用索引排序取首尾
    const minDate = db
      .prepare("SELECT date FROM daily_bars ORDER BY date ASC LIMIT 1")
      .get() as { date: string } | undefined;
    const maxDate = db
      .prepare("SELECT date FROM daily_bars ORDER BY date DESC LIMIT 1")
      .get() as { date: string } | undefined;

    // 总记录数
    const totalRow = db
      .prepare("SELECT COUNT(*) as count FROM daily_bars")
      .get() as { count: number };

    // 唯一 ticker 数：利用 ticker 索引
    const tickerRow = db
      .prepare("SELECT COUNT(DISTINCT ticker) as count FROM daily_bars")
      .get() as { count: number };

    _dbStatsCache = {
      totalRecords: totalRow?.count || 0,
      uniqueTickers: tickerRow?.count || 0,
      dateRange: {
        min_date: minDate?.date || null,
        max_date: maxDate?.date || null,
      },
      updatedAt: now,
    };
  }

  return {
    fetcher: fetcherState,
    database: {
      stats: dbStats,
      totalRecords: _dbStatsCache.totalRecords,
      uniqueTickers: _dbStatsCache.uniqueTickers,
      dateRange: _dbStatsCache.dateRange,
    },
  };
});

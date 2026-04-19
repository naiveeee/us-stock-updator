/**
 * GET /api/index/stats
 *
 * 获取指数成分股的统计信息
 */
export default defineEventHandler(() => {
  const db = getDb();
  return {
    stats: getIndexStats(db),
  };
});

/**
 * GET /api/pipeline/status
 * 查询流水线状态
 */
export default defineEventHandler(() => {
  const state = getPipelineState();

  // 查询历史运行记录
  const db = getDb();
  const history = db
    .prepare(
      `SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 10`
    )
    .all();

  return {
    current: state,
    history,
  };
});

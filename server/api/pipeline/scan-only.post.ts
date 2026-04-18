/**
 * POST /api/pipeline/scan-only
 * 仅重新扫描（不重建周线）
 * 用于调参后快速重跑选股
 */
export default defineEventHandler(async () => {
  const db = getDb();
  const result = await runPipeline(db, {
    scanOnly: true,
    triggerType: "manual_scan",
  });

  return {
    status: result,
    message: result === "done" ? "扫描完成" : result === "already_running" ? "流水线正在运行中" : "扫描出错",
    state: getPipelineState(),
  };
});

/**
 * POST /api/pipeline/run
 * 触发完整流水线（周线聚合 → 选股扫描）
 *
 * Body: { fullRebuild?: boolean }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}));
  const fullRebuild = body?.fullRebuild === true;

  const db = getDb();
  const result = await runPipeline(db, {
    fullRebuild,
    triggerType: "manual",
  });

  const messages: Record<string, string> = {
    done: "流水线执行完成",
    already_running: "流水线正在运行中",
    error: "流水线执行出错",
  };

  return {
    status: result,
    message: messages[result] || result,
    state: getPipelineState(),
  };
});

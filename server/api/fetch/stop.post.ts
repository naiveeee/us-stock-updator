/**
 * POST /api/fetch/stop
 * 停止当前采集任务（安全停止，当前请求完成后退出）
 */
export default defineEventHandler(() => {
  const stopped = stopFetcher();

  return {
    status: stopped ? "stopping" : "not_running",
    message: stopped
      ? "正在安全停止，当前请求完成后退出"
      : "当前没有运行中的采集任务",
  };
});

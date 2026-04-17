/**
 * POST /api/fetch/start
 * 启动数据采集任务
 *
 * Body: { retryErrors?: boolean }
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const apiKey = config.massiveApiKey;

  if (!apiKey) {
    throw createError({
      statusCode: 500,
      message: "MASSIVE_API_KEY not configured. Set it in .env or environment variables.",
    });
  }

  const body = await readBody(event).catch(() => ({}));
  const retryErrors = body?.retryErrors === true;

  const result = await startFetcher(apiKey, retryErrors);

  const messages: Record<string, string> = {
    started: "采集任务已启动，后台运行中",
    already_running: "采集任务已在运行中",
    all_done: "所有日期已采集完成，无需重新采集",
  };

  return {
    status: result,
    message: messages[result] || result,
  };
});

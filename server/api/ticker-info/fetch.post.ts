/**
 * POST /api/ticker-info/fetch
 * 触发 ticker 元数据拉取（异步执行，立即返回）
 *
 * 使用 GET /api/ticker-info/status 查询进度
 */
import { fetchAndSaveTickerInfo, getTickerInfoStatus } from "../../utils/ticker-info";

export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  const apiKey = config.massiveApiKey;

  if (!apiKey) {
    throw createError({
      statusCode: 500,
      message: "MASSIVE_API_KEY not configured",
    });
  }

  // 检查是否已在运行
  const currentStatus = getTickerInfoStatus();
  if (currentStatus.running) {
    return {
      status: "already_running",
      message: `任务已在运行中 (${currentStatus.phase}: ${currentStatus.message})`,
      ...currentStatus,
    };
  }

  // 异步触发，不等待完成
  console.log("[TickerInfo] 收到拉取请求，开始异步执行...");
  console.log(`[TickerInfo] API Key: ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);

  fetchAndSaveTickerInfo(apiKey, (p) => {
    console.log(`[TickerInfo] ${p.message}`);
  }).then((result) => {
    const msg = `完成: ${result.total} 只 ticker, ${result.withSic} 只有行业信息`;
    console.log(`[TickerInfo] ✅ ${msg}`);
  }).catch((err) => {
    const errMsg = err?.message || String(err);
    console.error(`[TickerInfo] ❌ 失败: ${errMsg}`);
  });

  return {
    status: "started",
    message: "Ticker info 拉取任务已启动，使用 GET /api/ticker-info/status 查询进度",
  };
});

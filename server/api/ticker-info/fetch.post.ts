/**
 * POST /api/ticker-info/fetch
 * 拉取 ticker 元数据（行业信息）
 *
 * 两步走：
 *   1. Polygon Tickers List → 基础信息 (~2 min)
 *   2. SEC Submissions → SIC 行业代码 (~17 min)
 *
 * 返回进度和结果
 */
import { fetchAndSaveTickerInfo } from "../../utils/ticker-info";

export default defineEventHandler(async () => {
  const config = useRuntimeConfig();
  const apiKey = config.massiveApiKey;

  if (!apiKey) {
    throw createError({
      statusCode: 500,
      message: "MASSIVE_API_KEY not configured",
    });
  }

  console.log("[TickerInfo] 开始拉取 ticker 元数据...");
  const startTime = Date.now();

  const result = await fetchAndSaveTickerInfo(apiKey, (p) => {
    console.log(`[TickerInfo] ${p.message}`);
  });

  const durationMs = Date.now() - startTime;
  const msg = `完成: ${result.total} 只 ticker, ${result.withSic} 只有行业信息, 耗时 ${(durationMs / 1000 / 60).toFixed(1)} 分钟`;
  console.log(`[TickerInfo] ${msg}`);

  return {
    status: "done",
    total: result.total,
    withSic: result.withSic,
    durationMs,
    message: msg,
  };
});

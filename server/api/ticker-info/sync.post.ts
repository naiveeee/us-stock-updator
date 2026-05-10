/**
 * POST /api/ticker-info/sync
 * 增量同步新 ticker 信息
 *
 * 查找 daily_bars 中有但 ticker_info 中没有的 ticker，
 * 调 Polygon 获取 type/name/exchange，再查 SEC 获取 SIC。
 *
 * Body: { sinceDays?: number } - 默认 7 天
 */
import { syncNewTickers } from "../../utils/ticker-info";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const apiKey = config.massiveApiKey;

  if (!apiKey) {
    throw createError({
      statusCode: 500,
      message: "MASSIVE_API_KEY not configured",
    });
  }

  const body = await readBody(event).catch(() => ({}));
  const sinceDays = body?.sinceDays ?? 7;

  try {
    const result = await syncNewTickers(apiKey, sinceDays);
    return {
      status: "ok",
      message: `增量同步完成: ${result.synced} 只新 ticker, ${result.withSic} 只有行业信息`,
      ...result,
    };
  } catch (err: any) {
    throw createError({
      statusCode: 500,
      message: err?.message || "同步失败",
    });
  }
});

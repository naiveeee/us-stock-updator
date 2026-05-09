/**
 * Massive API 客户端工具
 *
 * - Grouped Daily：一次请求获取某天所有股票日线
 * - 内置重试 + 429 退避
 */

const BASE_URL = "https://api.massive.com";
const MAX_RETRIES = 3;
const BACKOFF_BASE = 65_000; // 65s

interface AggResult {
  T?: string; // ticker
  o?: number; // open
  h?: number; // high
  l?: number; // low
  c?: number; // close
  v?: number; // volume
  vw?: number; // vwap
  n?: number; // num_trades
  t?: number; // timestamp_ms
  otc?: boolean;
}

interface GroupedDailyResponse {
  status: string;
  resultsCount: number;
  results: AggResult[];
}

export async function fetchGroupedDaily(
  date: string,
  apiKey: string
): Promise<GroupedDailyResponse> {
  const url = `${BASE_URL}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&include_otc=false&apiKey=${apiKey}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    try {
      console.log(`[Fetch] ${date} attempt ${attempt}/${MAX_RETRIES}, url=${BASE_URL}/v2/aggs/grouped/.../stocks/${date}`);
      const resp = await $fetch<GroupedDailyResponse>(url, {
        timeout: 60_000,
      });
      console.log(`[Fetch] ${date} 成功, ${resp.resultsCount} results, 耗时 ${Date.now() - startTime}ms`);
      return resp;
    } catch (err: any) {
      const status = err?.response?.status || err?.statusCode || 0;
      const elapsed = Date.now() - startTime;
      const responseBody = err?.response?._data || err?.data || null;
      const errMsg = err?.message || String(err);

      // 完整的错误日志
      console.error(`[Fetch] ${date} 失败 (attempt ${attempt}/${MAX_RETRIES}): HTTP ${status}, 耗时 ${elapsed}ms`);
      console.error(`[Fetch]   message: ${errMsg}`);
      if (responseBody) {
        console.error(`[Fetch]   response body: ${JSON.stringify(responseBody).slice(0, 500)}`);
      }
      if (err?.response?.headers) {
        // 尝试获取 rate limit 相关的 headers
        const headers = err.response.headers;
        const rateLimitHeaders = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];
        const relevantHeaders: Record<string, string> = {};
        for (const h of rateLimitHeaders) {
          const val = typeof headers.get === 'function' ? headers.get(h) : headers[h];
          if (val) relevantHeaders[h] = String(val);
        }
        if (Object.keys(relevantHeaders).length > 0) {
          console.error(`[Fetch]   rate-limit headers: ${JSON.stringify(relevantHeaders)}`);
        }
      }

      // 非交易日
      if (status === 404) {
        return { status: "NOT_FOUND", resultsCount: 0, results: [] };
      }

      // 权限问题 —— 可能是临时 rate limit 伪装成 403
      if (status === 403) {
        // 如果还有重试次数，等待后重试（Polygon 有时对 free tier 返回 403 而非 429）
        if (attempt < MAX_RETRIES) {
          const wait = BACKOFF_BASE * attempt;
          console.log(`[Fetch]   403 可能为临时限流, 等待 ${wait / 1000}s 后重试...`);
          await sleep(wait);
          continue;
        }
        throw new Error(`403 Forbidden - API Key 无效或无权限 (已重试 ${MAX_RETRIES} 次, response: ${JSON.stringify(responseBody).slice(0, 200)})`);
      }

      // 频率限制
      if (status === 429) {
        const wait = BACKOFF_BASE * attempt;
        console.log(
          `[Fetch]   ⚠️ 429 Rate Limited (attempt ${attempt}/${MAX_RETRIES}), waiting ${wait / 1000}s...`
        );
        await sleep(wait);
        continue;
      }

      // 其他错误
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `HTTP ${status}: ${errMsg} after ${MAX_RETRIES} retries`
        );
      }

      console.log(
        `[Fetch]   ⚠️ Error ${status} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${10 * attempt}s...`
      );
      await sleep(10_000 * attempt);
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

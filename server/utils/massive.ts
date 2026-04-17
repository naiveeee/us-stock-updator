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
    try {
      const resp = await $fetch<GroupedDailyResponse>(url, {
        timeout: 60_000,
      });
      return resp;
    } catch (err: any) {
      const status = err?.response?.status || err?.statusCode || 0;

      // 非交易日
      if (status === 404) {
        return { status: "NOT_FOUND", resultsCount: 0, results: [] };
      }

      // 权限问题，直接抛
      if (status === 403) {
        throw new Error("403 Forbidden - API Key 无效或无权限");
      }

      // 频率限制
      if (status === 429) {
        const wait = BACKOFF_BASE * attempt;
        console.log(
          `  ⚠️ 429 Rate Limited (attempt ${attempt}/${MAX_RETRIES}), waiting ${wait / 1000}s...`
        );
        await sleep(wait);
        continue;
      }

      // 其他错误
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `HTTP ${status}: ${err?.message || "Unknown error"} after ${MAX_RETRIES} retries`
        );
      }

      console.log(
        `  ⚠️ Error ${status} (attempt ${attempt}/${MAX_RETRIES}), retrying...`
      );
      await sleep(10_000 * attempt);
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

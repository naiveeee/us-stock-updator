/**
 * Ticker 元数据拉取工具
 *
 * 两步走：
 *   1. Polygon Tickers List API — 批量拉全市场 ticker + name + CIK + exchange
 *      (分页, 每页 1000, 约 10 页, 5 calls/min → ~2分钟)
 *   2. SEC Submissions API — 根据 CIK 拉 SIC code
 *      (10 req/sec, ~10000 CIK → ~17分钟)
 *
 * 最终写入 ticker_info 表
 */
import { getDb } from "./db";
import { sicToSector } from "./sector-map";

const SEC_USER_AGENT = "us-stock-updator gaozhao@tencent.com";

interface TickerListItem {
  ticker: string;
  name?: string;
  cik?: string;
  primary_exchange?: string;
  type?: string;
  active?: boolean;
}

interface PolygonTickersResponse {
  status: string;
  results: TickerListItem[];
  next_url?: string;
  count?: number;
}

interface FetchTickerInfoProgress {
  phase: "polygon" | "sec";
  current: number;
  total: number;
  message: string;
}

/**
 * Step 1: 从 Polygon Tickers List 拉全量 ticker 元数据
 */
async function fetchPolygonTickers(
  apiKey: string,
  onProgress?: (p: FetchTickerInfoProgress) => void
): Promise<TickerListItem[]> {
  const allTickers: TickerListItem[] = [];
  let nextUrl: string | null =
    `https://api.massive.com/v3/reference/tickers?market=stocks&active=true&limit=1000&apiKey=${apiKey}`;
  let page = 0;

  while (nextUrl) {
    page++;
    onProgress?.({
      phase: "polygon",
      current: page,
      total: -1,
      message: `Polygon: 拉取第 ${page} 页...`,
    });

    const resp = await $fetch<PolygonTickersResponse>(nextUrl, { timeout: 30_000 });
    if (resp.results) {
      allTickers.push(...resp.results);
    }

    // Polygon 的 next_url 不带 apiKey，需要自己加
    if (resp.next_url) {
      const sep = resp.next_url.includes("?") ? "&" : "?";
      nextUrl = `${resp.next_url}${sep}apiKey=${apiKey}`;
    } else {
      nextUrl = null;
    }

    // 免费版 5 calls/min，安全起见等 13 秒
    if (nextUrl) {
      await sleep(13_000);
    }
  }

  onProgress?.({
    phase: "polygon",
    current: page,
    total: page,
    message: `Polygon: 完成, 共 ${allTickers.length} 只 ticker`,
  });

  return allTickers;
}

/**
 * Step 2: 从 SEC 批量查 SIC
 * SEC 限速 10 req/sec，我们保守按 5 req/sec
 */
async function fetchSECSicCodes(
  cikMap: Map<string, string>, // ticker → CIK
  onProgress?: (p: FetchTickerInfoProgress) => void
): Promise<Map<string, { sic: string; sicDesc: string }>> {
  const results = new Map<string, { sic: string; sicDesc: string }>();
  const entries = Array.from(cikMap.entries());
  const total = entries.length;

  // 批处理：每次 5 个并发
  const BATCH_SIZE = 5;
  const BATCH_DELAY = 1100; // 1.1 秒间隔确保 < 10 req/sec

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    if (i % 100 === 0) {
      onProgress?.({
        phase: "sec",
        current: i,
        total,
        message: `SEC: ${i}/${total} CIK...`,
      });
    }

    const promises = batch.map(async ([ticker, cik]) => {
      try {
        // CIK 需要补零到 10 位
        const paddedCik = cik.padStart(10, "0");
        const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
        const data = await $fetch<any>(url, {
          timeout: 10_000,
          headers: { "User-Agent": SEC_USER_AGENT },
        });
        if (data?.sic) {
          results.set(ticker, {
            sic: data.sic,
            sicDesc: data.sicDescription || "",
          });
        }
      } catch {
        // 忽略单个失败
      }
    });

    await Promise.all(promises);
    await sleep(BATCH_DELAY);
  }

  onProgress?.({
    phase: "sec",
    current: total,
    total,
    message: `SEC: 完成, ${results.size}/${total} 成功获取 SIC`,
  });

  return results;
}

/**
 * 主流程：拉取 + 写库
 */
export async function fetchAndSaveTickerInfo(
  apiKey: string,
  onProgress?: (p: FetchTickerInfoProgress) => void
): Promise<{ total: number; withSic: number }> {
  const db = getDb();

  // Step 1: Polygon Tickers List
  const tickers = await fetchPolygonTickers(apiKey, onProgress);

  // 先把 Polygon 的数据写入（没有 SIC 的也先存）
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO ticker_info
    (ticker, name, primary_exchange, cik, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const cikMap = new Map<string, string>();

  const insertBatch = db.transaction(() => {
    for (const t of tickers) {
      if (!t.ticker) continue;
      upsert.run(t.ticker, t.name || null, t.primary_exchange || null, t.cik || null, now);
      if (t.cik) {
        cikMap.set(t.ticker, t.cik);
      }
    }
  });
  insertBatch();

  onProgress?.({
    phase: "polygon",
    current: tickers.length,
    total: tickers.length,
    message: `已写入 ${tickers.length} 只 ticker 基础信息, 其中 ${cikMap.size} 只有 CIK`,
  });

  // Step 2: SEC 查 SIC
  const sicData = await fetchSECSicCodes(cikMap, onProgress);

  // 更新 SIC + sector
  const updateSic = db.prepare(`
    UPDATE ticker_info
    SET sic_code = ?, sic_description = ?, sector = ?, updated_at = ?
    WHERE ticker = ?
  `);

  const updateBatch = db.transaction(() => {
    for (const [ticker, info] of sicData) {
      const sector = sicToSector(info.sic);
      updateSic.run(info.sic, info.sicDesc, sector, now, ticker);
    }
  });
  updateBatch();

  return { total: tickers.length, withSic: sicData.size };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

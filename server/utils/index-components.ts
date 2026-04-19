/**
 * 指数成分股管理
 *
 * 从 Wikipedia 爬取 S&P 500 和 NASDAQ-100 成分股列表
 * 存入 index_components 表供 screener 过滤
 */
import type Database from "better-sqlite3";

// Wikipedia 页面中的表格解析
const WIKI_URLS: Record<string, string> = {
  sp500: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
  nasdaq100: "https://en.wikipedia.org/wiki/Nasdaq-100",
};

interface ComponentStock {
  ticker: string;
  companyName: string;
}

/**
 * 从 HTML 中提取表格数据
 * Wikipedia 的 SP500 页面第一个表格的第一列是 ticker，第二列是公司名
 * NASDAQ-100 页面结构类似
 */
function parseWikiTable(html: string, indexName: string): ComponentStock[] {
  const stocks: ComponentStock[] = [];

  // 找到 wikitable 类的表格
  const tableRegex = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  const tables: string[] = [];
  let match;
  while ((match = tableRegex.exec(html)) !== null) {
    tables.push(match[1]);
  }

  if (tables.length === 0) return stocks;

  // SP500: 第一个表格；NASDAQ100: 第四个表格（成分股列表）
  let targetTable: string;
  if (indexName === "nasdaq100") {
    // NASDAQ-100 的成分股表格通常是第4个 wikitable
    targetTable = tables.length >= 4 ? tables[3] : tables[tables.length - 1];
  } else {
    targetTable = tables[0];
  }

  // 解析行
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[] = [];
  while ((match = rowRegex.exec(targetTable)) !== null) {
    rows.push(match[1]);
  }

  // 跳过表头
  for (let i = 1; i < rows.length; i++) {
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const cells: string[] = [];
    while ((match = cellRegex.exec(rows[i])) !== null) {
      // 清除 HTML 标签，保留文本
      const text = match[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#160;/g, " ")
        .replace(/\n/g, "")
        .trim();
      cells.push(text);
    }

    if (cells.length >= 2) {
      const ticker = cells[0].trim().replace(/\s+/g, "");
      const companyName = cells[1].trim();

      if (ticker && /^[A-Z./-]+$/i.test(ticker) && ticker.length <= 10) {
        // Wikipedia 用 BRK.B 但市场数据用 BRK-B 或 BRK.B，统一处理
        const normalizedTicker = ticker.replace(/\./g, "-");
        stocks.push({ ticker: normalizedTicker, companyName });
      }
    }
  }

  return stocks;
}

/**
 * 从 Wikipedia 获取指数成分股
 */
async function fetchFromWikipedia(indexName: string): Promise<ComponentStock[]> {
  const url = WIKI_URLS[indexName];
  if (!url) throw new Error(`Unknown index: ${indexName}`);

  const resp = await $fetch<string>(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StockScreener/1.0)",
      Accept: "text/html",
    },
    responseType: "text",
    timeout: 30_000,
  });

  return parseWikiTable(resp, indexName);
}

/**
 * 刷新指定指数的成分股到数据库
 */
export async function refreshIndexComponents(
  db: Database.Database,
  indexName: string
): Promise<{ count: number; indexName: string }> {
  console.log(`[Index] 开始刷新 ${indexName} 成分股...`);

  const stocks = await fetchFromWikipedia(indexName);
  if (stocks.length === 0) {
    throw new Error(`Failed to parse ${indexName} components from Wikipedia`);
  }

  console.log(`[Index] ${indexName}: 解析到 ${stocks.length} 只股票`);

  // 清除旧数据并写入新数据
  const deleteStmt = db.prepare("DELETE FROM index_components WHERE index_name = ?");
  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO index_components (index_name, ticker, company_name, updated_at) VALUES (?, ?, ?, ?)"
  );

  const now = new Date().toISOString();

  db.transaction(() => {
    deleteStmt.run(indexName);
    for (const s of stocks) {
      insertStmt.run(indexName, s.ticker, s.companyName, now);
    }
  })();

  console.log(`[Index] ${indexName}: 已写入 ${stocks.length} 只股票`);
  return { count: stocks.length, indexName };
}

/**
 * 刷新所有指数
 */
export async function refreshAllIndexComponents(
  db: Database.Database
): Promise<Array<{ count: number; indexName: string }>> {
  const results = [];
  for (const indexName of Object.keys(WIKI_URLS)) {
    try {
      const r = await refreshIndexComponents(db, indexName);
      results.push(r);
    } catch (err: any) {
      console.error(`[Index] ${indexName} 刷新失败: ${err?.message}`);
      results.push({ count: 0, indexName });
    }
  }
  return results;
}

/**
 * 获取指定指数的 ticker 集合（用于 screener 过滤）
 */
export function getIndexTickers(
  db: Database.Database,
  indexNames: string[]
): Set<string> {
  if (indexNames.length === 0) return new Set();

  const placeholders = indexNames.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT DISTINCT ticker FROM index_components WHERE index_name IN (${placeholders})`)
    .all(...indexNames) as Array<{ ticker: string }>;

  return new Set(rows.map((r) => r.ticker));
}

/**
 * 获取所有指数的统计信息
 */
export function getIndexStats(
  db: Database.Database
): Array<{ index_name: string; count: number; updated_at: string | null }> {
  return db
    .prepare(
      `SELECT index_name, COUNT(*) as count, MAX(updated_at) as updated_at
       FROM index_components GROUP BY index_name ORDER BY index_name`
    )
    .all() as Array<{ index_name: string; count: number; updated_at: string | null }>;
}

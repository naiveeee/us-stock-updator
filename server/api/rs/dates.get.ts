/**
 * GET /api/rs/dates
 * 获取有 RS 数据的交易日列表
 *
 * 优化策略：
 * - 完全不查 SQLite（WAL 膨胀时任何查询都会变慢）
 * - 从磁盘 JSON 文件读取（由 cron/worker 定期写入）
 * - 内存缓存 60 秒 + 文件读取兜底
 * - 零数据库依赖，永远不会被 backfill 阻塞
 *
 * 返回: { dates: string[], earliest, latest, count }
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// 内存缓存
let cachedResult: { dates: string[]; earliest: string | null; latest: string | null; count: number } | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 60 秒

// JSON 文件路径（与 db 同目录）
function getDatesFilePath(): string {
  const config = useRuntimeConfig();
  const dbPath = config.dbPath || "./data/stocks.db";
  return resolve(dbPath, "..", "rs-dates.json");
}

export default defineEventHandler(() => {
  const now = Date.now();

  // 缓存命中
  if (cachedResult && now - cacheTime < CACHE_TTL) {
    return cachedResult;
  }

  try {
    const filePath = getDatesFilePath();
    if (!existsSync(filePath)) {
      // 文件不存在时尝试从 DB 生成一次（启动时）
      return cachedResult || { dates: [], earliest: null, latest: null, count: 0 };
    }

    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { dates: string[] };
    const dates = data.dates || [];

    const result = {
      dates,
      earliest: dates[0] || null,
      latest: dates[dates.length - 1] || null,
      count: dates.length,
    };

    cachedResult = result;
    cacheTime = now;
    return result;
  } catch (e: any) {
    // 文件读取/解析失败时返回缓存
    if (cachedResult) {
      return cachedResult;
    }
    return { dates: [], earliest: null, latest: null, count: 0 };
  }
});

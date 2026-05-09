/**
 * RS Dates 缓存文件管理
 *
 * 将 fetch_progress 中已 done 的日期列表写入 JSON 文件，
 * 供 dates API 直接读取（无需访问 SQLite，彻底避免 WAL 阻塞）
 *
 * 由 cron 插件启动时调用一次 + backfill worker 定期更新
 */
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

let _filePath: string | null = null;

export function getRsDatesFilePath(): string {
  if (_filePath) return _filePath;
  const config = useRuntimeConfig();
  const dbPath = config.dbPath || "./data/stocks.db";
  _filePath = resolve(dbPath, "..", "rs-dates.json");
  return _filePath;
}

/**
 * 从数据库读取 done 日期并写入 JSON 文件
 * 仅在 WAL 不忙时调用（如启动时、checkpoint 后）
 */
export function refreshRsDatesFile(db: any): boolean {
  try {
    const rows = db
      .prepare("SELECT date FROM fetch_progress WHERE status = 'done' ORDER BY date ASC")
      .all() as { date: string }[];

    const dates = rows.map((r: any) => r.date);
    const filePath = getRsDatesFilePath();
    writeFileSync(filePath, JSON.stringify({ dates, updatedAt: new Date().toISOString() }));
    return true;
  } catch (e: any) {
    console.error(`[RS-Dates-Cache] 写入失败: ${e?.message || e}`);
    return false;
  }
}

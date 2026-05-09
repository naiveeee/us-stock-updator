/**
 * 预计算统计管理
 *
 * 解决问题：daily_bars 表 3900 万+ 行，COUNT(*) 和 COUNT(DISTINCT ticker)
 * 在冷启动（OS 页缓存被回收）时需要 20-25 秒全表扫描。
 *
 * 方案：用 db_stats KV 表存储预计算值，status 接口直接读取（O(1)）。
 * 统计在以下时机更新：
 *   1. 服务启动时后台异步刷新（不阻塞请求）
 *   2. 每次采集完成后增量更新
 */

interface DbStats {
  totalRecords: number;
  uniqueTickers: number;
  minDate: string | null;
  maxDate: string | null;
  updatedAt: number; // timestamp ms
}

// 内存缓存（进程生命周期内有效）
let _cached: DbStats | null = null;

/**
 * 从 db_stats 表快速读取（O(1)，微秒级）
 */
export function getDbStats(): DbStats | null {
  if (_cached) return _cached;

  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM db_stats")
    .all() as { key: string; value: string }[];

  if (rows.length === 0) return null;

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  _cached = {
    totalRecords: parseInt(map.total_records || "0", 10),
    uniqueTickers: parseInt(map.unique_tickers || "0", 10),
    minDate: map.min_date || null,
    maxDate: map.max_date || null,
    updatedAt: parseInt(map.updated_at || "0", 10),
  };

  return _cached;
}

/**
 * 全量重新计算统计（慢，但只在后台执行）
 */
export function refreshDbStats(): DbStats {
  const db = getDb();

  const totalRow = db
    .prepare("SELECT COUNT(*) as c FROM daily_bars")
    .get() as { c: number };

  const tickerRow = db
    .prepare("SELECT COUNT(DISTINCT ticker) as c FROM daily_bars")
    .get() as { c: number };

  const minDate = db
    .prepare("SELECT date FROM daily_bars ORDER BY date ASC LIMIT 1")
    .get() as { date: string } | undefined;

  const maxDate = db
    .prepare("SELECT date FROM daily_bars ORDER BY date DESC LIMIT 1")
    .get() as { date: string } | undefined;

  const stats: DbStats = {
    totalRecords: totalRow?.c || 0,
    uniqueTickers: tickerRow?.c || 0,
    minDate: minDate?.date || null,
    maxDate: maxDate?.date || null,
    updatedAt: Date.now(),
  };

  saveStats(stats);
  _cached = stats;
  return stats;
}

/**
 * 增量更新：采集完一天数据后调用
 * 只更新 totalRecords 和日期范围（O(1) 无查询）
 * uniqueTickers 变化极慢，仅在后台全量刷新时更新
 *
 * @param addedRecords 本次新增的记录数
 * @param date 采集的日期
 */
export function incrementDbStats(addedRecords: number, date: string): void {
  const current = getDbStats();
  if (!current) {
    // 还没有统计数据，后台全量刷新
    setImmediate(() => {
      try { refreshDbStats(); } catch (_) {}
    });
    return;
  }

  const stats: DbStats = {
    totalRecords: current.totalRecords + addedRecords,
    uniqueTickers: current.uniqueTickers, // 保持不变，等后台全量刷新
    minDate: !current.minDate || date < current.minDate ? date : current.minDate,
    maxDate: !current.maxDate || date > current.maxDate ? date : current.maxDate,
    updatedAt: Date.now(),
  };

  saveStats(stats);
  _cached = stats;
}

/**
 * 持久化统计到 db_stats 表
 */
function saveStats(stats: DbStats): void {
  const db = getDb();
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO db_stats (key, value) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    upsert.run("total_records", String(stats.totalRecords));
    upsert.run("unique_tickers", String(stats.uniqueTickers));
    upsert.run("min_date", stats.minDate || "");
    upsert.run("max_date", stats.maxDate || "");
    upsert.run("updated_at", String(stats.updatedAt));
  });

  tx();
}

/**
 * 后台异步刷新（不阻塞事件循环）
 * 在服务启动时调用，如果 db_stats 为空则全量计算
 */
export function scheduleStatsRefresh(): void {
  const existing = getDbStats();
  if (existing && Date.now() - existing.updatedAt < 24 * 60 * 60 * 1000) {
    // 24 小时内刷新过，不需要重新计算
    console.log(`[DbStats] 使用缓存统计: ${existing.totalRecords} records, ${existing.uniqueTickers} tickers`);
    return;
  }

  console.log("[DbStats] 后台刷新统计中...");
  // 在下一个 tick 执行，不阻塞启动
  setImmediate(() => {
    try {
      const stats = refreshDbStats();
      console.log(`[DbStats] 统计刷新完成: ${stats.totalRecords} records, ${stats.uniqueTickers} tickers`);
    } catch (e: any) {
      console.error(`[DbStats] 统计刷新失败: ${e?.message || e}`);
    }
  });
}

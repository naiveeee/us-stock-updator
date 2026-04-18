/**
 * POST /api/pipeline/daily
 *
 * 手动触发「采集今天 + 增量流水线」
 * 等同于 cron 自动做的事，但可以随时手动跑
 */
import { getDb } from "../../utils/db";
import { fetchGroupedDaily } from "../../utils/massive";
import { runPipeline } from "../../utils/pipeline";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}));
  const dateOverride = body?.date; // 可选: 指定日期

  const config = useRuntimeConfig();
  const apiKey = config.massiveApiKey;

  if (!apiKey) {
    throw createError({ statusCode: 500, message: "MASSIVE_API_KEY 未配置" });
  }

  // 默认采集今天（美东时间）
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const dateStr =
    dateOverride ||
    `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, "0")}-${String(etNow.getDate()).padStart(2, "0")}`;

  const db = getDb();

  // Step 1: 采集
  let fetchCount = 0;
  const existing = db
    .prepare("SELECT status FROM fetch_progress WHERE date = ?")
    .get(dateStr) as { status: string } | undefined;

  if (existing && (existing.status === "done" || existing.status === "empty")) {
    fetchCount = 0; // 已采集
  } else {
    try {
      const data = await fetchGroupedDaily(dateStr, apiKey);
      const results = data.results || [];

      if (results.length === 0) {
        db.prepare(
          "INSERT OR REPLACE INTO fetch_progress (date, status, result_count, fetched_at, http_status) VALUES (?, 'empty', 0, ?, 200)"
        ).run(dateStr, new Date().toISOString());
      } else {
        const insertBar = db.prepare(`
          INSERT OR REPLACE INTO daily_bars
          (ticker, date, open, high, low, close, volume, vwap, num_trades, is_otc, timestamp_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertProgress = db.prepare(`
          INSERT OR REPLACE INTO fetch_progress
          (date, status, result_count, fetched_at, http_status)
          VALUES (?, 'done', ?, ?, 200)
        `);

        db.transaction(() => {
          for (const r of results) {
            if (!r.T) continue;
            insertBar.run(
              r.T, dateStr,
              r.o ?? null, r.h ?? null, r.l ?? null, r.c ?? null,
              r.v ?? null, r.vw ?? null, r.n ?? null,
              r.otc ? 1 : 0, r.t ?? null
            );
          }
          insertProgress.run(dateStr, results.length, new Date().toISOString());
        })();

        fetchCount = results.length;
      }
    } catch (err: any) {
      throw createError({
        statusCode: 502,
        message: `采集 ${dateStr} 失败: ${err?.message || err}`,
      });
    }
  }

  // Step 2: 增量流水线
  const pipelineResult = await runPipeline(db, {
    fullRebuild: false,
    triggerType: "manual_daily",
  });

  return {
    ok: true,
    date: dateStr,
    fetchCount,
    pipeline: pipelineResult,
  };
});

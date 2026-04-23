/**
 * POST /api/rs/backfill
 * 回填历史 RS Rating
 *
 * Body: { startDate?: string, endDate?: string }
 */
import { backfillRS } from "../../utils/rs-rating";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}));
  const db = getDb();

  const startDate = body?.startDate as string | undefined;
  const endDate = body?.endDate as string | undefined;

  console.log(`[RS Backfill] 开始回填...`, { startDate, endDate });
  const startTime = Date.now();

  let lastLog = "";
  const processed = backfillRS(db, startDate, endDate, (date, index, total, count) => {
    lastLog = `[RS Backfill] ${index}/${total} ${date}: ${count} tickers`;
    // 每 10 天打一条日志
    if (index % 10 === 0 || index === total) {
      console.log(lastLog);
    }
  });

  const durationMs = Date.now() - startTime;
  console.log(`[RS Backfill] 完成: ${processed} 天, 耗时 ${(durationMs / 1000).toFixed(1)}s`);

  return {
    status: "done",
    processed,
    durationMs,
    message: `回填完成: ${processed} 个交易日, 耗时 ${(durationMs / 1000).toFixed(1)}s`,
  };
});

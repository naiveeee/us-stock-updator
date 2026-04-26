/**
 * POST /api/rs/backfill
 * 启动后台回填历史 RS Rating（异步，立即返回）
 *
 * Body: { startDate?: string, endDate?: string }
 */
import { backfillRS } from "../../utils/rs-rating";

// 回填状态（进程内单例）
interface BackfillState {
  running: boolean;
  current: string;
  processed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  durationMs: number;
}

const state: BackfillState = {
  running: false,
  current: "",
  processed: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  durationMs: 0,
};

export function getBackfillState(): BackfillState {
  return { ...state };
}

export default defineEventHandler(async (event) => {
  if (state.running) {
    return {
      status: "already_running",
      message: "回填任务正在运行中",
      ...state,
    };
  }

  const body = await readBody(event).catch(() => ({}));
  const db = getDb();

  const startDate = body?.startDate as string | undefined;
  const endDate = body?.endDate as string | undefined;

  // 重置状态
  state.running = true;
  state.current = "";
  state.processed = 0;
  state.total = 0;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.durationMs = 0;

  console.log(`[RS Backfill] 开始回填...`, { startDate, endDate });
  const startTime = Date.now();

  // 后台异步执行，用 setTimeout 确保 response 先发出
  setTimeout(async () => {
    try {
      const processed = await backfillRS(db, startDate, endDate, (date, index, total, count) => {
        state.current = date;
        state.processed = index;
        state.total = total;
        // 每 10 天打一条日志
        if (index % 10 === 0 || index === total) {
          console.log(`[RS Backfill] ${index}/${total} ${date}: ${count} tickers`);
        }
      });

      state.durationMs = Date.now() - startTime;
      state.processed = processed;
      state.finishedAt = new Date().toISOString();
      console.log(`[RS Backfill] 完成: ${processed} 天, 耗时 ${(state.durationMs / 1000).toFixed(1)}s`);
    } catch (err: any) {
      state.error = err?.message || String(err);
      state.durationMs = Date.now() - startTime;
      state.finishedAt = new Date().toISOString();
      console.error(`[RS Backfill] 失败: ${state.error}`);
    } finally {
      state.running = false;
    }
  });

  // 立即返回
  return {
    status: "started",
    message: "回填任务已启动，后台运行中。请通过 GET /api/rs/backfill-status 查看进度。",
  };
});

/**
 * RS 回填状态（进程内单例）
 * 
 * 独立为 utils 模块，避免 API 路由之间的跨路由导入
 */

export interface BackfillState {
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

export function updateBackfillState(patch: Partial<BackfillState>): void {
  Object.assign(state, patch);
}

export function resetBackfillState(startedAt: string): void {
  state.running = true;
  state.current = "";
  state.processed = 0;
  state.total = 0;
  state.startedAt = startedAt;
  state.finishedAt = null;
  state.error = null;
  state.durationMs = 0;
}

/**
 * 流水线编排
 *
 * 完整流程: 周线聚合 → 选股扫描
 * （采集由外部触发或 cron 完成，这里只负责后续计算）
 */
import type Database from "better-sqlite3";
import { rebuildAllWeekly, updateRecentWeekly } from "./weekly";
import { runScreenerScan } from "./screener";

// ============================================================
// 流水线状态
// ============================================================

export interface PipelineState {
  running: boolean;
  stage: "idle" | "aggregate" | "scan" | "done" | "error";
  progress: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  lastResult: {
    stocksProcessed: number;
    leftSignals: number;
    rightSignals: number;
    durationMs: number;
    preFilterTotal?: number;
    preFilterPassed?: number;
  } | null;
}

const state: PipelineState = {
  running: false,
  stage: "idle",
  progress: "",
  startedAt: null,
  finishedAt: null,
  error: null,
  lastResult: null,
};

export function getPipelineState(): PipelineState {
  return { ...state, lastResult: state.lastResult ? { ...state.lastResult } : null };
}

// ============================================================
// 执行流水线
// ============================================================

/**
 * 运行完整流水线（周线聚合 + 选股扫描）
 * @param fullRebuild 是否全量重建周线（首次或数据修复时用）
 */
export async function runPipeline(
  db: Database.Database,
  options: {
    fullRebuild?: boolean;
    scanOnly?: boolean;
    triggerType?: string;
  } = {}
): Promise<string> {
  if (state.running) {
    return "already_running";
  }

  const { fullRebuild = false, scanOnly = false, triggerType = "manual" } = options;

  state.running = true;
  state.stage = "aggregate";
  state.progress = "";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;

  const t0 = Date.now();
  const scanDate = new Date().toISOString().slice(0, 10);

  try {
    let stocksProcessed = 0;

    // ── 阶段 1: 周线聚合 ──
    if (!scanOnly) {
      state.stage = "aggregate";
      state.progress = fullRebuild ? "全量重建周线..." : "增量更新周线...";

      if (fullRebuild) {
        stocksProcessed = rebuildAllWeekly(db);
      } else {
        stocksProcessed = updateRecentWeekly(db, 2);
      }

      state.progress = `周线聚合完成: ${stocksProcessed} 个股票`;
    }

    // ── 阶段 2: 选股扫描 ──
    state.stage = "scan";
    state.progress = "选股扫描中...";

    const scanResult = runScreenerScan(db, scanDate);

    // ── 完成 ──
    const durationMs = Date.now() - t0;
    state.stage = "done";
    state.finishedAt = new Date().toISOString();
    state.progress = `完成: 左侧 ${scanResult.leftCount} 信号, 右侧 ${scanResult.rightCount} 信号`;
    state.lastResult = {
      stocksProcessed,
      leftSignals: scanResult.leftCount,
      rightSignals: scanResult.rightCount,
      durationMs,
      preFilterTotal: scanResult.preFilterStats?.total,
      preFilterPassed: scanResult.preFilterStats?.passed,
    };

    // 记录到 pipeline_runs 表
    db.prepare(`
      INSERT INTO pipeline_runs
      (run_date, trigger_type, stage, stocks_processed, signals_found, started_at, finished_at, duration_ms)
      VALUES (?, ?, 'done', ?, ?, ?, ?, ?)
    `).run(
      scanDate,
      triggerType,
      stocksProcessed,
      scanResult.leftCount + scanResult.rightCount,
      state.startedAt,
      state.finishedAt,
      durationMs
    );

    console.log(
      `[Pipeline] 完成: ${stocksProcessed} 股票聚合, ${scanResult.preFilterStats?.passed ?? '?'}/${scanResult.preFilterStats?.total ?? '?'} 通过预筛选, ${scanResult.leftCount}L + ${scanResult.rightCount}R 信号, ${(durationMs / 1000).toFixed(1)}s`
    );

    return "done";
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    state.stage = "error";
    state.error = err?.message || String(err);
    state.finishedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO pipeline_runs
      (run_date, trigger_type, stage, started_at, finished_at, error_msg, duration_ms)
      VALUES (?, ?, 'error', ?, ?, ?, ?)
    `).run(
      scanDate,
      triggerType,
      state.startedAt,
      state.finishedAt,
      state.error,
      durationMs
    );

    console.error("[Pipeline] 错误:", err);
    return "error";
  } finally {
    state.running = false;
  }
}

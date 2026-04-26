/**
 * POST /api/rs/backfill
 * 启动后台回填历史 RS Rating
 *
 * 通过 child_process.fork() 在独立子进程中执行 CPU 密集计算，
 * 主进程事件循环完全不受影响。
 *
 * Body: { startDate?: string, endDate?: string }
 */
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

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

let workerProcess: ChildProcess | null = null;

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

  // 获取数据库文件路径
  const config = useRuntimeConfig();
  const dbPath = resolve(config.dbPath || "./data/stocks.db");

  // 重置状态
  state.running = true;
  state.current = "";
  state.processed = 0;
  state.total = 0;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.durationMs = 0;

  console.log(`[RS Backfill] 启动子进程回填...`, { startDate, endDate, dbPath });

  // 找到 worker 脚本路径（相对于项目根目录）
  // 在 production 模式下，cwd 是项目根目录
  const workerPath = resolve(process.cwd(), "scripts/rs-backfill-worker.js");

  try {
    workerProcess = fork(workerPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    workerProcess.on("message", (msg: any) => {
      if (msg.type === "ready") {
        // Worker 准备好了，发送启动指令
        workerProcess!.send({
          type: "start",
          dbPath,
          startDate,
          endDate,
        });
      } else if (msg.type === "progress") {
        state.current = msg.date;
        state.processed = msg.index;
        state.total = msg.total;
        if (msg.index % 10 === 0 || msg.index === msg.total) {
          console.log(
            `[RS Backfill] ${msg.index}/${msg.total} ${msg.date}: ${msg.count} tickers`
          );
        }
      } else if (msg.type === "done") {
        state.durationMs = msg.durationMs;
        state.processed = msg.processed;
        state.finishedAt = new Date().toISOString();
        state.running = false;
        workerProcess = null;
        console.log(
          `[RS Backfill] 完成: ${msg.processed} 天, 耗时 ${(msg.durationMs / 1000).toFixed(1)}s`
        );
      } else if (msg.type === "error") {
        state.error = msg.message;
        state.durationMs = Date.now() - new Date(state.startedAt!).getTime();
        state.finishedAt = new Date().toISOString();
        state.running = false;
        workerProcess = null;
        console.error(`[RS Backfill] 子进程错误: ${msg.message}`);
      }
    });

    workerProcess.on("error", (err) => {
      state.error = err.message;
      state.durationMs = Date.now() - new Date(state.startedAt!).getTime();
      state.finishedAt = new Date().toISOString();
      state.running = false;
      workerProcess = null;
      console.error(`[RS Backfill] 子进程启动失败: ${err.message}`);
    });

    workerProcess.on("exit", (code) => {
      if (state.running) {
        // 非正常退出
        state.error = `子进程异常退出，exit code: ${code}`;
        state.durationMs = Date.now() - new Date(state.startedAt!).getTime();
        state.finishedAt = new Date().toISOString();
        state.running = false;
        workerProcess = null;
        console.error(`[RS Backfill] 子进程异常退出: code=${code}`);
      }
    });

    // stdout/stderr 转发到主进程日志
    workerProcess.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[RS Worker] ${data}`);
    });
    workerProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[RS Worker ERR] ${data}`);
    });
  } catch (err: any) {
    state.error = err.message || String(err);
    state.running = false;
    console.error(`[RS Backfill] 启动子进程失败: ${state.error}`);
    return {
      status: "error",
      message: state.error,
    };
  }

  // 立即返回
  return {
    status: "started",
    message: "回填任务已启动（独立子进程），后台运行中。请通过 GET /api/rs/backfill-status 查看进度。",
  };
});

/**
 * GET /api/rs/backfill-status
 * 查询回填进度
 *
 * 通过共享内存模块获取状态，避免跨路由导入
 */
import { getBackfillState } from "~/server/utils/backfill-state";

export default defineEventHandler(() => {
  return getBackfillState();
});

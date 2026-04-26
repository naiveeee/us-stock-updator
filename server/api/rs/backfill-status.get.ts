/**
 * GET /api/rs/backfill-status
 * 查询回填进度
 */
import { getBackfillState } from "./backfill.post";

export default defineEventHandler(() => {
  return getBackfillState();
});

/**
 * GET /api/ticker-info/status
 * 查询 ticker info 拉取任务的当前状态和进度
 */
import { getTickerInfoStatus } from "../../utils/ticker-info";

export default defineEventHandler(() => {
  return getTickerInfoStatus();
});

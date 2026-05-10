import { getDb } from "~/server/utils/db";

const SEC_USER_AGENT =
  "us-stock-updator admin@example.com";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sicToSector(sic: string): string {
  const code = parseInt(sic, 10);
  if (isNaN(code)) return "Unknown";
  if (code < 1000) return "Agriculture";
  if (code < 1500) return "Mining";
  if (code < 1800) return "Construction";
  if (code < 4000) return "Manufacturing";
  if (code < 5000) return "Transportation & Utilities";
  if (code < 5200) return "Wholesale Trade";
  if (code < 6000) return "Retail Trade";
  if (code < 6800) return "Finance & Insurance";
  if (code < 9000) return "Services";
  return "Public Administration";
}

/**
 * POST /api/ticker-info/sec-sic
 *
 * 只跑 SEC SIC 补充阶段：
 * 从数据库中找出有 CIK 但没有 sic_code 的 ticker，逐个查 SEC 获取 SIC
 */
export default defineEventHandler(async (event) => {
  const db = getDb();

  // 找出有 CIK 但没有 SIC 的 ticker
  const rows = db
    .prepare(
      `SELECT ticker, cik FROM ticker_info
       WHERE cik IS NOT NULL AND cik != ''
       AND (sic_code IS NULL OR sic_code = '')`
    )
    .all() as { ticker: string; cik: string }[];

  if (rows.length === 0) {
    return { message: "所有有 CIK 的 ticker 都已有 SIC 信息", total: 0, success: 0 };
  }

  // 异步执行，不阻塞响应
  const total = rows.length;

  // 同步返回启动信息，后台开始跑
  runSecSicBackfill(rows).catch((err) => {
    console.error("[SEC-SIC] 回填失败:", err?.message || err);
  });

  return {
    message: `已启动 SEC SIC 回填，共 ${total} 只 ticker 待处理`,
    total,
  };
});

async function runSecSicBackfill(
  rows: { ticker: string; cik: string }[]
) {
  const db = getDb();
  const total = rows.length;
  const BATCH_SIZE = 5;
  const BATCH_DELAY = 1100;

  const updateSic = db.prepare(`
    UPDATE ticker_info
    SET sic_code = ?, sic_description = ?, sector = ?, updated_at = ?
    WHERE ticker = ?
  `);

  let success = 0;
  let failed = 0;

  console.log(`[SEC-SIC] 开始回填 ${total} 只 ticker 的 SIC 信息...`);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    if (i % 500 === 0) {
      console.log(`[SEC-SIC] 进度: ${i}/${total} (成功: ${success}, 失败: ${failed})`);
    }

    const promises = batch.map(async ({ ticker, cik }) => {
      try {
        const paddedCik = cik.padStart(10, "0");
        const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
        const data = await $fetch<any>(url, {
          timeout: 10_000,
          headers: { "User-Agent": SEC_USER_AGENT },
        });
        if (data?.sic) {
          const now = new Date().toISOString();
          const sector = sicToSector(data.sic);
          updateSic.run(data.sic, data.sicDescription || "", sector, now, ticker);
          success++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    });

    await Promise.all(promises);
    await sleep(BATCH_DELAY);
  }

  console.log(
    `[SEC-SIC] 回填完成: 总计 ${total}, 成功 ${success}, 失败 ${failed}`
  );
}

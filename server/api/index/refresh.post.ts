/**
 * POST /api/index/refresh
 *
 * 刷新指数成分股（从 Wikipedia 爬取）
 * Body: { index?: 'sp500' | 'nasdaq100' | 'all' }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}));
  const indexName = (body?.index as string) || "all";

  const db = getDb();

  if (indexName === "all") {
    const results = await refreshAllIndexComponents(db);
    return {
      ok: true,
      results,
      stats: getIndexStats(db),
    };
  }

  if (!["sp500", "nasdaq100"].includes(indexName)) {
    throw createError({
      statusCode: 400,
      message: 'index must be "sp500", "nasdaq100", or "all"',
    });
  }

  const result = await refreshIndexComponents(db, indexName);
  return {
    ok: true,
    results: [result],
    stats: getIndexStats(db),
  };
});

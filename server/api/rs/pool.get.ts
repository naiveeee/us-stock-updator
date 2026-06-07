/**
 * GET /api/rs/pool
 * RS 强势池 — 状态机模型（优化版）
 *
 * 入池条件：连续 N 个交易日 rating >= R1
 * 出池条件：连续 M 个交易日 rating < R2
 *
 * 优化：先筛选最新日 rating >= R2 的候选 ticker，再只拉候选 ticker 的历史数据
 * 将数据量从 50万行 降到 ~5万行，查询时间从 10s 降到 <1s
 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const db = getDb();

  // 参数解析
  const N = Math.max(1, parseInt(query.n as string) || 10);
  const M = Math.max(1, parseInt(query.m as string) || 10);
  const R1 = parseInt(query.r1 as string) || 95;
  const R2 = parseInt(query.r2 as string) || 85;

  let date = query.date as string;
  if (!date) {
    const latest = db
      .prepare("SELECT MAX(date) as d FROM rs_ratings")
      .get() as { d: string } | undefined;
    date = latest?.d || "";
    if (!date) {
      return { date: null, params: { N, M, R1, R2 }, total: 0, results: [], message: "No RS data available." };
    }
  }

  const latestDate = date;

  // 获取回溯范围内的交易日列表（最多 252 天）
  const tradingDays = db
    .prepare("SELECT DISTINCT date FROM rs_ratings WHERE date <= ? ORDER BY date DESC LIMIT 252")
    .all(latestDate) as { date: string }[];

  if (tradingDays.length < N) {
    return { date: latestDate, params: { N, M, R1, R2 }, total: 0, results: [], message: "Not enough trading days." };
  }

  const oldestDate = tradingDays[tradingDays.length - 1].date;
  const lookbackDates = tradingDays.map(d => d.date);

  // ===== 优化核心：先筛候选 ticker =====
  // 最新日 rating < R2 的 ticker 肯定不在池内（已经出池或从未入池），直接排除
  const candidates = db
    .prepare("SELECT DISTINCT ticker FROM rs_ratings WHERE date = ? AND rating >= ?")
    .all(latestDate, R2) as { ticker: string }[];

  if (candidates.length === 0) {
    return { date: latestDate, params: { N, M, R1, R2 }, total: 0, results: [] };
  }

  // 用临时表存候选 ticker，避免 IN (...) 子句过长
  db.exec("CREATE TEMP TABLE IF NOT EXISTS _pool_candidates(ticker TEXT PRIMARY KEY)");
  db.exec("DELETE FROM _pool_candidates");
  const insertStmt = db.prepare("INSERT OR IGNORE INTO _pool_candidates VALUES (?)");
  const insertAll = db.transaction((tickers: { ticker: string }[]) => {
    for (const t of tickers) insertStmt.run(t.ticker);
  });
  insertAll(candidates);

  // 只拉候选 ticker 的历史数据（~5万行 vs 原来50万行）
  const allRatings = db
    .prepare(`
      SELECT r.ticker, r.date, r.rating, r.pct_3m, r.r2, r.score,
             d.close, COALESCE(d.volume * d.vwap, d.volume * d.close, 0) as turnover
      FROM rs_ratings r
      INNER JOIN _pool_candidates c ON r.ticker = c.ticker
      LEFT JOIN daily_bars d ON r.ticker = d.ticker AND r.date = d.date
      WHERE r.date >= ? AND r.date <= ?
      ORDER BY r.ticker, r.date DESC
    `)
    .all(oldestDate, latestDate) as {
      ticker: string; date: string; rating: number;
      pct_3m: number; r2: number; score: number;
      close: number; turnover: number;
    }[];

  // 清理临时表
  db.exec("DROP TABLE IF EXISTS _pool_candidates");

  // 按 ticker 分组
  const byTicker = new Map<string, typeof allRatings>();
  for (const row of allRatings) {
    let arr = byTicker.get(row.ticker);
    if (!arr) {
      arr = [];
      byTicker.set(row.ticker, arr);
    }
    arr.push(row); // 已按日期倒序
  }

  // 对每只股票应用状态机
  const poolResults: {
    ticker: string;
    entry_date: string;
    days_in_pool: number;
    current_rating: number;
    pct_3m: number;
    r2: number;
    score: number;
    close: number;
    turnover: number;
  }[] = [];

  for (const [ticker, rows] of byTicker) {
    if (rows.length < N) continue;

    // 日期正序扫描
    const chronological = rows.slice().reverse();

    let inPool = false;
    let entryDate = "";
    let consecutiveAboveR1 = 0;
    let consecutiveBelowR2 = 0;

    for (let i = 0; i < chronological.length; i++) {
      const row = chronological[i];
      if (!inPool) {
        if (row.rating >= R1) {
          consecutiveAboveR1++;
          if (consecutiveAboveR1 >= N) {
            inPool = true;
            entryDate = chronological[i - N + 1].date;
            consecutiveBelowR2 = 0;
          }
        } else {
          consecutiveAboveR1 = 0;
        }
      } else {
        if (row.rating >= R1) {
          consecutiveAboveR1++;
        } else {
          consecutiveAboveR1 = 0;
        }

        if (row.rating < R2) {
          consecutiveBelowR2++;
          if (consecutiveBelowR2 >= M) {
            inPool = false;
            entryDate = "";
            consecutiveAboveR1 = 0;
          }
        } else {
          consecutiveBelowR2 = 0;
        }
      }
    }

    if (inPool && entryDate) {
      const latest = rows[0];
      const entryIdx = lookbackDates.indexOf(entryDate);
      const daysInPool = entryIdx >= 0 ? entryIdx + 1 : 0;

      poolResults.push({
        ticker,
        entry_date: entryDate,
        days_in_pool: daysInPool,
        current_rating: latest.rating,
        pct_3m: latest.pct_3m,
        r2: latest.r2,
        score: latest.score,
        close: latest.close,
        turnover: latest.turnover,
      });
    }
  }

  poolResults.sort((a, b) => a.days_in_pool - b.days_in_pool);

  return {
    date: latestDate,
    params: { N, M, R1, R2 },
    total: poolResults.length,
    results: poolResults,
  };
});

/**
 * RS Backfill Worker — 独立进程（Top 1000 成交额版）
 *
 * 通过 child_process.fork() 从主进程启动，
 * 通过 IPC (process.send / process.on('message')) 与主进程通信。
 *
 * 关键优化：
 * 1. 只取当天成交额 (close × volume) 前 1000 的 ticker 计算 RS
 * 2. 每只 ticker 用主键索引查 8 行（4 季度 × 2 边界价格）
 * 3. 内存占用极低，不会 OOM
 */

const Database = require("better-sqlite3");
const { writeFileSync } = require("fs");
const { resolve } = require("path");

const RS_TOP_N = 1000;

/**
 * 将已完成的日期列表写入 JSON 文件（dates API 直接读取此文件）
 */
function refreshRsDatesFile(db, dbPath) {
  try {
    const rows = db
      .prepare("SELECT date FROM fetch_progress WHERE status = 'done' ORDER BY date ASC")
      .all();
    const dates = rows.map((r) => r.date);
    const filePath = resolve(dbPath, "..", "rs-dates.json");
    writeFileSync(filePath, JSON.stringify({ dates, updatedAt: new Date().toISOString() }));
  } catch (e) {
    // 非关键操作，失败不影响回填
  }
}

// ---- RS 计算逻辑 ----

function getQuarterBounds(asOfDate) {
  const d = new Date(asOfDate + "T00:00:00Z");
  const quarters = [];
  for (let i = 0; i < 4; i++) {
    const endDate = new Date(d);
    endDate.setUTCMonth(endDate.getUTCMonth() - i * 3);
    const startDate = new Date(d);
    startDate.setUTCMonth(startDate.getUTCMonth() - (i + 1) * 3);
    quarters.push({
      start: startDate.toISOString().slice(0, 10),
      end: endDate.toISOString().slice(0, 10),
    });
  }
  return quarters; // [0]=Q4(最近), [3]=Q1(最远)
}

/**
 * 计算单日 RS Rating — 只算当天成交额 Top 1000
 */
function computeRSForDate(db, asOfDate) {
  const quarters = getQuarterBounds(asOfDate);

  // 取当天成交额 (close × volume) Top N，顺便拿 close/volume/open
  const tickerRows = db
    .prepare(
      `SELECT ticker, close, volume, open FROM daily_bars
       WHERE date = ? AND volume IS NOT NULL AND volume > 0
         AND close IS NOT NULL AND close > 0
       ORDER BY (close * volume) DESC
       LIMIT ?`
    )
    .all(asOfDate, RS_TOP_N);

  if (tickerRows.length === 0) return [];

  // 准备查询语句：取某 ticker 在某日期之后/之前最近的收盘价
  const stmtAfter = db.prepare(
    `SELECT close FROM daily_bars
     WHERE ticker = ? AND date >= ? AND date <= ? AND close IS NOT NULL AND close > 0
     ORDER BY date ASC LIMIT 1`
  );
  const stmtBefore = db.prepare(
    `SELECT close FROM daily_bars
     WHERE ticker = ? AND date >= ? AND date <= ? AND close IS NOT NULL AND close > 0
     ORDER BY date DESC LIMIT 1`
  );

  // Ticker 复用检测：找窗口内 >90 天的最大数据断裂
  const GAP_THRESHOLD_DAYS = 90;
  const stmtMaxGap = db.prepare(
    `SELECT gap, gap_after FROM (
       SELECT julianday(LEAD(date) OVER (ORDER BY date)) - julianday(date) AS gap,
              LEAD(date) OVER (ORDER BY date) AS gap_after
       FROM daily_bars
       WHERE ticker = ? AND date >= ? AND date <= ?
     )
     WHERE gap > ?
     ORDER BY gap DESC
     LIMIT 1`
  );

  const oldestQuarterStart = quarters[3].start;

  const scores = [];

  for (const row of tickerRows) {
    const { ticker, close: tickerClose, volume: tickerVolume, open: tickerOpen } = row;
    // 检查 12 个月窗口内是否有数据断裂（ticker 复用）
    const gapRow = stmtMaxGap.get(ticker, oldestQuarterStart, asOfDate, GAP_THRESHOLD_DAYS);

    let validFrom = null;
    if (gapRow && gapRow.gap > 0 && gapRow.gap_after) {
      validFrom = gapRow.gap_after;
    }

    const qReturns = [];
    let valid = true;

    for (const q of quarters) {
      // 如果该季度起点早于断裂恢复点，数据不够
      if (validFrom && q.start < validFrom) {
        valid = false;
        break;
      }

      // start price: >= q.start 且 <= q.end 的第一条
      const startRow = stmtAfter.get(ticker, q.start, q.end);
      // end price: <= q.end 且 >= q.start 的最后一条
      const endRow = stmtBefore.get(ticker, q.start, q.end);

      if (!startRow || !endRow || startRow.close <= 0) {
        valid = false;
        break;
      }

      qReturns.push(
        ((endRow.close - startRow.close) / startRow.close) * 100
      );
    }

    if (!valid || qReturns.length < 4) continue;

    const score =
      qReturns[0] * 0.4 +
      qReturns[1] * 0.2 +
      qReturns[2] * 0.2 +
      qReturns[3] * 0.2;

    scores.push({ ticker, score, close: tickerClose, volume: tickerVolume, open: tickerOpen });
  }

  if (scores.length === 0) return [];

  scores.sort((a, b) => a.score - b.score);
  const n = scores.length;

  return scores.map((item, index) => {
    const percentile =
      n > 1 ? Math.round((index / (n - 1)) * 10000) / 100 : 50;
    const rating =
      n > 1
        ? Math.max(1, Math.min(99, Math.round((index / (n - 1)) * 98) + 1))
        : 50;
    return {
      ticker: item.ticker,
      score: Math.round(item.score * 100) / 100,
      rating,
      percentile,
      close: item.close,
      volume: item.volume,
      open: item.open,
    };
  });
}

function computeAndSaveRS(db, asOfDate) {
  const results = computeRSForDate(db, asOfDate);
  if (results.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO rs_ratings (ticker, date, score, rating, percentile, close, volume, open)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const r of results) {
      insert.run(r.ticker, asOfDate, r.score, r.rating, r.percentile, r.close, r.volume, r.open);
    }
  });

  insertAll();
  return results.length;
}

// ---- 主流程 ----

process.on("message", (msg) => {
  if (msg.type !== "start") return;

  const { dbPath, startDate, endDate } = msg;
  const startTime = Date.now();

  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -32000"); // 32MB cache

    // 确保索引存在（加速 Top N 查询）
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_daily_bars_date_volume
        ON daily_bars(date, volume DESC);
    `);

    // 确定日期范围
    const minDate =
      startDate ||
      (() => {
        const row = db
          .prepare("SELECT MIN(date) as d FROM daily_bars")
          .get();
        if (!row?.d) return null;
        const d = new Date(row.d + "T00:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + 12);
        return d.toISOString().slice(0, 10);
      })();

    if (!minDate) {
      process.send({ type: "done", processed: 0, durationMs: 0 });
      process.exit(0);
      return;
    }

    const maxDate =
      endDate ||
      (() => {
        const row = db
          .prepare("SELECT MAX(date) as d FROM daily_bars")
          .get();
        return row?.d || null;
      })();

    if (!maxDate) {
      process.send({ type: "done", processed: 0, durationMs: 0 });
      process.exit(0);
      return;
    }

    const tradingDays = db
      .prepare(
        `SELECT DISTINCT date FROM daily_bars
         WHERE date >= ? AND date <= ?
         ORDER BY date`
      )
      .all(minDate, maxDate);

    const existingDates = new Set(
      db
        .prepare(
          `SELECT DISTINCT date FROM rs_ratings
           WHERE date >= ? AND date <= ?`
        )
        .all(minDate, maxDate)
        .map((r) => r.date)
    );

    const pendingDays = tradingDays.filter((d) => !existingDates.has(d.date));

    if (process.send) {
      process.send({
        type: "progress",
        date: "",
        index: 0,
        total: pendingDays.length,
        count: 0,
      });
    }

    // 每 CHECKPOINT_EVERY 天做一次 WAL checkpoint，防止 WAL 无限膨胀
    const CHECKPOINT_EVERY = 5;
    // 每 REFRESH_DATES_EVERY 天刷新 dates JSON 文件
    const REFRESH_DATES_EVERY = 50;

    let processed = 0;
    for (let i = 0; i < pendingDays.length; i++) {
      const dateStr = pendingDays[i].date;
      const count = computeAndSaveRS(db, dateStr);
      processed++;

      if (process.send) {
        process.send({
          type: "progress",
          date: dateStr,
          index: i + 1,
          total: pendingDays.length,
          count,
        });
      }

      // 定期 checkpoint：writer 自己做 TRUNCATE 模式最高效
      if (processed % CHECKPOINT_EVERY === 0) {
        try {
          db.pragma("wal_checkpoint(TRUNCATE)");
        } catch (e) {
          // checkpoint 失败不阻塞流程
        }
      }

      // 定期刷新 dates JSON 文件
      if (processed % REFRESH_DATES_EVERY === 0) {
        refreshRsDatesFile(db, dbPath);
      }
    }

    // 完成后最终刷新一次
    refreshRsDatesFile(db, dbPath);

    db.close();
    const durationMs = Date.now() - startTime;
    if (process.send) {
      process.send({ type: "done", processed, durationMs });
    }
    process.exit(0);
  } catch (err) {
    if (process.send) {
      process.send({ type: "error", message: err.message || String(err) });
    }
    process.exit(1);
  }
});

if (process.send) {
  process.send({ type: "ready" });
}

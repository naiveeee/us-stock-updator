/**
 * SQLite 数据库管理（基于 better-sqlite3）
 *
 * - 单例模式，整个 server 生命周期复用同一个连接
 * - WAL 模式 + 性能优化 pragma
 * - 自动建表（含选股系统新表）
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const config = useRuntimeConfig();
  const dbPath = resolve(config.dbPath || "./data/stocks.db");

  // 确保目录存在
  const dir = resolve(dbPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);

  // 性能优化
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("cache_size = -64000"); // 64MB
  _db.pragma("busy_timeout = 5000");

  // 建表 — 原有表
  _db.exec(`
    CREATE TABLE IF NOT EXISTS daily_bars (
      ticker       TEXT    NOT NULL,
      date         TEXT    NOT NULL,
      open         REAL,
      high         REAL,
      low          REAL,
      close        REAL,
      volume       REAL,
      vwap         REAL,
      num_trades   INTEGER,
      is_otc       INTEGER DEFAULT 0,
      timestamp_ms INTEGER,
      PRIMARY KEY (ticker, date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_bars_date
      ON daily_bars(date);
    CREATE INDEX IF NOT EXISTS idx_daily_bars_ticker
      ON daily_bars(ticker);

    CREATE TABLE IF NOT EXISTS fetch_progress (
      date         TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      error_msg    TEXT,
      fetched_at   TEXT,
      http_status  INTEGER DEFAULT 0
    );
  `);

  // 选股系统新增表
  _db.exec(`
    -- 周线数据（日线聚合）
    CREATE TABLE IF NOT EXISTS weekly_bars (
      ticker       TEXT NOT NULL,
      week_start   TEXT NOT NULL,
      week_end     TEXT NOT NULL,
      open         REAL,
      high         REAL,
      low          REAL,
      close        REAL,
      volume       REAL,
      vwap         REAL,
      num_trades   INTEGER,
      PRIMARY KEY (ticker, week_start)
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_bars_ticker
      ON weekly_bars(ticker);

    -- 选股结果
    CREATE TABLE IF NOT EXISTS screener_results (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_date    TEXT NOT NULL,
      scan_type    TEXT NOT NULL,
      ticker       TEXT NOT NULL,
      score        REAL NOT NULL,
      grade        TEXT NOT NULL,
      score_detail TEXT,
      latest_close REAL,
      latest_volume REAL,
      week_change_pct REAL,
      avg_dollar_volume REAL,
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(scan_date, scan_type, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_screener_date_type
      ON screener_results(scan_date, scan_type);

    -- 信号详情
    CREATE TABLE IF NOT EXISTS screener_signals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_date    TEXT NOT NULL,
      ticker       TEXT NOT NULL,
      signal_type  TEXT NOT NULL,
      side         TEXT NOT NULL,
      description  TEXT,
      value        REAL,
      max_value    REAL,
      week_date    TEXT,
      UNIQUE(scan_date, ticker, signal_type)
    );

    -- 流水线执行记录
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date     TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      stage        TEXT NOT NULL,
      stocks_processed INTEGER DEFAULT 0,
      signals_found INTEGER DEFAULT 0,
      started_at   TEXT,
      finished_at  TEXT,
      error_msg    TEXT,
      duration_ms  INTEGER DEFAULT 0
    );
  `);

  return _db;
}

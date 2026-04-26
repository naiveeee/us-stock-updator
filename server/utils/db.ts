/**
 * SQLite 数据库管理（基于 better-sqlite3）
 *
 * - 单例模式，整个 server 生命周期复用同一个连接
 * - WAL 模式 + 性能优化 pragma
 * - 自动建表
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

    -- RS Rating（IBD 相对强度评级）
    CREATE TABLE IF NOT EXISTS rs_ratings (
      ticker       TEXT NOT NULL,
      date         TEXT NOT NULL,
      score        REAL,           -- 加权原始得分
      rating       INTEGER,        -- 1-99 百分位排名（IBD 标准）
      percentile   REAL,           -- 0.00-100.00 精确百分位
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX IF NOT EXISTS idx_rs_ratings_date
      ON rs_ratings(date);
    CREATE INDEX IF NOT EXISTS idx_rs_ratings_ticker
      ON rs_ratings(ticker);

    -- Ticker 元数据（行业 / 交易所 / 市值）
    CREATE TABLE IF NOT EXISTS ticker_info (
      ticker            TEXT PRIMARY KEY,
      name              TEXT,              -- 公司名称
      primary_exchange  TEXT,              -- 交易所: XNAS / XNYS / ARCX ...
      sic_code          TEXT,              -- SIC 行业代码 (4位)
      sic_description   TEXT,              -- SIC 行业描述
      sector            TEXT,              -- 板块大类（由 SIC 前 2 位映射）
      cik               TEXT,              -- SEC CIK 编号
      market_cap        REAL,              -- 市值
      updated_at        TEXT               -- 最后更新时间
    );
    CREATE INDEX IF NOT EXISTS idx_ticker_info_sector
      ON ticker_info(sector);
    CREATE INDEX IF NOT EXISTS idx_ticker_info_sic
      ON ticker_info(sic_code);
  `);

  return _db;
}

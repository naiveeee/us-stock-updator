# US Stock Updator

美股日线数据采集 & RS 排名系统。基于 Nuxt 3 + SQLite 构建，提供数据采集、RS Rating 计算和可视化分析功能。

## 技术栈

| 组件 | 选型 |
|------|------|
| 框架 | Nuxt 3 (Nitro server engine) |
| 数据库 | SQLite (better-sqlite3, WAL mode) |
| 数据源 | Massive API (Polygon.io 替代) |
| 图表 | TradingView lightweight-charts |
| 进程管理 | PM2 |
| 运行环境 | Node.js >= 18 |

## 目录结构

```
us-stock-updator/
├── pages/                    # 前端页面
│   ├── index.vue            # 首页 - 数据概览
│   ├── rs.vue               # RS 排名列表
│   ├── admin.vue            # 管理面板
│   └── stock/
│       └── [ticker].vue     # 个股详情（价格 + RS 曲线）
├── server/
│   ├── api/
│   │   ├── fetch/           # 数据采集控制
│   │   │   ├── start.post.ts
│   │   │   ├── stop.post.ts
│   │   │   └── status.get.ts
│   │   ├── stocks/          # 行情查询
│   │   │   ├── daily.get.ts      # 单只股票历史日线
│   │   │   ├── snapshot.get.ts   # 全市场快照
│   │   │   └── tickers.get.ts    # Ticker 列表
│   │   ├── rs/              # RS Rating 系统
│   │   │   ├── ranking.get.ts        # RS 排名列表
│   │   │   ├── history.get.ts        # 单只股票 RS 历史
│   │   │   ├── dates.get.ts          # 有 RS 数据的日期列表
│   │   │   ├── backfill.post.ts      # 触发 RS 回填
│   │   │   └── backfill-status.get.ts # 回填进度查询
│   │   └── ticker-info/     # Ticker 元数据
│   │       ├── [ticker].get.ts   # 单只查询
│   │       ├── fetch.post.ts     # 批量拉取
│   │       ├── sec-sic.post.ts   # SEC SIC 补充
│   │       ├── sectors.get.ts    # 板块列表
│   │       ├── status.get.ts     # 拉取进度
│   │       └── sync.post.ts      # 同步 ticker 信息
│   ├── utils/
│   │   ├── db.ts                 # SQLite 连接管理
│   │   ├── db-stats.ts           # 预计算统计（避免全表扫描）
│   │   ├── fetcher.ts            # 数据采集核心逻辑
│   │   ├── massive.ts            # Massive API 封装
│   │   ├── rs-rating.ts          # RS Rating 计算引擎
│   │   ├── rs-dates-cache.ts     # RS 日期缓存
│   │   ├── backfill-state.ts     # 回填状态共享模块
│   │   ├── sector-map.ts         # SIC → 板块映射
│   │   └── ticker-info.ts        # Ticker 信息工具
│   └── plugins/
│       └── cron.ts               # 定时采集 + RS 计算
├── scripts/
│   ├── fetch.mjs                 # CLI 数据采集脚本
│   ├── rs-backfill-worker.js     # RS 回填子进程 Worker
│   └── status.mjs               # CLI 状态查询
├── mcp-server.ts                 # MCP Server 接口
├── ecosystem.config.cjs          # PM2 配置
├── nuxt.config.ts
├── package.json
└── tsconfig.json
```

## 核心功能

### 1. 数据采集

- **数据源**: Massive API（Polygon.io 兼容接口）
- **采集策略**: 按日期采集全市场 Grouped Daily OHLCV
- **定时任务**: 每个工作日美东 17:00 自动采集前一工作日数据
- **Gap 填充**: 启动时自动检测并补全缺失日期
- **增量统计**: 采集完成后自动更新 `db_stats` KV 表

### 2. RS Rating 系统

基于 IBD (Investor's Business Daily) 方法论的相对强度评级系统。

**计算方法**:
- 4 个季度加权评分：近 63 天 (×2)、64-126 天、127-189 天、190-252 天
- 评分 = 区间涨跌幅百分比
- 总分 = Q1×2 + Q2 + Q3 + Q4（共 5 份权重）
- Rating = 1-99 百分位排名

**月度池机制**:
- 每月第一个交易日，按上月日均成交额 (close × volume) 排名选取 Top 1000 只股票
- 池子数据存储在 `rs_pool` 表
- RS 计算和前端筛选均基于同一月度池，保证口径一致
- 池子采用懒初始化 (`ensureMonthlyPool()`)，首次查询时自动生成

**回填**:
- 通过 `POST /api/rs/backfill` 触发
- 使用独立子进程 (`scripts/rs-backfill-worker.js`) 避免阻塞主进程
- 支持增量回填（指定 startDate/endDate）

### 3. 前端页面

| 页面 | 路径 | 功能 |
|------|------|------|
| 数据概览 | `/` | 数据库统计、采集状态 |
| RS 排名 | `/rs` | RS 排名列表，支持筛选/排序/板块过滤 |
| 个股详情 | `/stock/:ticker` | 价格走势 + RS 曲线，交叉十字线联动 |
| 管理面板 | `/admin` | 采集控制、回填触发 |

## API 文档

### 数据采集

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/fetch/start` | 启动数据采集 |
| POST | `/api/fetch/stop` | 停止采集 |
| GET | `/api/fetch/status` | 采集状态/数据库统计 |

### 行情查询

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/stocks/daily` | ticker, start_date, end_date | 单只股票日线 |
| GET | `/api/stocks/snapshot` | date, sort_by, order, limit, offset, search | 全市场快照 |
| GET | `/api/stocks/tickers` | search, limit | Ticker 列表 |

### RS Rating

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/api/rs/ranking` | date, min_rating, sort_by, order, limit, offset, search, volume_top, sector | RS 排名 |
| GET | `/api/rs/history` | ticker, start_date, end_date | 单只 RS 历史 |
| GET | `/api/rs/dates` | - | 有 RS 数据的日期列表 |
| POST | `/api/rs/backfill` | startDate, endDate | 触发 RS 回填 |
| GET | `/api/rs/backfill-status` | - | 回填进度 |

### Ticker 信息

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ticker-info/:ticker` | 单只 ticker 元数据 |
| GET | `/api/ticker-info/sectors` | 板块列表 |
| POST | `/api/ticker-info/fetch` | 批量拉取 ticker 信息 |
| POST | `/api/ticker-info/sec-sic` | SEC SIC 代码补充 |
| POST | `/api/ticker-info/sync` | 同步 ticker 信息 |
| GET | `/api/ticker-info/status` | 拉取进度 |

## 数据库 Schema

### daily_bars（核心表，~3900 万行）
```sql
CREATE TABLE daily_bars (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL,
  volume INTEGER,
  vwap REAL,
  transactions INTEGER,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX idx_daily_bars_date ON daily_bars(date);
```

### rs_ratings
```sql
CREATE TABLE rs_ratings (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  score REAL,
  rating INTEGER,
  percentile REAL,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX idx_rs_ratings_date ON rs_ratings(date);
```

### rs_pool（月度池）
```sql
CREATE TABLE rs_pool (
  month TEXT NOT NULL,       -- "2026-05"
  ticker TEXT NOT NULL,
  avg_dollar_volume REAL,    -- 上月日均成交额
  PRIMARY KEY (month, ticker)
);
CREATE INDEX idx_rs_pool_month ON rs_pool(month);
```

### ticker_info
```sql
CREATE TABLE ticker_info (
  ticker TEXT PRIMARY KEY,
  name TEXT,
  cik TEXT,
  sic_code TEXT,
  sic_description TEXT,
  sector TEXT,
  exchange TEXT,
  market_cap REAL,
  updated_at TEXT
);
```

### db_stats（预计算统计 KV 表）
```sql
CREATE TABLE db_stats (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
-- 存储 total_records, unique_tickers, first_date, last_date 等
```

## 部署

### 环境要求
- Node.js >= 18
- PM2（生产环境进程管理）
- 约 8GB 磁盘（SQLite 数据库 ~7.2GB）

### 部署步骤

```bash
# 1. 登录服务器
ssh root@119.91.46.43

# 2. 进入项目目录
cd /root/work/us-stock-updator

# 3. 拉取最新代码
git pull origin main

# 4. 安装依赖
npm install

# 5. 构建
npm run build

# 6. 重启服务
pm2 restart us-stock-updator
# 或首次启动：
pm2 start ecosystem.config.cjs

# 7. 查看日志
pm2 logs us-stock-updator
```

### PM2 配置

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "us-stock-updator",
    script: ".output/server/index.mjs",
    cwd: "/root/work/us-stock-updator",
    env: {
      NODE_ENV: "production",
      MASSIVE_API_KEY: "***",
      NITRO_PORT: 3456,
    },
  }],
};
```

服务运行在 `http://119.91.46.43:3456`

### 定时任务

内置 Cron 插件自动管理：
- 每个工作日美东 17:00 采集数据
- 采集完成后自动计算当日 RS Rating
- 启动时自动检测并补全历史缺口
- 定期 WAL checkpoint（每 6 小时）

可通过环境变量 `CRON_DISABLED=true` 关闭。

## MCP Server

项目提供 MCP (Model Context Protocol) 接口，支持 AI 工具调用：

```bash
npm run mcp
# 或
npx tsx mcp-server.ts
```

支持的 MCP Tools:
- `stock_daily` - 查询日线数据
- `stock_snapshot` - 市场快照
- `stock_tickers` - Ticker 列表
- `rs_ranking` - RS 排名
- `rs_history` - RS 历史
- `rs_backfill` - 触发回填
- `fetch_status` - 采集状态
- `fetch_start` / `fetch_stop` - 采集控制

## 开发

```bash
# 本地开发
npm run dev

# 构建
npm run build

# 预览构建产物
npm run preview

# 手动采集
npm run fetch

# 查看采集状态
npm run fetch:status

# 重试失败的采集
npm run fetch:retry
```

## 已知限制

1. Massive API Free/Basic 计划不支持当天数据实时获取，需延迟 1 个工作日
2. SQLite WAL 模式下并发写入有限制，单进程写入
3. RS 回填为全量重算模式（DELETE + INSERT），大规模数据时耗时 ~1 小时
4. 月度池固定 Top 1000，不同于原始 IBD 覆盖全市场的做法

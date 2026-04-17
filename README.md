# US Stock Updator

美股每日行情数据采集 & 查询服务，基于 [Massive API](https://massive.com) + Nuxt.js + SQLite。

## 功能

- **数据采集**：自动获取近 2 年所有美股的每日 OHLCV 数据
- **断点续传**：中断后重启自动从上次进度继续
- **频率控制**：自动适配 API 限速（免费版 5 req/min）
- **REST API**：提供本地查询接口，支持按 ticker/日期查询
- **Web 面板**：可视化采集进度和数据查询

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API Key

```bash
cp .env.example .env
# 编辑 .env，填入你的 Massive API Key
```

### 3. 方式一：命令行采集（推荐首次跑满）

```bash
# 启动采集（支持 Ctrl+C 安全中断 + 断点续传）
MASSIVE_API_KEY=your_key node scripts/fetch.mjs

# 后台运行（服务器）
nohup node scripts/fetch.mjs > fetch.log 2>&1 &

# 查看进度
node scripts/fetch.mjs --status

# 重试失败的日期
node scripts/fetch.mjs --retry-errors
```

### 4. 方式二：启动 Nuxt 服务（Web 面板 + API）

```bash
# 开发模式
npm run dev

# 生产部署
npm run build
npm run start  # 或 node .output/server/index.mjs
```

访问 http://localhost:3456 打开 Web 面板。

### 5. 通过 API 采集

启动 Nuxt 服务后，也可通过 API 控制采集：

```bash
# 启动采集
curl -X POST http://localhost:3456/api/fetch/start

# 查看状态
curl http://localhost:3456/api/fetch/status

# 停止采集
curl -X POST http://localhost:3456/api/fetch/stop

# 重试失败
curl -X POST http://localhost:3456/api/fetch/start -d '{"retryErrors":true}'
```

## 查询 API

### 查询单只股票日线

```
GET /api/stocks/daily?ticker=AAPL&from=2024-01-01&to=2026-04-17&limit=500&sort=asc
```

### 查询全市场某日快照

```
GET /api/stocks/snapshot?date=2026-04-17&sort_by=volume&order=desc&limit=100&offset=0&search=AA
```

### 搜索可用 Ticker

```
GET /api/stocks/tickers?search=TSL&limit=100
```

## 数据库

- 使用 SQLite（better-sqlite3），数据文件默认在 `./data/stocks.db`
- 约 500 个交易日 × 10000+ 股票 ≈ 500 万条记录
- 预计数据库大小：500MB - 1GB

## 服务器部署

```bash
# 构建
npm run build

# 启动（端口可通过 PORT 环境变量指定）
PORT=3456 MASSIVE_API_KEY=your_key node .output/server/index.mjs

# 或用 PM2
pm2 start .output/server/index.mjs --name us-stock-updator
```

## 技术栈

- **框架**: Nuxt 3 (Nitro)
- **数据库**: SQLite (better-sqlite3)
- **数据源**: Massive API (原 Polygon.io)
- **语言**: TypeScript / Vue 3

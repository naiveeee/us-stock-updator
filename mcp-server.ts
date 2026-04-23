/**
 * US Stock Data — MCP Server
 *
 * 将 us-stock-updator 的 REST API 暴露为 MCP 工具，
 * 让 AI 助手（WorkBuddy / Claude Desktop）能直接查询美股数据。
 *
 * 用法:
 *   npx tsx mcp-server.ts                         # 默认连接 http://119.91.46.43:3456
 *   API_BASE=http://localhost:3456 npx tsx mcp-server.ts  # 自定义地址
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.API_BASE || "http://119.91.46.43:3456";

// ─── helpers ────────────────────────────────────────────────

async function apiGet<T = any>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

async function apiPost<T = any>(path: string, body?: any): Promise<T> {
  const resp = await fetch(new URL(path, API_BASE).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000), // 5 min for backfill
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

function textResult(data: any): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

// ─── MCP server ─────────────────────────────────────────────

const server = new McpServer(
  { name: "us-stock-data", version: "1.0.0" },
  {
    instructions: [
      "This MCP server provides access to a US stock daily OHLCV database with IBD RS Rating (SQLite-backed, ~2 years of history).",
      "Available tools:",
      "- stock_daily: Query daily bars for a single ticker (OHLCV, VWAP, num_trades)",
      "- stock_snapshot: Full market snapshot for a given date (supports sorting, paging, search)",
      "- stock_tickers: List all available tickers with their data coverage",
      "- rs_ranking: RS Rating ranking list with volume/change sorting and filtering",
      "- rs_history: Single stock RS Rating history over time",
      "- rs_backfill: Trigger historical RS backfill computation",
      "- fetch_status: Check data collection status and database statistics",
      "- fetch_start: Start background data collection from Polygon.io",
      "- fetch_stop: Stop a running data collection task",
      "",
      "Tips:",
      "- RS Rating (1-99) measures a stock's price performance relative to the entire market over the past 12 months",
      "- RS ≥ 80 means the stock outperformed 80% of all stocks (CAN SLIM standard)",
      "- Use rs_ranking to find the strongest stocks, then rs_history or stock_daily for deeper analysis",
      "- The ranking page defaults to showing volume top 1000 stocks",
    ].join("\n"),
  }
);

// ─── Tool: stock_daily ──────────────────────────────────────

server.registerTool(
  "stock_daily",
  {
    title: "Stock Daily Bars",
    description:
      "Query daily OHLCV data for a single US stock ticker. Returns open, high, low, close, volume, VWAP, and number of trades for each trading day.",
    inputSchema: z.object({
      ticker: z.string().describe("Stock ticker symbol, e.g. AAPL, MSFT, TSLA"),
      from: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 30 days ago"),
      to: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
      limit: z.number().optional().describe("Max rows to return (1-5000, default 500)"),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort by date, default asc"),
    }),
  },
  async ({ ticker, from, to, limit, sort }) => {
    const params: Record<string, string> = { ticker };
    if (from) params.from = from;
    if (to) params.to = to;
    if (limit) params.limit = String(limit);
    if (sort) params.sort = sort;

    const data = await apiGet("/api/stocks/daily", params);
    return textResult(data);
  }
);

// ─── Tool: stock_snapshot ───────────────────────────────────

server.registerTool(
  "stock_snapshot",
  {
    title: "Market Snapshot",
    description:
      "Get a full market snapshot for a specific trading day. Shows all stocks traded that day with OHLCV and change%. Supports sorting by volume/change/ticker, paging, and ticker search.",
    inputSchema: z.object({
      date: z.string().optional().describe("Trading date (YYYY-MM-DD). Defaults to the latest available date"),
      sort_by: z.enum(["volume", "change", "ticker"]).optional().describe("Sort field, default volume"),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction, default desc"),
      limit: z.number().optional().describe("Max rows (1-5000, default 100)"),
      offset: z.number().optional().describe("Pagination offset, default 0"),
      search: z.string().optional().describe("Ticker prefix search, e.g. 'AA' matches AAPL, AAL, etc."),
    }),
  },
  async ({ date, sort_by, order, limit, offset, search }) => {
    const params: Record<string, string> = {};
    if (date) params.date = date;
    if (sort_by) params.sort_by = sort_by;
    if (order) params.order = order;
    if (limit) params.limit = String(limit);
    if (offset) params.offset = String(offset);
    if (search) params.search = search;

    const data = await apiGet("/api/stocks/snapshot", params);
    return textResult(data);
  }
);

// ─── Tool: stock_tickers ────────────────────────────────────

server.registerTool(
  "stock_tickers",
  {
    title: "Available Tickers",
    description:
      "List all stock tickers in the database with their data coverage (trading days count, first/last date). Use this to verify a ticker exists before querying daily data.",
    inputSchema: z.object({
      search: z.string().optional().describe("Ticker prefix search"),
      limit: z.number().optional().describe("Max results (1-5000, default 100)"),
    }),
  },
  async ({ search, limit }) => {
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (limit) params.limit = String(limit);

    const data = await apiGet("/api/stocks/tickers", params);
    return textResult(data);
  }
);

// ─── Tool: rs_ranking ───────────────────────────────────────

server.registerTool(
  "rs_ranking",
  {
    title: "RS Rating Ranking",
    description:
      "Get the RS Rating ranking list. Shows stocks ranked by their IBD-style Relative Strength Rating (1-99). Supports filtering by minimum rating, volume top N, and ticker search.",
    inputSchema: z.object({
      date: z.string().optional().describe("Trading date (YYYY-MM-DD). Defaults to latest available"),
      min_rating: z.number().optional().describe("Minimum RS rating filter, e.g. 80 for CAN SLIM standard"),
      sort_by: z.enum(["rating", "volume", "change"]).optional().describe("Sort field, default rating"),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction, default desc"),
      limit: z.number().optional().describe("Max rows (1-5000, default 100)"),
      offset: z.number().optional().describe("Pagination offset, default 0"),
      search: z.string().optional().describe("Ticker prefix search"),
      volume_top: z.number().optional().describe("Only show top N by volume (default 1000, set 50000 for all)"),
    }),
  },
  async ({ date, min_rating, sort_by, order, limit, offset, search, volume_top }) => {
    const params: Record<string, string> = {};
    if (date) params.date = date;
    if (min_rating) params.min_rating = String(min_rating);
    if (sort_by) params.sort_by = sort_by;
    if (order) params.order = order;
    if (limit) params.limit = String(limit);
    if (offset) params.offset = String(offset);
    if (search) params.search = search;
    if (volume_top) params.volume_top = String(volume_top);

    const data = await apiGet("/api/rs/ranking", params);
    return textResult(data);
  }
);

// ─── Tool: rs_history ───────────────────────────────────────

server.registerTool(
  "rs_history",
  {
    title: "RS Rating History",
    description:
      "Get the RS Rating history for a single stock over time. Returns daily RS rating, percentile, score, and price data. Useful for analyzing RS trend.",
    inputSchema: z.object({
      ticker: z.string().describe("Stock ticker symbol, e.g. AAPL"),
      from: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 6 months ago"),
      to: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
      limit: z.number().optional().describe("Max rows (1-2000, default 500)"),
    }),
  },
  async ({ ticker, from, to, limit }) => {
    const params: Record<string, string> = { ticker };
    if (from) params.from = from;
    if (to) params.to = to;
    if (limit) params.limit = String(limit);

    const data = await apiGet("/api/rs/history", params);
    return textResult(data);
  }
);

// ─── Tool: rs_backfill ──────────────────────────────────────

server.registerTool(
  "rs_backfill",
  {
    title: "Backfill RS Ratings",
    description:
      "Trigger historical RS Rating computation. Calculates RS for all trading days that haven't been computed yet. May take a few minutes for initial backfill.",
    inputSchema: z.object({
      startDate: z.string().optional().describe("Start date for backfill (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date for backfill (YYYY-MM-DD)"),
    }),
  },
  async ({ startDate, endDate }) => {
    const body: any = {};
    if (startDate) body.startDate = startDate;
    if (endDate) body.endDate = endDate;

    const data = await apiPost("/api/rs/backfill", Object.keys(body).length > 0 ? body : undefined);
    return textResult(data);
  }
);

// ─── Tool: fetch_status ─────────────────────────────────────

server.registerTool(
  "fetch_status",
  {
    title: "Collection Status",
    description:
      "Check the current data collection status and database statistics: total records, unique tickers, date range, and collection progress.",
    inputSchema: z.object({}),
  },
  async () => {
    const data = await apiGet("/api/fetch/status");
    return textResult(data);
  }
);

// ─── Tool: fetch_start ──────────────────────────────────────

server.registerTool(
  "fetch_start",
  {
    title: "Start Data Collection",
    description:
      "Start background data collection from Polygon.io API. Fetches daily OHLCV for all US stocks. Supports resume (skips already-done dates) and retry-errors mode.",
    inputSchema: z.object({
      retryErrors: z.boolean().optional().describe("If true, only retry previously failed dates instead of full collection"),
    }),
  },
  async ({ retryErrors }) => {
    const data = await apiPost("/api/fetch/start", retryErrors ? { retryErrors: true } : undefined);
    return textResult(data);
  }
);

// ─── Tool: fetch_stop ───────────────────────────────────────

server.registerTool(
  "fetch_stop",
  {
    title: "Stop Data Collection",
    description: "Safely stop a running data collection task. The current request will finish before stopping.",
    inputSchema: z.object({}),
  },
  async () => {
    const data = await apiPost("/api/fetch/stop");
    return textResult(data);
  }
);

// ─── Start ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[us-stock-data MCP] Connected via stdio, API_BASE=${API_BASE}`);
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});

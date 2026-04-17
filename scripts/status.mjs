#!/usr/bin/env node
/**
 * 查看采集进度（快捷命令）
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(process.env.DB_PATH || resolve(__dirname, "../data/stocks.db"));

if (!existsSync(DB_PATH)) {
  console.log("❌ 数据库不存在:", DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const rows = db
  .prepare("SELECT status, COUNT(*) as cnt, COALESCE(SUM(result_count),0) as records FROM fetch_progress GROUP BY status")
  .all();

console.log("\n📊 采集进度");
console.log("─".repeat(55));
let totalDays = 0, totalRecords = 0;
for (const r of rows) {
  const label = { done: "✅ 成功", error: "❌ 失败", empty: "⬜ 非交易日" }[r.status] || r.status;
  console.log(`  ${label.padEnd(14)} ${String(r.cnt).padStart(5)} 天   ${r.records.toLocaleString().padStart(10)} 条`);
  totalDays += r.cnt;
  totalRecords += r.records;
}
console.log("─".repeat(55));
console.log(`  ${"📁 总计".padEnd(14)} ${String(totalDays).padStart(5)} 天   ${totalRecords.toLocaleString().padStart(10)} 条`);

const range = db.prepare("SELECT MIN(date) as a, MAX(date) as b FROM fetch_progress WHERE status='done'").get();
if (range?.a) console.log(`  📅 范围: ${range.a} → ${range.b}`);

const last = db.prepare("SELECT MAX(fetched_at) as t FROM fetch_progress").get();
if (last?.t) console.log(`  🕐 最后活动: ${last.t}`);

const statFile = existsSync(DB_PATH) ? (await import("node:fs")).statSync(DB_PATH) : null;
if (statFile) console.log(`  💾 数据库: ${(statFile.size / 1024 / 1024).toFixed(1)} MB`);

console.log();
db.close();

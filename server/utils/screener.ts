/**
 * 选股评分引擎
 *
 * 基于周线数据和技术指标，对每只股票打分评级。
 * 分为左侧交易（逆势抄底）和右侧交易（顺势追涨）两类。
 */
import type Database from "better-sqlite3";
import {
  type Bar,
  type FullIndicators,
  calcAllIndicators,
  detectMACDBottomDivergence,
  detectRSIBottomDivergence,
} from "./indicators";

// ============================================================
// 类型定义
// ============================================================

export interface ScoreDetail {
  score1: number; // 左: MACD背离 / 右: 放量突破
  score2: number; // 左: RSI / 右: 均线排列
  score3: number; // 左: 缩量 / 右: MACD零轴金叉
  score4: number; // 左: 布林带 / 右: OBV
  bonus: number; // 加减分
  total: number;
  max1: number;
  max2: number;
  max3: number;
  max4: number;
}

export interface ScreenerResult {
  ticker: string;
  side: "left" | "right";
  score: number;
  grade: "A" | "B" | "C";
  detail: ScoreDetail;
  latestClose: number;
  latestVolume: number;
  weekChangePct: number;
  avgDollarVolume: number; // 20 周平均成交额
  signals: SignalItem[];
}

export interface SignalItem {
  type: string;
  side: "left" | "right";
  description: string;
  value: number;
  maxValue: number;
}

// ============================================================
// 左侧交易评分
// ============================================================

function scoreLeft(bars: Bar[], indicators: FullIndicators): {
  detail: ScoreDetail;
  signals: SignalItem[];
} | null {
  if (bars.length < 30) return null;

  const signals: SignalItem[] = [];
  let score1 = 0; // MACD 底背离 (max 35)
  let score2 = 0; // RSI (max 30)
  let score3 = 0; // 缩量 (max 20)
  let score4 = 0; // 布林带 (max 15)
  let bonus = 0;

  const { macd, rsi, bollinger, obv, ma } = indicators;
  const lastBar = bars[bars.length - 1];
  const lastMACD = macd.length > 0 ? macd[macd.length - 1] : null;
  const lastRSI = rsi.length > 0 ? rsi[rsi.length - 1] : null;
  const lastBoll = bollinger.length > 0 ? bollinger[bollinger.length - 1] : null;

  // ── 1. MACD 底背离 (35 分) ──
  const macdDiv = detectMACDBottomDivergence(bars, macd);
  if (macdDiv) {
    // 检查是 DIF 背离还是仅柱状体背离
    score1 = 35;
    signals.push({
      type: "macd_divergence",
      side: "left",
      description: `MACD底背离: 价格 ${macdDiv.priceVal2.toFixed(2)} < ${macdDiv.priceVal1.toFixed(2)}, DIF ${macdDiv.indicatorVal2.toFixed(4)} > ${macdDiv.indicatorVal1.toFixed(4)}`,
      value: 35,
      maxValue: 35,
    });
  } else if (lastMACD && lastMACD.histogram > 0 && macd.length >= 2 && macd[macd.length - 2].histogram < 0) {
    // 柱状体由负转正（弱信号）
    score1 = 15;
    signals.push({
      type: "macd_hist_turn",
      side: "left",
      description: "MACD柱状体由负转正",
      value: 15,
      maxValue: 35,
    });
  }

  // ── 2. RSI 超卖 + 背离 (30 分) ──
  const rsiDiv = detectRSIBottomDivergence(bars, rsi);
  if (lastRSI) {
    if (lastRSI.rsi < 30 && rsiDiv) {
      score2 = 30;
      signals.push({
        type: "rsi_oversold_divergence",
        side: "left",
        description: `RSI=${lastRSI.rsi.toFixed(1)} 超卖 + 底背离`,
        value: 30,
        maxValue: 30,
      });
    } else if (lastRSI.rsi < 30) {
      score2 = 15;
      signals.push({
        type: "rsi_oversold",
        side: "left",
        description: `RSI=${lastRSI.rsi.toFixed(1)} 超卖`,
        value: 15,
        maxValue: 30,
      });
    } else if (lastRSI.rsi < 40 && rsiDiv) {
      score2 = 20;
      signals.push({
        type: "rsi_divergence",
        side: "left",
        description: `RSI=${lastRSI.rsi.toFixed(1)} + 底背离`,
        value: 20,
        maxValue: 30,
      });
    }
  }

  // ── 3. 成交量萎缩 (20 分) ──
  if (bars.length >= 20) {
    const recentVolumes = bars.slice(-4).map((b) => b.volume);
    const avgRecent = recentVolumes.reduce((a, b) => a + b, 0) / 4;
    const longVolumes = bars.slice(-20).map((b) => b.volume);
    const avgLong = longVolumes.reduce((a, b) => a + b, 0) / 20;

    if (avgLong > 0) {
      const ratio = avgRecent / avgLong;
      if (ratio < 0.4) {
        score3 = 20;
        signals.push({
          type: "volume_shrink",
          side: "left",
          description: `极度缩量: 近4周均量仅为20周均量的${(ratio * 100).toFixed(0)}%`,
          value: 20,
          maxValue: 20,
        });
      } else if (ratio < 0.5) {
        score3 = 15;
        signals.push({
          type: "volume_shrink",
          side: "left",
          description: `明显缩量: 近4周均量为20周均量的${(ratio * 100).toFixed(0)}%`,
          value: 15,
          maxValue: 20,
        });
      } else if (ratio < 0.6) {
        score3 = 10;
        signals.push({
          type: "volume_shrink",
          side: "left",
          description: `轻度缩量: 近4周均量为20周均量的${(ratio * 100).toFixed(0)}%`,
          value: 10,
          maxValue: 20,
        });
      }
    }
  }

  // ── 4. 布林带下轨 (15 分) ──
  if (lastBoll) {
    if (lastBar.close < lastBoll.lower) {
      score4 = 15;
      signals.push({
        type: "bollinger_below_lower",
        side: "left",
        description: `收盘价 ${lastBar.close.toFixed(2)} 跌破布林下轨 ${lastBoll.lower.toFixed(2)}`,
        value: 15,
        maxValue: 15,
      });
    } else if (lastBar.low <= lastBoll.lower) {
      score4 = 10;
      signals.push({
        type: "bollinger_touch_lower",
        side: "left",
        description: `最低价 ${lastBar.low.toFixed(2)} 触及布林下轨 ${lastBoll.lower.toFixed(2)}`,
        value: 10,
        maxValue: 15,
      });
    }

    // 带宽收窄额外加分
    if (bollinger.length >= 20) {
      const bws = bollinger.map((b) => b.bandwidth);
      const sortedBW = [...bws].sort((a, b) => a - b);
      const pct20 = sortedBW[Math.floor(sortedBW.length * 0.2)];
      if (lastBoll.bandwidth < pct20) {
        const extraBoll = Math.min(5, score4 > 0 ? 5 : 0);
        score4 += extraBoll;
        if (extraBoll > 0) {
          signals.push({
            type: "bollinger_squeeze",
            side: "left",
            description: `布林带宽收窄至历史20%分位以下`,
            value: extraBoll,
            maxValue: 5,
          });
        }
      }
    }
  }

  // ── 加减分 ──
  bonus = calcBonus(bars, "left");

  const total = score1 + score2 + score3 + score4 + bonus;

  return {
    detail: {
      score1,
      score2,
      score3,
      score4,
      bonus,
      total,
      max1: 35,
      max2: 30,
      max3: 20,
      max4: 15,
    },
    signals,
  };
}

// ============================================================
// 右侧交易评分
// ============================================================

function scoreRight(bars: Bar[], indicators: FullIndicators): {
  detail: ScoreDetail;
  signals: SignalItem[];
} | null {
  if (bars.length < 30) return null;

  const signals: SignalItem[] = [];
  let score1 = 0; // 放量突破 (max 35)
  let score2 = 0; // 均线多头排列 (max 30)
  let score3 = 0; // MACD 零轴上方金叉 (max 20)
  let score4 = 0; // OBV (max 15)
  let bonus = 0;

  const { macd, obv, ma } = indicators;
  const lastBar = bars[bars.length - 1];
  const lastMACD = macd.length > 0 ? macd[macd.length - 1] : null;
  const prevMACD = macd.length > 1 ? macd[macd.length - 2] : null;
  const lastMA = ma.length > 0 ? ma[ma.length - 1] : null;

  // ── 1. 放量突破 (35 分) ──
  if (bars.length >= 20) {
    // 20 周高点
    const high20 = Math.max(...bars.slice(-21, -1).map((b) => b.high));
    const avgVol20 =
      bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;

    if (lastBar.close > high20) {
      if (lastBar.volume > avgVol20 * 1.5) {
        score1 = 35;
        signals.push({
          type: "volume_breakout",
          side: "right",
          description: `放量突破20周高点 ${high20.toFixed(2)}, 量比 ${(lastBar.volume / avgVol20).toFixed(1)}x`,
          value: 35,
          maxValue: 35,
        });
      } else {
        score1 = 20;
        signals.push({
          type: "breakout_weak_volume",
          side: "right",
          description: `突破20周高点 ${high20.toFixed(2)}, 但量能一般`,
          value: 20,
          maxValue: 35,
        });
      }
    }
  }

  // ── 2. 均线多头排列 (30 分) ──
  if (lastMA) {
    const { ma5, ma10, ma20, ma60 } = lastMA;
    if (
      ma5 != null &&
      ma10 != null &&
      ma20 != null &&
      ma60 != null &&
      ma5 > ma10 &&
      ma10 > ma20 &&
      ma20 > ma60
    ) {
      score2 = 30;
      signals.push({
        type: "ma_bull_full",
        side: "right",
        description: "MA5>MA10>MA20>MA60 完全多头排列",
        value: 30,
        maxValue: 30,
      });
    } else if (
      ma5 != null &&
      ma10 != null &&
      ma20 != null &&
      ma5 > ma10 &&
      ma10 > ma20
    ) {
      score2 = 20;
      signals.push({
        type: "ma_bull_partial",
        side: "right",
        description: "MA5>MA10>MA20 部分多头排列",
        value: 20,
        maxValue: 30,
      });
    } else if (ma5 != null && ma10 != null && ma5 > ma10) {
      score2 = 10;
      signals.push({
        type: "ma_bull_short",
        side: "right",
        description: "MA5>MA10 短期多头",
        value: 10,
        maxValue: 30,
      });
    }
  }

  // ── 3. MACD 零轴上方金叉 (20 分) ──
  if (lastMACD && prevMACD) {
    if (lastMACD.dif > 0 && prevMACD.dif <= prevMACD.dea && lastMACD.dif > lastMACD.dea) {
      score3 = 20;
      signals.push({
        type: "macd_golden_cross_above_zero",
        side: "right",
        description: `MACD零轴上方金叉 DIF=${lastMACD.dif.toFixed(4)}`,
        value: 20,
        maxValue: 20,
      });
    } else if (lastMACD.dif > 0 && lastMACD.dif > lastMACD.dea) {
      score3 = 10;
      signals.push({
        type: "macd_above_zero_bullish",
        side: "right",
        description: `MACD零轴上方多头持续 DIF=${lastMACD.dif.toFixed(4)}`,
        value: 10,
        maxValue: 20,
      });
    }
  }

  // ── 4. OBV 趋势 (15 分) ──
  if (obv.length >= 20) {
    const recentOBVs = obv.slice(-20);
    const lastOBV = recentOBVs[recentOBVs.length - 1].obv;
    const maxOBV = Math.max(...recentOBVs.map((o) => o.obv));
    const avgOBV =
      recentOBVs.reduce((a, b) => a + b.obv, 0) / recentOBVs.length;

    if (lastOBV >= maxOBV) {
      score4 = 15;
      signals.push({
        type: "obv_new_high",
        side: "right",
        description: "OBV创20周新高",
        value: 15,
        maxValue: 15,
      });
    } else if (lastOBV > avgOBV) {
      score4 = 10;
      signals.push({
        type: "obv_above_avg",
        side: "right",
        description: "OBV高于20周均值",
        value: 10,
        maxValue: 15,
      });
    }
  }

  // ── 加减分 ──
  bonus = calcBonus(bars, "right");

  const total = score1 + score2 + score3 + score4 + bonus;

  return {
    detail: {
      score1,
      score2,
      score3,
      score4,
      bonus,
      total,
      max1: 35,
      max2: 30,
      max3: 20,
      max4: 15,
    },
    signals,
  };
}

// ============================================================
// 通用加减分
// ============================================================

function calcBonus(bars: Bar[], side: "left" | "right"): number {
  let bonus = 0;
  if (bars.length < 5) return bonus;

  const lastBar = bars[bars.length - 1];

  // 流动性：20 周平均成交额
  const recentBars = bars.slice(-20);
  const avgDollarVol =
    recentBars.reduce((a, b) => a + b.close * b.volume, 0) / recentBars.length;

  if (avgDollarVol > 10_000_000) {
    bonus += 5; // 周均成交额 > $10M
  } else if (avgDollarVol < 1_000_000) {
    bonus -= 10; // 流动性差
  }

  // 52 周高点跌幅（左侧加分）
  if (side === "left" && bars.length >= 52) {
    const high52w = Math.max(...bars.slice(-52).map((b) => b.high));
    const drawdown = (lastBar.close - high52w) / high52w;
    if (drawdown < -0.5) {
      bonus += 5; // 从高点跌幅超 50%
    }
  }

  return bonus;
}

// ============================================================
// 等级判定
// ============================================================

function getGrade(score: number): "A" | "B" | "C" {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  return "C";
}

// ============================================================
// 主入口：扫描所有股票
// ============================================================

/**
 * 预筛选配置
 */
export interface PreFilterConfig {
  minPrice: number;       // 最低股价（排除仙股），默认 $5
  minAvgDollarVol: number; // 近 20 日最低日均成交额，默认 $100 万
  maxInactiveDays: number; // 最近 N 天必须有交易记录，默认 60
}

const DEFAULT_PRE_FILTER: PreFilterConfig = {
  minPrice: 5,
  minAvgDollarVol: 1_000_000,
  maxInactiveDays: 60,
};

/**
 * 运行选股扫描
 * @param minScore 最低分数阈值（低于此分数的不入库）
 * @param preFilter 预筛选配置（可选，用于覆盖默认值）
 */
export function runScreenerScan(
  db: Database.Database,
  scanDate: string,
  minScore = 40,
  preFilter: Partial<PreFilterConfig> = {}
): { leftCount: number; rightCount: number; preFilterStats: { total: number; passed: number } } {
  const filter = { ...DEFAULT_PRE_FILTER, ...preFilter };
  console.log(`[Screener] 开始扫描 ${scanDate}，最低分 ${minScore}`);
  console.log(`[Screener] 预筛选: 股价≥$${filter.minPrice}, 日均成交额≥$${(filter.minAvgDollarVol / 1e6).toFixed(1)}M, ${filter.maxInactiveDays}天内有交易`);
  const t0 = Date.now();

  // 计算活跃截止日期
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - filter.maxInactiveDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  // 预筛选：从日线表中筛出符合条件的 ticker
  // 1. 最近 N 天有交易
  // 2. 最新收盘价 >= minPrice
  // 3. 近 20 个交易日平均成交额 >= minAvgDollarVol
  const preFilterQuery = db.prepare(`
    WITH latest_bars AS (
      SELECT ticker, date, close, volume,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) as rn
      FROM daily_bars
      WHERE date >= ?
    ),
    latest_close AS (
      SELECT ticker, close as latest_close, date as latest_date
      FROM latest_bars
      WHERE rn = 1
    ),
    avg_volume AS (
      SELECT ticker, AVG(close * volume) as avg_dollar_vol
      FROM latest_bars
      WHERE rn <= 20
      GROUP BY ticker
    )
    SELECT lc.ticker
    FROM latest_close lc
    JOIN avg_volume av ON lc.ticker = av.ticker
    WHERE lc.latest_close >= ?
      AND av.avg_dollar_vol >= ?
    ORDER BY lc.ticker
  `);

  const qualifiedTickers = preFilterQuery.all(
    cutoffStr,
    filter.minPrice,
    filter.minAvgDollarVol
  ) as Array<{ ticker: string }>;

  const qualifiedSet = new Set(qualifiedTickers.map((t) => t.ticker));

  // 再从周线表中取有足够数据的 ticker，取交集
  const allTickers = db
    .prepare(
      `SELECT ticker, COUNT(*) as cnt FROM weekly_bars
       GROUP BY ticker HAVING cnt >= 30
       ORDER BY ticker`
    )
    .all() as Array<{ ticker: string; cnt: number }>;

  const tickers = allTickers.filter((t) => qualifiedSet.has(t.ticker));

  console.log(`[Screener] 周线≥30周: ${allTickers.length} 个 → 预筛选后: ${tickers.length} 个 (过滤 ${allTickers.length - tickers.length} 个)`);

  // 预编译写入语句
  const insertResult = db.prepare(`
    INSERT OR REPLACE INTO screener_results
    (scan_date, scan_type, ticker, score, grade, score_detail,
     latest_close, latest_volume, week_change_pct, avg_dollar_volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSignal = db.prepare(`
    INSERT OR REPLACE INTO screener_signals
    (scan_date, ticker, signal_type, side, description, value, max_value, week_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectWeekly = db.prepare(`
    SELECT ticker, week_start as date, open, high, low, close, volume
    FROM weekly_bars WHERE ticker = ?
    ORDER BY week_start ASC
  `);

  // 清理当天旧数据
  db.prepare("DELETE FROM screener_results WHERE scan_date = ?").run(scanDate);
  db.prepare("DELETE FROM screener_signals WHERE scan_date = ?").run(scanDate);

  let leftCount = 0;
  let rightCount = 0;

  const batchWrite = db.transaction(
    (results: ScreenerResult[], scanDateStr: string) => {
      for (const r of results) {
        insertResult.run(
          scanDateStr,
          r.side,
          r.ticker,
          r.score,
          r.grade,
          JSON.stringify(r.detail),
          r.latestClose,
          r.latestVolume,
          r.weekChangePct,
          r.avgDollarVolume
        );

        for (const sig of r.signals) {
          insertSignal.run(
            scanDateStr,
            r.ticker,
            sig.type,
            sig.side,
            sig.description,
            sig.value,
            sig.maxValue,
            r.side === "left" ? scanDateStr : scanDateStr
          );
        }
      }
    }
  );

  // 分批处理
  const batchSize = 200;
  let batch: ScreenerResult[] = [];

  for (let i = 0; i < tickers.length; i++) {
    const { ticker } = tickers[i];
    const weeklyBars = selectWeekly.all(ticker) as Bar[];

    if (weeklyBars.length < 30) continue;

    // 过滤掉 OHLC 有 null 的（数据质量差的）
    const validBars = weeklyBars.filter(
      (b) => b.open != null && b.high != null && b.low != null && b.close != null
    );
    if (validBars.length < 30) continue;

    const lastBar = validBars[validBars.length - 1];
    const prevBar = validBars.length >= 2 ? validBars[validBars.length - 2] : lastBar;
    const weekChangePct = prevBar.close > 0
      ? ((lastBar.close - prevBar.close) / prevBar.close) * 100
      : 0;

    const recentBars = validBars.slice(-20);
    const avgDollarVol =
      recentBars.reduce((a, b) => a + b.close * b.volume, 0) / recentBars.length;

    // 计算所有技术指标（一次性）
    const indicators = calcAllIndicators(validBars);

    // 左侧评分
    const leftResult = scoreLeft(validBars, indicators);
    if (leftResult && leftResult.detail.total >= minScore) {
      batch.push({
        ticker,
        side: "left",
        score: leftResult.detail.total,
        grade: getGrade(leftResult.detail.total),
        detail: leftResult.detail,
        latestClose: lastBar.close,
        latestVolume: lastBar.volume,
        weekChangePct: Math.round(weekChangePct * 100) / 100,
        avgDollarVolume: Math.round(avgDollarVol),
        signals: leftResult.signals,
      });
      leftCount++;
    }

    // 右侧评分
    const rightResult = scoreRight(validBars, indicators);
    if (rightResult && rightResult.detail.total >= minScore) {
      batch.push({
        ticker,
        side: "right",
        score: rightResult.detail.total,
        grade: getGrade(rightResult.detail.total),
        detail: rightResult.detail,
        latestClose: lastBar.close,
        latestVolume: lastBar.volume,
        weekChangePct: Math.round(weekChangePct * 100) / 100,
        avgDollarVolume: Math.round(avgDollarVol),
        signals: rightResult.signals,
      });
      rightCount++;
    }

    // 批量写入
    if (batch.length >= batchSize) {
      batchWrite(batch, scanDate);
      batch = [];
    }

    if ((i + 1) % 2000 === 0) {
      console.log(
        `[Screener] 进度 ${i + 1}/${tickers.length}, 左侧 ${leftCount}, 右侧 ${rightCount}`
      );
    }
  }

  // 写入剩余
  if (batch.length > 0) {
    batchWrite(batch, scanDate);
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[Screener] 扫描完成: 左侧 ${leftCount}, 右侧 ${rightCount}, 耗时 ${(elapsed / 1000).toFixed(1)}s`
  );

  return {
    leftCount,
    rightCount,
    preFilterStats: { total: allTickers.length, passed: tickers.length },
  };
}

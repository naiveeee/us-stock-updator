/**
 * 技术指标计算引擎
 *
 * 纯函数计算，输入 OHLCV 数组，输出指标值数组。
 * 所有计算基于周线数据（调用方负责传入正确的时间维度）。
 */

// ============================================================
// 类型定义
// ============================================================

export interface Bar {
  date: string; // week_start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MACDResult {
  date: string;
  dif: number;
  dea: number;
  histogram: number;
}

export interface RSIResult {
  date: string;
  rsi: number;
}

export interface BollingerResult {
  date: string;
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number; // (upper-lower)/middle * 100
}

export interface OBVResult {
  date: string;
  obv: number;
}

export interface MAResult {
  date: string;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
}

export interface FullIndicators {
  macd: MACDResult[];
  rsi: RSIResult[];
  bollinger: BollingerResult[];
  obv: OBVResult[];
  ma: MAResult[];
}

// ============================================================
// EMA 计算
// ============================================================

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ============================================================
// SMA（简单移动平均）
// ============================================================

function sma(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += values[j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

// ============================================================
// MACD (12, 26, 9)
// ============================================================

export function calcMACD(bars: Bar[]): MACDResult[] {
  if (bars.length < 26) return [];

  const closes = bars.map((b) => b.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  // DIF = EMA12 - EMA26
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    dif.push(ema12[i] - ema26[i]);
  }

  // DEA = EMA(DIF, 9)
  const dea = ema(dif, 9);

  // 只输出从第 26 周开始的数据（前面的 EMA 还未稳定）
  const results: MACDResult[] = [];
  for (let i = 25; i < bars.length; i++) {
    results.push({
      date: bars[i].date,
      dif: round4(dif[i]),
      dea: round4(dea[i]),
      histogram: round4((dif[i] - dea[i]) * 2),
    });
  }
  return results;
}

// ============================================================
// RSI (14) - Wilder 平滑法
// ============================================================

export function calcRSI(bars: Bar[], period = 14): RSIResult[] {
  if (bars.length < period + 1) return [];

  const closes = bars.map((b) => b.close);
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // 初始平均值
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  const results: RSIResult[] = [];

  // 第一个 RSI 值
  const firstRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
  results.push({
    date: bars[period].date,
    rsi: round2(100 - 100 / (1 + firstRS)),
  });

  // Wilder 平滑
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    results.push({
      date: bars[i + 1].date,
      rsi: round2(100 - 100 / (1 + rs)),
    });
  }

  return results;
}

// ============================================================
// 布林带 (20, 2)
// ============================================================

export function calcBollinger(
  bars: Bar[],
  period = 20,
  multiplier = 2
): BollingerResult[] {
  if (bars.length < period) return [];

  const closes = bars.map((b) => b.close);
  const results: BollingerResult[] = [];

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    const middle = sum / period;

    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sqSum += (closes[j] - middle) ** 2;
    }
    const stdDev = Math.sqrt(sqSum / period);

    const upper = middle + multiplier * stdDev;
    const lower = middle - multiplier * stdDev;

    results.push({
      date: bars[i].date,
      upper: round4(upper),
      middle: round4(middle),
      lower: round4(lower),
      bandwidth: middle > 0 ? round2(((upper - lower) / middle) * 100) : 0,
    });
  }

  return results;
}

// ============================================================
// OBV (On-Balance Volume)
// ============================================================

export function calcOBV(bars: Bar[]): OBVResult[] {
  if (bars.length === 0) return [];

  const results: OBVResult[] = [{ date: bars[0].date, obv: bars[0].volume }];

  for (let i = 1; i < bars.length; i++) {
    const prev = results[i - 1].obv;
    let obv: number;
    if (bars[i].close > bars[i - 1].close) {
      obv = prev + bars[i].volume;
    } else if (bars[i].close < bars[i - 1].close) {
      obv = prev - bars[i].volume;
    } else {
      obv = prev;
    }
    results.push({ date: bars[i].date, obv: Math.round(obv) });
  }

  return results;
}

// ============================================================
// 移动平均线 (MA5, MA10, MA20, MA60)
// ============================================================

export function calcMA(bars: Bar[]): MAResult[] {
  const closes = bars.map((b) => b.close);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);

  return bars.map((b, i) => ({
    date: b.date,
    ma5: ma5[i] != null ? round4(ma5[i]!) : null,
    ma10: ma10[i] != null ? round4(ma10[i]!) : null,
    ma20: ma20[i] != null ? round4(ma20[i]!) : null,
    ma60: ma60[i] != null ? round4(ma60[i]!) : null,
  }));
}

// ============================================================
// 一次性计算所有指标
// ============================================================

export function calcAllIndicators(bars: Bar[]): FullIndicators {
  return {
    macd: calcMACD(bars),
    rsi: calcRSI(bars),
    bollinger: calcBollinger(bars),
    obv: calcOBV(bars),
    ma: calcMA(bars),
  };
}

// ============================================================
// 背离检测
// ============================================================

interface DivergencePoint {
  date1: string;
  date2: string;
  priceVal1: number;
  priceVal2: number;
  indicatorVal1: number;
  indicatorVal2: number;
}

/**
 * 寻找局部极小值（低点）
 * 要求前后各至少 lookback 个 bar 都比当前值高
 */
function findLocalMinima(
  values: number[],
  dates: string[],
  lookback = 2
): Array<{ index: number; date: string; value: number }> {
  const minima: Array<{ index: number; date: string; value: number }> = [];

  for (let i = lookback; i < values.length - lookback; i++) {
    let isMin = true;
    for (let j = 1; j <= lookback; j++) {
      if (values[i - j] <= values[i] || values[i + j] <= values[i]) {
        isMin = false;
        break;
      }
    }
    if (isMin) {
      minima.push({ index: i, date: dates[i], value: values[i] });
    }
  }

  return minima;
}

/**
 * 寻找局部极大值（高点）
 */
function findLocalMaxima(
  values: number[],
  dates: string[],
  lookback = 2
): Array<{ index: number; date: string; value: number }> {
  const maxima: Array<{ index: number; date: string; value: number }> = [];

  for (let i = lookback; i < values.length - lookback; i++) {
    let isMax = true;
    for (let j = 1; j <= lookback; j++) {
      if (values[i - j] >= values[i] || values[i + j] >= values[i]) {
        isMax = false;
        break;
      }
    }
    if (isMax) {
      maxima.push({ index: i, date: dates[i], value: values[i] });
    }
  }

  return maxima;
}

/**
 * 检测 MACD 底背离
 * 价格创新低但 DIF 不创新低
 * @param minGapWeeks 两个低点之间最少间隔周数
 */
export function detectMACDBottomDivergence(
  bars: Bar[],
  macd: MACDResult[],
  minGapWeeks = 4
): DivergencePoint | null {
  if (macd.length < 20) return null;

  // 对齐：macd 数据可能从 bars 的后面开始
  const macdMap = new Map(macd.map((m) => [m.date, m]));

  // 只看最近 60 周的数据
  const recentCount = Math.min(60, bars.length);
  const recentBars = bars.slice(-recentCount);
  const prices = recentBars.map((b) => b.close);
  const dates = recentBars.map((b) => b.date);
  const difs = recentBars.map((b) => macdMap.get(b.date)?.dif ?? 0);

  const priceMinima = findLocalMinima(prices, dates, 2);
  const difMinima = findLocalMinima(difs, dates, 2);

  if (priceMinima.length < 2 || difMinima.length < 2) return null;

  // 从最近的低点往前找
  for (let i = priceMinima.length - 1; i >= 1; i--) {
    const p2 = priceMinima[i];
    const p1 = priceMinima[i - 1];

    // 间隔检查
    if (p2.index - p1.index < minGapWeeks) continue;

    // 价格创新低
    if (p2.value >= p1.value) continue;

    // 找到对应时间段内的 DIF 低点
    const d1 = difMinima.find(
      (d) => Math.abs(d.index - p1.index) <= 3
    );
    const d2 = difMinima.find(
      (d) => Math.abs(d.index - p2.index) <= 3
    );

    if (!d1 || !d2) continue;

    // DIF 不创新低（底背离）
    if (d2.value > d1.value) {
      return {
        date1: p1.date,
        date2: p2.date,
        priceVal1: p1.value,
        priceVal2: p2.value,
        indicatorVal1: d1.value,
        indicatorVal2: d2.value,
      };
    }
  }

  return null;
}

/**
 * 检测 RSI 底背离
 */
export function detectRSIBottomDivergence(
  bars: Bar[],
  rsi: RSIResult[],
  minGapWeeks = 4
): DivergencePoint | null {
  if (rsi.length < 20) return null;

  const rsiMap = new Map(rsi.map((r) => [r.date, r]));
  const recentCount = Math.min(60, bars.length);
  const recentBars = bars.slice(-recentCount);
  const prices = recentBars.map((b) => b.close);
  const dates = recentBars.map((b) => b.date);
  const rsiVals = recentBars.map((b) => rsiMap.get(b.date)?.rsi ?? 50);

  const priceMinima = findLocalMinima(prices, dates, 2);
  const rsiMinima = findLocalMinima(rsiVals, dates, 2);

  if (priceMinima.length < 2 || rsiMinima.length < 2) return null;

  for (let i = priceMinima.length - 1; i >= 1; i--) {
    const p2 = priceMinima[i];
    const p1 = priceMinima[i - 1];

    if (p2.index - p1.index < minGapWeeks) continue;
    if (p2.value >= p1.value) continue;

    const r1 = rsiMinima.find((r) => Math.abs(r.index - p1.index) <= 3);
    const r2 = rsiMinima.find((r) => Math.abs(r.index - p2.index) <= 3);

    if (!r1 || !r2) continue;

    if (r2.value > r1.value) {
      return {
        date1: p1.date,
        date2: p2.date,
        priceVal1: p1.value,
        priceVal2: p2.value,
        indicatorVal1: r1.value,
        indicatorVal2: r2.value,
      };
    }
  }

  return null;
}

/**
 * 检测 MACD 顶背离（右侧交易中用于止盈预警）
 */
export function detectMACDTopDivergence(
  bars: Bar[],
  macd: MACDResult[],
  minGapWeeks = 4
): DivergencePoint | null {
  if (macd.length < 20) return null;

  const macdMap = new Map(macd.map((m) => [m.date, m]));
  const recentCount = Math.min(60, bars.length);
  const recentBars = bars.slice(-recentCount);
  const prices = recentBars.map((b) => b.close);
  const dates = recentBars.map((b) => b.date);
  const difs = recentBars.map((b) => macdMap.get(b.date)?.dif ?? 0);

  const priceMaxima = findLocalMaxima(prices, dates, 2);
  const difMaxima = findLocalMaxima(difs, dates, 2);

  if (priceMaxima.length < 2 || difMaxima.length < 2) return null;

  for (let i = priceMaxima.length - 1; i >= 1; i--) {
    const p2 = priceMaxima[i];
    const p1 = priceMaxima[i - 1];

    if (p2.index - p1.index < minGapWeeks) continue;
    if (p2.value <= p1.value) continue;

    const d1 = difMaxima.find((d) => Math.abs(d.index - p1.index) <= 3);
    const d2 = difMaxima.find((d) => Math.abs(d.index - p2.index) <= 3);

    if (!d1 || !d2) continue;

    if (d2.value < d1.value) {
      return {
        date1: p1.date,
        date2: p2.date,
        priceVal1: p1.value,
        priceVal2: p2.value,
        indicatorVal1: d1.value,
        indicatorVal2: d2.value,
      };
    }
  }

  return null;
}

// ============================================================
// 工具函数
// ============================================================

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

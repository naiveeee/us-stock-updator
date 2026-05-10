<template>
  <div>
    <!-- 头部信息 -->
    <section class="card stock-header">
      <div class="header-left">
        <button @click="navigateTo('/rs')" class="btn btn-back">← RS 排名</button>
        <h1 class="ticker-title">{{ ticker }}</h1>
      </div>
      <div class="header-right" v-if="latestRS">
        <div class="rs-big" :class="rsBigClass">
          <div class="rs-label">RS Rating</div>
          <div class="rs-value">{{ latestRS.rating }}</div>
          <div class="rs-pct">{{ latestRS.percentile.toFixed(1) }}%</div>
        </div>
      </div>
    </section>

    <!-- 时间范围选择 -->
    <section class="card">
      <div class="range-bar">
        <button
          v-for="r in ranges"
          :key="r.value"
          @click="setRange(r.value)"
          :class="['btn', range === r.value ? 'btn-primary' : '']"
        >
          {{ r.label }}
        </button>
      </div>
    </section>

    <!-- K 线图 -->
    <section class="card chart-card">
      <h2>📈 股价走势</h2>
      <div ref="priceChartEl" class="chart-container"></div>
    </section>

    <!-- RS 曲线图 -->
    <section class="card chart-card">
      <h2>💪 RS Rating 趋势</h2>
      <div ref="rsChartEl" class="chart-container"></div>
    </section>

    <!-- RS 季度明细 -->
    <section class="card" v-if="latestRS">
      <h2>📋 RS 得分明细</h2>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">加权总分</span>
          <span class="detail-value">{{ latestRS.score?.toFixed(2) }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">RS Rating</span>
          <span class="detail-value">{{ latestRS.rating }} / 99</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">精确百分位</span>
          <span class="detail-value">{{ latestRS.percentile.toFixed(2) }}%</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">最新收盘</span>
          <span class="detail-value">${{ latestRS.close?.toFixed(2) }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { createChart, type IChartApi, type ISeriesApi, ColorType, LineStyle } from "lightweight-charts";

const route = useRoute();
const ticker = (route.params.ticker as string).toUpperCase();

const range = ref("1y");
const ranges = [
  { label: "1M", value: "1m" },
  { label: "3M", value: "3m" },
  { label: "6M", value: "6m" },
  { label: "1Y", value: "1y" },
  { label: "2Y", value: "2y" },
  { label: "5Y", value: "5y" },
  { label: "ALL", value: "all" },
];

const priceChartEl = ref<HTMLElement | null>(null);
const rsChartEl = ref<HTMLElement | null>(null);

let priceChart: IChartApi | null = null;
let rsChart: IChartApi | null = null;
let candleSeries: ISeriesApi<any> | null = null;
let volumeSeries: ISeriesApi<any> | null = null;
let rsLineSeries: ISeriesApi<any> | null = null;

// crosshair 联动标志，防止递归
let isSyncingCrosshair = false;

const latestRS = ref<any>(null);

function getFromDate(rangeVal: string): string {
  const now = new Date();
  switch (rangeVal) {
    case "1m": now.setMonth(now.getMonth() - 1); break;
    case "3m": now.setMonth(now.getMonth() - 3); break;
    case "6m": now.setMonth(now.getMonth() - 6); break;
    case "1y": now.setFullYear(now.getFullYear() - 1); break;
    case "2y": now.setFullYear(now.getFullYear() - 2); break;
    case "5y": now.setFullYear(now.getFullYear() - 5); break;
    case "all": return "2000-01-01";
  }
  return now.toISOString().slice(0, 10);
}

async function fetchAndRender() {
  const from = getFromDate(range.value);
  const to = new Date().toISOString().slice(0, 10);

  // 并行拉数据
  const [priceData, rsData] = await Promise.all([
    $fetch<any>("/api/stocks/daily", { params: { ticker, from, to, limit: 5000, sort: "asc" } }),
    $fetch<any>("/api/rs/history", { params: { ticker, from, to, limit: 5000 } }),
  ]);

  // 更新最新 RS
  if (rsData.results.length > 0) {
    latestRS.value = rsData.results[rsData.results.length - 1];
  }

  renderPriceChart(priceData.results);
  renderRSChart(rsData.results);
}

function renderPriceChart(bars: any[]) {
  if (!priceChartEl.value) return;

  // 清理旧图
  if (priceChart) {
    priceChart.remove();
    priceChart = null;
  }

  priceChart = createChart(priceChartEl.value, {
    layout: {
      background: { type: ColorType.Solid, color: "#1a1d27" },
      textColor: "#aaa",
    },
    grid: {
      vertLines: { color: "#2a2d37" },
      horzLines: { color: "#2a2d37" },
    },
    width: priceChartEl.value.clientWidth,
    height: 400,
    crosshair: {
      mode: 0,
    },
    timeScale: {
      borderColor: "#2a2d37",
    },
    rightPriceScale: {
      borderColor: "#2a2d37",
    },
  });

  // K 线
  candleSeries = priceChart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderVisible: false,
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });

  candleSeries.setData(
    bars.map((b: any) => ({
      time: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
  );

  // 成交量
  volumeSeries = priceChart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
  });

  priceChart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  volumeSeries.setData(
    bars.map((b: any) => ({
      time: b.date,
      value: b.volume,
      color: b.close >= b.open ? "rgba(38,166,154,0.3)" : "rgba(239,83,80,0.3)",
    }))
  );

  priceChart.timeScale().fitContent();

  // crosshair 联动：price → RS
  priceChart.subscribeCrosshairMove((param) => {
    if (isSyncingCrosshair || !rsChart) return;
    isSyncingCrosshair = true;
    if (param.time) {
      rsChart.setCrosshairPosition(NaN, param.time, rsLineSeries!);
    } else {
      rsChart.clearCrosshairPosition();
    }
    isSyncingCrosshair = false;
  });

  // timeScale 联动：price → RS
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (isSyncingCrosshair || !rsChart || !range) return;
    isSyncingCrosshair = true;
    rsChart.timeScale().setVisibleLogicalRange(range);
    isSyncingCrosshair = false;
  });
}

function renderRSChart(rsRows: any[]) {
  if (!rsChartEl.value) return;

  if (rsChart) {
    rsChart.remove();
    rsChart = null;
  }

  rsChart = createChart(rsChartEl.value, {
    layout: {
      background: { type: ColorType.Solid, color: "#1a1d27" },
      textColor: "#aaa",
    },
    grid: {
      vertLines: { color: "#2a2d37" },
      horzLines: { color: "#2a2d37" },
    },
    width: rsChartEl.value.clientWidth,
    height: 250,
    timeScale: {
      borderColor: "#2a2d37",
    },
    rightPriceScale: {
      borderColor: "#2a2d37",
      autoScale: false,
      scaleMargins: { top: 0.05, bottom: 0.05 },
    },
  });

  // 检测无数据月份间隙（连续超过 25 个日历天视为 gap）
  const GAP_THRESHOLD = 25; // days
  interface GapRange { from: string; to: string }
  const gaps: GapRange[] = [];

  for (let i = 1; i < rsRows.length; i++) {
    const prevDate = new Date(rsRows[i - 1].date);
    const currDate = new Date(rsRows[i].date);
    const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > GAP_THRESHOLD) {
      gaps.push({ from: rsRows[i - 1].date, to: rsRows[i].date });
    }
  }

  // 灰色背景 area series 标记 gap 区间
  if (gaps.length > 0) {
    const gapAreaSeries = rsChart.addAreaSeries({
      topColor: "rgba(80, 80, 80, 0.15)",
      bottomColor: "rgba(80, 80, 80, 0.15)",
      lineColor: "transparent",
      lineWidth: 0,
      priceScaleId: "gap-bg",
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    rsChart.priceScale("gap-bg").applyOptions({
      scaleMargins: { top: 0, bottom: 0 },
      visible: false,
    });

    // 为每个 gap 生成 area 数据点（高值=100 覆盖全图）
    const gapData: { time: string; value: number }[] = [];
    for (const gap of gaps) {
      // gap 起止点
      gapData.push({ time: gap.from, value: 0 });
      // gap 开始后 1 天
      const fromNext = new Date(gap.from);
      fromNext.setDate(fromNext.getDate() + 1);
      gapData.push({ time: fromNext.toISOString().slice(0, 10), value: 100 });
      // gap 结束前 1 天
      const toPrev = new Date(gap.to);
      toPrev.setDate(toPrev.getDate() - 1);
      if (toPrev > fromNext) {
        gapData.push({ time: toPrev.toISOString().slice(0, 10), value: 100 });
      }
      gapData.push({ time: gap.to, value: 0 });
    }
    gapAreaSeries.setData(gapData);
  }

  // RS Rating 线
  rsLineSeries = rsChart.addLineSeries({
    color: "#f5a623",
    lineWidth: 2,
    priceFormat: { type: "custom", formatter: (v: number) => v.toFixed(0) },
  });

  rsLineSeries.setData(
    rsRows.map((r: any) => ({
      time: r.date,
      value: r.rating,
    }))
  );

  // 80 线（CAN SLIM 标准线）
  const line80 = rsChart.addLineSeries({
    color: "rgba(217, 48, 37, 0.5)",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    priceFormat: { type: "custom", formatter: () => "80" },
    crosshairMarkerVisible: false,
    lastValueVisible: false,
  });

  if (rsRows.length >= 2) {
    line80.setData([
      { time: rsRows[0].date, value: 80 },
      { time: rsRows[rsRows.length - 1].date, value: 80 },
    ]);
  }

  rsChart.timeScale().fitContent();

  // crosshair 联动：RS → price
  rsChart.subscribeCrosshairMove((param) => {
    if (isSyncingCrosshair || !priceChart) return;
    isSyncingCrosshair = true;
    if (param.time) {
      priceChart.setCrosshairPosition(NaN, param.time, candleSeries!);
    } else {
      priceChart.clearCrosshairPosition();
    }
    isSyncingCrosshair = false;
  });

  // timeScale 联动：RS → price
  rsChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (isSyncingCrosshair || !priceChart || !range) return;
    isSyncingCrosshair = true;
    priceChart.timeScale().setVisibleLogicalRange(range);
    isSyncingCrosshair = false;
  });
}

function setRange(r: string) {
  range.value = r;
  fetchAndRender();
}

const rsBigClass = computed(() => {
  if (!latestRS.value) return "";
  const r = latestRS.value.rating;
  if (r >= 90) return "rs-big-hot";
  if (r >= 80) return "rs-big-warm";
  return "rs-big-neutral";
});

// resize 处理
function handleResize() {
  if (priceChart && priceChartEl.value) {
    priceChart.applyOptions({ width: priceChartEl.value.clientWidth });
  }
  if (rsChart && rsChartEl.value) {
    rsChart.applyOptions({ width: rsChartEl.value.clientWidth });
  }
}

onMounted(() => {
  fetchAndRender();
  window.addEventListener("resize", handleResize);
});

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
  priceChart?.remove();
  rsChart?.remove();
});
</script>

<style scoped>
.stock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.btn-back {
  font-size: 0.8rem;
  padding: 0.35rem 0.7rem;
}
.ticker-title {
  font-size: 1.8rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: 1px;
}

.rs-big {
  text-align: center;
  padding: 0.8rem 1.2rem;
  border-radius: 10px;
  min-width: 100px;
}
.rs-big-hot { background: rgba(217, 48, 37, 0.2); border: 1px solid #d93025; }
.rs-big-warm { background: rgba(232, 160, 26, 0.2); border: 1px solid #e8a01a; }
.rs-big-neutral { background: rgba(68, 68, 68, 0.3); border: 1px solid #444; }

.rs-label { font-size: 0.7rem; color: #888; text-transform: uppercase; }
.rs-value { font-size: 2rem; font-weight: 800; color: #fff; }
.rs-pct { font-size: 0.75rem; color: #aaa; }

.range-bar {
  display: flex;
  gap: 0.4rem;
}
.range-bar .btn {
  padding: 0.3rem 0.8rem;
  font-size: 0.8rem;
}

.chart-card h2 { margin-bottom: 0.8rem; }
.chart-container {
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
}
.detail-item {
  padding: 0.8rem;
  background: #22252f;
  border-radius: 8px;
}
.detail-label {
  display: block;
  font-size: 0.75rem;
  color: #888;
  margin-bottom: 0.3rem;
}
.detail-value {
  font-size: 1.1rem;
  font-weight: 600;
  color: #fff;
}
</style>

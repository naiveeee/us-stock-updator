<template>
  <div v-if="pending" class="loading">加载中...</div>
  <div v-else-if="error" class="error-msg">加载失败: {{ error.message }}</div>
  <div v-else-if="data" class="stock-detail">
    <!-- 头部 -->
    <div class="stock-header">
      <div>
        <h1>{{ ticker }}</h1>
        <div class="stock-meta">
          ${{ data.bars?.length ? data.bars[data.bars.length - 1].close.toFixed(2) : '-' }}
          <span v-if="weekChange != null" :class="weekChange >= 0 ? 'text-red' : 'text-green'">
            {{ weekChange >= 0 ? '▲' : '▼' }} {{ Math.abs(weekChange).toFixed(2) }}%
          </span>
          <span class="text-muted">· {{ data.count }} 周数据</span>
        </div>
      </div>
      <NuxtLink to="/screener" class="btn btn-sm">← 返回选股</NuxtLink>
    </div>

    <!-- 周期切换 -->
    <div class="range-selector">
      <button
        v-for="r in ranges"
        :key="r.weeks"
        :class="['btn', 'btn-sm', { 'btn-primary': selectedRange === r.weeks }]"
        @click="selectedRange = r.weeks"
      >{{ r.label }}</button>
    </div>

    <!-- K 线图 -->
    <div class="card chart-card">
      <div ref="chartContainer" class="chart-container"></div>
    </div>

    <!-- MACD 副图 -->
    <div class="card chart-card">
      <h2>MACD</h2>
      <div ref="macdContainer" class="chart-container-sm"></div>
    </div>

    <!-- RSI 副图 -->
    <div class="card chart-card">
      <h2>RSI (14)</h2>
      <div ref="rsiContainer" class="chart-container-sm"></div>
    </div>

    <!-- 信号列表 -->
    <div class="card" v-if="data.signals?.length">
      <h2>📡 选股信号</h2>
      <div class="signal-grid">
        <div v-for="sig in data.signals" :key="sig.signal_type" class="signal-card">
          <div class="signal-card-header">
            <span :class="sig.side === 'left' ? 'text-red' : 'text-green'">
              {{ sig.side === 'left' ? '🔴 左侧' : '🟢 右侧' }}
            </span>
            <span class="text-muted">{{ sig.value }}/{{ sig.max_value }}</span>
          </div>
          <div class="signal-desc">{{ sig.description }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { createChart, type IChartApi, ColorType, LineStyle } from "lightweight-charts";

const route = useRoute();
const ticker = computed(() => (route.params.ticker as string).toUpperCase());

const selectedRange = ref(104);
const ranges = [
  { label: "6M", weeks: 26 },
  { label: "1Y", weeks: 52 },
  { label: "2Y", weeks: 104 },
  { label: "5Y", weeks: 260 },
];

const chartContainer = ref<HTMLElement | null>(null);
const macdContainer = ref<HTMLElement | null>(null);
const rsiContainer = ref<HTMLElement | null>(null);

let mainChart: IChartApi | null = null;
let macdChart: IChartApi | null = null;
let rsiChart: IChartApi | null = null;

// key 随 ticker+range 变化，保证客户端导航时重新请求（避免 SSR 缓存）
const fetchKey = computed(() => `weekly-${ticker.value}-${selectedRange.value}`);
const { data, pending, error } = useFetch<any>("/api/stocks/weekly", {
  key: fetchKey.value,
  query: computed(() => ({
    ticker: ticker.value,
    weeks: selectedRange.value,
  })),
  watch: [ticker, selectedRange],
});

const weekChange = computed(() => {
  if (!data.value?.bars?.length || data.value.bars.length < 2) return null;
  const bars = data.value.bars;
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 2].close;
  return ((last - prev) / prev) * 100;
});

function createChartOptions(container: HTMLElement, height: number) {
  return createChart(container, {
    width: container.clientWidth,
    height,
    layout: {
      background: { type: ColorType.Solid, color: "#1a1d27" },
      textColor: "#888",
    },
    grid: {
      vertLines: { color: "#2a2d37" },
      horzLines: { color: "#2a2d37" },
    },
    crosshair: {
      mode: 0, // Normal
    },
    timeScale: {
      borderColor: "#2a2d37",
    },
    rightPriceScale: {
      borderColor: "#2a2d37",
    },
  });
}

function drawCharts() {
  if (!data.value?.bars?.length) return;

  const bars = data.value.bars;
  const indicators = data.value.indicators;

  // ── 主图：K 线 + 成交量 ──
  if (chartContainer.value) {
    if (mainChart) mainChart.remove();
    mainChart = createChartOptions(chartContainer.value, 400);

    // K 线
    const candleSeries = mainChart.addCandlestickSeries({
      upColor: "#ea4335",
      downColor: "#34a853",
      borderUpColor: "#ea4335",
      borderDownColor: "#34a853",
      wickUpColor: "#ea4335",
      wickDownColor: "#34a853",
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
    const volumeSeries = mainChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    mainChart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeries.setData(
      bars.map((b: any) => ({
        time: b.date,
        value: b.volume,
        color: b.close >= b.open ? "rgba(234,67,53,0.3)" : "rgba(52,168,83,0.3)",
      }))
    );

    // 均线 MA20
    if (indicators?.ma?.length) {
      const ma20Data = indicators.ma
        .filter((m: any) => m.ma20 != null)
        .map((m: any) => ({ time: m.date, value: m.ma20 }));
      if (ma20Data.length > 0) {
        const ma20Series = mainChart.addLineSeries({
          color: "#e8a01a",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        ma20Series.setData(ma20Data);
      }
    }

    mainChart.timeScale().fitContent();
  }

  // ── MACD 副图 ──
  if (macdContainer.value && indicators?.macd?.length) {
    if (macdChart) macdChart.remove();
    macdChart = createChartOptions(macdContainer.value, 180);

    const difSeries = macdChart.addLineSeries({
      color: "#4da6ff",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    difSeries.setData(
      indicators.macd.map((m: any) => ({ time: m.date, value: m.dif }))
    );

    const deaSeries = macdChart.addLineSeries({
      color: "#e8a01a",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    deaSeries.setData(
      indicators.macd.map((m: any) => ({ time: m.date, value: m.dea }))
    );

    const histSeries = macdChart.addHistogramSeries({
      priceLineVisible: false,
      lastValueVisible: false,
    });
    histSeries.setData(
      indicators.macd.map((m: any) => ({
        time: m.date,
        value: m.histogram,
        color: m.histogram >= 0 ? "rgba(234,67,53,0.6)" : "rgba(52,168,83,0.6)",
      }))
    );

    // 零线
    difSeries.createPriceLine({
      price: 0,
      color: "#555",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });

    macdChart.timeScale().fitContent();
  }

  // ── RSI 副图 ──
  if (rsiContainer.value && indicators?.rsi?.length) {
    if (rsiChart) rsiChart.remove();
    rsiChart = createChartOptions(rsiContainer.value, 150);

    const rsiSeries = rsiChart.addLineSeries({
      color: "#a855f7",
      lineWidth: 1.5,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    rsiSeries.setData(
      indicators.rsi.map((r: any) => ({ time: r.date, value: r.rsi }))
    );

    // 超买/超卖线
    rsiSeries.createPriceLine({
      price: 70,
      color: "#ea4335",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "超买",
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: "#34a853",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "超卖",
    });

    rsiChart.timeScale().fitContent();
  }
}

// 监听数据变化，重绘图表
watch(data, () => {
  nextTick(() => drawCharts());
});

onMounted(() => {
  if (data.value) {
    nextTick(() => drawCharts());
  }
});

onUnmounted(() => {
  if (mainChart) mainChart.remove();
  if (macdChart) macdChart.remove();
  if (rsiChart) rsiChart.remove();
});

// 窗口 resize 处理
if (import.meta.client) {
  const handleResize = () => {
    if (mainChart && chartContainer.value) {
      mainChart.resize(chartContainer.value.clientWidth, 400);
    }
    if (macdChart && macdContainer.value) {
      macdChart.resize(macdContainer.value.clientWidth, 180);
    }
    if (rsiChart && rsiContainer.value) {
      rsiChart.resize(rsiContainer.value.clientWidth, 150);
    }
  };
  onMounted(() => window.addEventListener("resize", handleResize));
  onUnmounted(() => window.removeEventListener("resize", handleResize));
}
</script>

<style scoped>
.stock-detail { max-width: 100%; }

.stock-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.stock-header h1 { font-size: 1.8rem; }
.stock-meta { font-size: 1rem; margin-top: 0.3rem; }

.range-selector {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.chart-card { padding: 1rem; }
.chart-container { width: 100%; height: 400px; }
.chart-container-sm { width: 100%; height: 180px; }

.signal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.8rem;
}
.signal-card {
  background: #22252f;
  padding: 0.8rem;
  border-radius: 8px;
}
.signal-card-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  margin-bottom: 0.3rem;
}
.signal-desc { font-size: 0.85rem; color: #ccc; }

.loading, .error-msg {
  text-align: center;
  padding: 3rem;
}
.error-msg { color: #ea4335; }
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
</style>

<template>
  <div>
    <div class="screener-header">
      <h1>📊 Stock Screener</h1>
      <div class="header-actions">
        <button @click="runPipeline" :disabled="pipelineRunning" class="btn btn-success btn-sm">
          {{ pipelineRunning ? '⏳ 运行中...' : '🔄 运行流水线' }}
        </button>
        <span v-if="data" class="text-muted" style="font-size:0.8rem;">
          更新: {{ data.scan_date }}
        </span>
      </div>
    </div>

    <!-- Tab 切换 -->
    <div class="tab-bar">
      <button
        :class="['tab', { active: activeSide === 'left' }]"
        @click="activeSide = 'left'"
      >
        🔴 左侧机会 <span v-if="data && activeSide==='left'" class="tab-count">{{ data.total }}</span>
      </button>
      <button
        :class="['tab', { active: activeSide === 'right' }]"
        @click="activeSide = 'right'"
      >
        🟢 右侧机会 <span v-if="data && activeSide==='right'" class="tab-count">{{ data.total }}</span>
      </button>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <div class="search-box">
        <input
          v-model="searchTicker"
          placeholder="搜索 Ticker..."
          class="search-input"
          @keyup.enter="currentPage = 1"
        />
        <span v-if="searchTicker" class="search-clear" @click="searchTicker = ''">✕</span>
      </div>
      <select v-model="filterIndex" class="filter-select">
        <option value="">全部股票</option>
        <option value="sp500">S&amp;P 500</option>
        <option value="nasdaq100">NASDAQ 100</option>
      </select>
      <select v-model="filterGrade" class="filter-select">
        <option value="">全部等级</option>
        <option value="A">🔴 A级 (≥80)</option>
        <option value="B">🟠 B级 (60-79)</option>
        <option value="C">🟡 C级 (40-59)</option>
      </select>
      <select v-model="sortBy" class="filter-select">
        <option value="score">按评分</option>
        <option value="week_change_pct">按涨跌幅</option>
        <option value="avg_dollar_volume">按成交额</option>
      </select>
      <button @click="refreshIndex" :disabled="indexRefreshing" class="btn btn-sm btn-outline" title="从 Wikipedia 更新指数成分股">
        {{ indexRefreshing ? '⏳' : '🔄' }} 更新成分股
      </button>
    </div>

    <!-- 加载态 -->
    <div v-if="pending" class="loading">加载中...</div>
    <div v-else-if="error" class="error-msg">{{ error.message }}</div>

    <!-- 结果列表 -->
    <div v-else-if="data && data.results.length > 0">
      <table class="table screener-table">
        <thead>
          <tr>
            <th style="width:50px">#</th>
            <th>Ticker</th>
            <th>评分</th>
            <th>等级</th>
            <th>本周</th>
            <th>价格</th>
            <th>成交额</th>
            <th style="width:60px"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(r, idx) in data.results" :key="r.ticker">
            <tr class="result-row" @click="toggleExpand(r.ticker)">
              <td class="text-muted">{{ idx + 1 }}</td>
              <td>
                <NuxtLink :to="`/stock/${r.ticker}`" class="ticker-link" @click.stop>
                  {{ r.ticker }}
                </NuxtLink>
              </td>
              <td>
                <span class="score">{{ r.score.toFixed(0) }}</span>
              </td>
              <td>
                <span :class="['badge', `badge-${r.grade.toLowerCase()}`]">
                  {{ r.grade }}
                </span>
              </td>
              <td :class="r.week_change_pct >= 0 ? 'text-red' : 'text-green'">
                {{ r.week_change_pct >= 0 ? '+' : '' }}{{ r.week_change_pct.toFixed(2) }}%
              </td>
              <td>${{ r.latest_close?.toFixed(2) }}</td>
              <td class="text-muted">${{ formatVolume(r.avg_dollar_volume) }}</td>
              <td>
                <span class="expand-icon">{{ expandedTicker === r.ticker ? '▼' : '▶' }}</span>
              </td>
            </tr>

            <!-- 展开行：分项评分 -->
            <tr v-if="expandedTicker === r.ticker" class="expand-row">
              <td colspan="8">
                <div class="score-detail">
                  <div
                    v-for="(item, i) in getScoreItems(r)"
                    :key="i"
                    class="score-item"
                  >
                    <div class="score-item-header">
                      <span>{{ item.label }}</span>
                      <span>{{ item.value }}/{{ item.max }}</span>
                    </div>
                    <div class="score-bar-bg">
                      <div
                        class="score-bar-fill"
                        :style="{
                          width: (item.value / item.max * 100) + '%',
                          background: item.value / item.max > 0.7 ? '#34a853' : item.value / item.max > 0.4 ? '#e8a01a' : '#666'
                        }"
                      ></div>
                    </div>
                  </div>

                  <!-- 信号列表 -->
                  <div v-if="r.signals?.length" class="signal-list">
                    <div v-for="sig in r.signals" :key="sig.signal_type" class="signal-item">
                      <span class="signal-dot">●</span>
                      {{ sig.description }}
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <!-- 分页 -->
      <div v-if="data.total > data.limit" class="pagination">
        <button @click="prevPage" :disabled="currentPage <= 1" class="btn btn-sm">← 上一页</button>
        <span class="text-muted">{{ currentPage }} / {{ totalPages }}</span>
        <button @click="nextPage" :disabled="currentPage >= totalPages" class="btn btn-sm">下一页 →</button>
      </div>
    </div>

    <!-- 空结果 -->
    <div v-else class="empty-state">
      <p>暂无选股结果</p>
      <p class="text-muted">请先运行流水线生成选股数据</p>
    </div>
  </div>
</template>

<script setup lang="ts">
const activeSide = ref<"left" | "right">("left");
const searchTicker = ref("");
const filterIndex = ref("");
const filterGrade = ref("");
const sortBy = ref("score");
const currentPage = ref(1);
const pageSize = 50;
const expandedTicker = ref<string | null>(null);
const pipelineRunning = ref(false);
const indexRefreshing = ref(false);

const { data, pending, error, refresh } = useFetch<any>("/api/screener/results", {
  query: computed(() => ({
    side: activeSide.value,
    ticker: searchTicker.value || undefined,
    index: filterIndex.value || undefined,
    grade: filterGrade.value || undefined,
    sort: sortBy.value,
    limit: pageSize,
    offset: (currentPage.value - 1) * pageSize,
  })),
  watch: [activeSide, searchTicker, filterIndex, filterGrade, sortBy, currentPage],
});

const totalPages = computed(() => {
  if (!data.value) return 1;
  return Math.ceil(data.value.total / pageSize);
});

function toggleExpand(ticker: string) {
  expandedTicker.value = expandedTicker.value === ticker ? null : ticker;
}

function getScoreItems(r: any) {
  const d = r.score_detail;
  if (!d) return [];

  if (r.side === "left") {
    return [
      { label: "MACD底背离", value: d.score1, max: d.max1 },
      { label: "RSI超卖+背离", value: d.score2, max: d.max2 },
      { label: "成交量萎缩", value: d.score3, max: d.max3 },
      { label: "布林下轨", value: d.score4, max: d.max4 },
    ];
  } else {
    return [
      { label: "放量突破", value: d.score1, max: d.max1 },
      { label: "均线多头排列", value: d.score2, max: d.max2 },
      { label: "MACD零轴金叉", value: d.score3, max: d.max3 },
      { label: "OBV趋势", value: d.score4, max: d.max4 },
    ];
  }
}

function formatVolume(v: number | null): string {
  if (!v) return "-";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return v.toString();
}

function prevPage() {
  if (currentPage.value > 1) currentPage.value--;
}
function nextPage() {
  if (currentPage.value < totalPages.value) currentPage.value++;
}

async function runPipeline() {
  pipelineRunning.value = true;
  try {
    await $fetch("/api/pipeline/run", { method: "POST", body: { fullRebuild: true } });
    await refresh();
  } catch (e: any) {
    console.error(e);
  } finally {
    pipelineRunning.value = false;
  }
}

// 切换 side 时重置页码
watch(activeSide, () => {
  currentPage.value = 1;
  expandedTicker.value = null;
});
watch(filterGrade, () => { currentPage.value = 1; });
watch(filterIndex, () => { currentPage.value = 1; });
watch(sortBy, () => { currentPage.value = 1; });
watch(searchTicker, () => { currentPage.value = 1; });

async function refreshIndex() {
  indexRefreshing.value = true;
  try {
    await $fetch("/api/index/refresh", { method: "POST", body: { index: "all" } });
    await refresh();
  } catch (e: any) {
    console.error("刷新成分股失败:", e);
  } finally {
    indexRefreshing.value = false;
  }
}
</script>

<style scoped>
.screener-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}
.screener-header h1 { font-size: 1.5rem; }
.header-actions { display: flex; align-items: center; gap: 1rem; }

.tab-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.tab {
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  border: 1px solid #333;
  background: #1a1d27;
  color: #aaa;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}
.tab:hover { border-color: #555; color: #fff; }
.tab.active {
  background: #1a73e8;
  border-color: #1a73e8;
  color: #fff;
}
.tab-count {
  background: rgba(255,255,255,0.2);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-left: 0.3rem;
}

.filter-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  align-items: center;
}
.search-box {
  position: relative;
  display: flex;
  align-items: center;
}
.search-input {
  padding: 0.4rem 1.8rem 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #333;
  background: #1a1d27;
  color: #ddd;
  font-size: 0.85rem;
  width: 140px;
  transition: border-color 0.2s;
}
.search-input:focus {
  outline: none;
  border-color: #1a73e8;
}
.search-input::placeholder { color: #555; }
.search-clear {
  position: absolute;
  right: 6px;
  color: #666;
  cursor: pointer;
  font-size: 0.75rem;
  line-height: 1;
}
.search-clear:hover { color: #aaa; }
.filter-select {
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #333;
  background: #1a1d27;
  color: #ddd;
  font-size: 0.85rem;
}
.btn-outline {
  padding: 0.35rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #444;
  background: transparent;
  color: #aaa;
  font-size: 0.78rem;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.btn-outline:hover { border-color: #1a73e8; color: #fff; }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }

.screener-table { border: 1px solid #2a2d37; border-radius: 8px; overflow: hidden; }
.result-row { cursor: pointer; }
.result-row:hover { background: #22252f; }

.ticker-link {
  color: #4da6ff;
  text-decoration: none;
  font-weight: 600;
}
.ticker-link:hover { text-decoration: underline; }

.score {
  font-weight: 700;
  font-size: 1rem;
}

.expand-icon { color: #666; font-size: 0.7rem; }

.expand-row td {
  padding: 0.8rem 1rem !important;
  background: #15171f;
}

.score-detail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.8rem;
}
.score-item {
  background: #1a1d27;
  padding: 0.6rem;
  border-radius: 6px;
}
.score-item-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  margin-bottom: 0.3rem;
  color: #bbb;
}

.signal-list {
  grid-column: 1 / -1;
  margin-top: 0.5rem;
}
.signal-item {
  font-size: 0.8rem;
  color: #aaa;
  padding: 0.2rem 0;
}
.signal-dot { color: #e8a01a; margin-right: 0.3rem; }

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
  padding: 1rem 0;
}
.btn-sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }

.loading, .empty-state {
  text-align: center;
  padding: 3rem;
  color: #888;
}
.error-msg {
  text-align: center;
  padding: 2rem;
  color: #ea4335;
}
</style>

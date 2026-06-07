<template>
  <div>
    <section class="card">
      <div class="rs-header">
        <h2>📊 RS Rating 排名</h2>
        <div class="rs-meta" v-if="data">
          <input
            type="date"
            v-model="selectedDate"
            @change="onDateChange"
            class="date-picker"
          />
          <button @click="goLatestDate" class="btn btn-small" title="跳到最新">最新</button>
          <button @click="goPrevDate" class="btn btn-small" title="前一天">◀</button>
          <button @click="goNextDate" class="btn btn-small" title="后一天">▶</button>
          <span class="text-muted">· {{ data.total }} 只股票</span>
        </div>
      </div>

      <!-- 筛选栏 -->
      <div class="filters">
        <input
          v-model="searchInput"
          @input="debouncedFetch"
          type="text"
          placeholder="🔍 搜索 ticker..."
          class="filter-input"
        />
        <select v-model="selectedSector" @change="onSectorChange" class="filter-select">
          <option value="">全部板块</option>
          <option v-for="s in sectors" :key="s.name" :value="s.name">
            {{ s.name }} ({{ s.count }})
          </option>
        </select>
        <select v-model="minRating" @change="fetchData" class="filter-select">
          <option :value="0">全部 RS</option>
          <option :value="80">RS ≥ 80</option>
          <option :value="90">RS ≥ 90</option>
          <option :value="95">RS ≥ 95</option>
        </select>
        <select v-model="sortBy" @change="fetchData" class="filter-select">
          <option value="rating">按 RS 排名</option>
          <option value="volume">按成交量</option>
          <option value="change">按涨跌幅</option>
        </select>
        <div class="topn-group">
          <span class="topn-label">月度池 Top</span>
          <input type="number" v-model.number="volumeTop" @change="onTopNChange" class="topn-input" min="1" max="50000" />
          <span class="topn-presets">
            <button v-for="n in [200, 500, 1000, 2000]" :key="n"
              :class="['topn-btn', volumeTop === n && 'active']"
              @click="volumeTop = n; onTopNChange()">{{ n }}</button>
            <button :class="['topn-btn', volumeTop >= 50000 && 'active']"
              @click="volumeTop = 50000; onTopNChange()">不限</button>
          </span>
        </div>
        <button v-if="!hasRS" @click="runBackfill" :disabled="backfilling" class="btn btn-primary">
          {{ backfilling ? '回填中...' : '⚡ 回填历史 RS' }}
        </button>
        <button v-if="sectors.length === 0" @click="navigateTo('/admin')" class="btn btn-secondary">
          🏭 前往拉取行业数据
        </button>
      </div>

      <div v-if="backfillMsg" class="msg" :class="backfillMsgType">{{ backfillMsg }}</div>

      <!-- 表格 -->
      <div v-if="data && data.results.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Ticker</th>
              <th>Company</th>
              <th>Sector</th>
              <th>RS Rating</th>
              <th>Percentile</th>
              <th>Close</th>
              <th>Change%</th>
              <th>Amt</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in data.results"
              :key="row.ticker"
              @click="goToStock(row.ticker)"
              class="clickable-row"
            >
              <td class="text-muted">{{ data.offset + i + 1 }}</td>
              <td class="ticker-cell">{{ row.ticker }}</td>
              <td class="company-cell">{{ row.company_name || '-' }}</td>
              <td>
                <span v-if="row.sector" class="sector-tag">{{ row.sector }}</span>
                <span v-else class="text-muted">-</span>
              </td>
              <td>
                <span class="rs-badge" :class="rsBadgeClass(row.rating)">
                  {{ row.rating }}
                </span>
              </td>
              <td>{{ row.percentile.toFixed(1) }}%</td>
              <td>${{ row.close?.toFixed(2) }}</td>
              <td :class="row.change_pct >= 0 ? 'text-green' : 'text-red'">
                {{ row.change_pct != null ? (row.change_pct >= 0 ? '+' : '') + row.change_pct.toFixed(2) + '%' : '-' }}
              </td>
              <td>{{ formatDollarVol(row.vwap, row.close, row.volume) }}</td>
              <td class="text-muted">{{ row.score?.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="data" class="empty-state">
        <template v-if="!hasRS">
          还没有 RS 数据，点击上方「回填历史 RS」按钮开始计算
        </template>
        <template v-else>暂无匹配结果</template>
      </div>

      <!-- 分页 -->
      <div v-if="data && data.total > pageSize" class="pagination">
        <button @click="goFirstPage" :disabled="page <= 1" class="btn btn-page">«</button>
        <button @click="prevPage" :disabled="page <= 1" class="btn btn-page">‹</button>
        <span class="page-input-wrap">
          <input
            v-model.number="pageInput"
            @keyup.enter="goToPage"
            @blur="goToPage"
            type="number"
            :min="1"
            :max="totalPages"
            class="page-input"
          />
          <span class="text-muted">/ {{ totalPages }}</span>
        </span>
        <button @click="nextPage" :disabled="page >= totalPages" class="btn btn-page">›</button>
        <button @click="goLastPage" :disabled="page >= totalPages" class="btn btn-page">»</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "RsRanking" });
// localStorage 持久化
const RS_STORAGE_KEY = "rs-ranking-settings";
const data = ref<any>(null);
const searchInput = ref("");
const minRating = ref(0);
const sortBy = ref("rating");
const volumeTop = ref(500);
const selectedSector = ref("");
const page = ref(1);
const pageInput = ref(1);
const pageSize = 50;

function onTopNChange() {
  page.value = 1;
  pageInput.value = 1;
  saveRsSettings();
  fetchData();
}
const hasRS = ref(true);
const backfilling = ref(false);
const backfillMsg = ref("");
const backfillMsgType = ref("");
const sectors = ref<{ name: string; count: number }[]>([]);
const fetchingInfo = ref(false);
const selectedDate = ref("");
const rsDates = ref<string[]>([]);

function onDateChange() {
  page.value = 1;
  pageInput.value = 1;
  fetchData();
}

function goLatestDate() {
  if (rsDates.value.length > 0) {
    selectedDate.value = rsDates.value[rsDates.value.length - 1];
    onDateChange();
  }
}

function goPrevDate() {
  const idx = rsDates.value.indexOf(selectedDate.value);
  if (idx > 0) {
    selectedDate.value = rsDates.value[idx - 1];
    onDateChange();
  }
}

function goNextDate() {
  const idx = rsDates.value.indexOf(selectedDate.value);
  if (idx >= 0 && idx < rsDates.value.length - 1) {
    selectedDate.value = rsDates.value[idx + 1];
    onDateChange();
  }
}

const totalPages = computed(() => {
  if (!data.value) return 1;
  return Math.max(1, Math.ceil(data.value.total / pageSize));
});

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedFetch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    page.value = 1;
    pageInput.value = 1;
    fetchData();
  }, 300);
}

function onSectorChange() {
  page.value = 1;
  pageInput.value = 1;
  fetchData();
}

async function fetchData() {
  try {
    const params: Record<string, string | number> = {
      limit: pageSize,
      offset: (page.value - 1) * pageSize,
      sort_by: sortBy.value,
      order: "desc",
      volume_top: volumeTop.value,
    };
    if (selectedDate.value) params.date = selectedDate.value;
    if (minRating.value > 0) params.min_rating = minRating.value;
    if (searchInput.value.trim()) params.search = searchInput.value.trim();
    if (selectedSector.value) params.sector = selectedSector.value;
    // Read custom weights from localStorage
    const savedWeights = localStorage.getItem("rs-weights");
    if (savedWeights) {
      try {
        const [w1, w2, w3, w4] = JSON.parse(savedWeights);
        params.w1 = w1; params.w2 = w2; params.w3 = w3; params.w4 = w4;
      } catch {}
    }

    data.value = await $fetch("/api/rs/ranking", { params });
    hasRS.value = !(data.value.message && data.value.message.includes("No RS data"));

    // 首次加载：用返回的日期初始化日期选择器
    if (!selectedDate.value && data.value.date) {
      selectedDate.value = data.value.date;
    }
  } catch (e: any) {
    console.error(e);
  }
}

async function fetchSectors() {
  try {
    const res = await $fetch<any>("/api/ticker-info/sectors");
    sectors.value = res.sectors || [];
  } catch {
    // ticker_info 表可能还没数据
  }
}

async function runBackfill() {
  backfilling.value = true;
  backfillMsg.value = "正在启动回填...";
  backfillMsgType.value = "msg-info";
  try {
    const res = await $fetch<any>("/api/rs/backfill", { method: "POST" });
    if (res.status === "already_running" || res.status === "started") {
      backfillMsg.value = "回填进行中...";
      pollBackfillStatus();
    } else {
      backfillMsg.value = res.message;
      backfillMsgType.value = "msg-success";
      backfilling.value = false;
    }
  } catch (e: any) {
    backfillMsg.value = e?.data?.message || e.message;
    backfillMsgType.value = "msg-error";
    backfilling.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function pollBackfillStatus() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const s = await $fetch<any>("/api/rs/backfill-status");
      if (s.running) {
        const pct = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0;
        backfillMsg.value = `回填中: ${s.processed}/${s.total} 天 (${pct}%) — ${s.current}`;
        backfillMsgType.value = "msg-info";
      } else {
        // 完成了
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        backfilling.value = false;
        if (s.error) {
          backfillMsg.value = `回填失败: ${s.error}`;
          backfillMsgType.value = "msg-error";
        } else {
          const sec = s.durationMs ? (s.durationMs / 1000).toFixed(1) : "?";
          backfillMsg.value = `回填完成: ${s.processed} 个交易日, 耗时 ${sec}s`;
          backfillMsgType.value = "msg-success";
          hasRS.value = true;
          fetchData();
        }
      }
    } catch {
      // 网络错误，继续轮询
    }
  }, 2000);
}

onUnmounted(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});

function goToStock(ticker: string) {
  navigateTo(`/stock/${ticker}`);
}

function rsBadgeClass(rating: number) {
  if (rating >= 90) return "rs-hot";
  if (rating >= 80) return "rs-warm";
  if (rating >= 60) return "rs-neutral";
  return "rs-cold";
}

function formatDollarVol(vwap: number | null, close: number | null, volume: number | null) {
  if (volume == null) return "-";
  const price = vwap || close;
  if (price == null) return "-";
  const amt = price * volume;
  if (amt >= 1e9) return "$" + (amt / 1e9).toFixed(1) + "B";
  if (amt >= 1e6) return "$" + (amt / 1e6).toFixed(0) + "M";
  if (amt >= 1e3) return "$" + (amt / 1e3).toFixed(0) + "K";
  return "$" + amt.toFixed(0);
}
function formatVolume(v: number | null) {
  if (v == null) return "-";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(v);
}

function prevPage() {
  if (page.value > 1) { page.value--; pageInput.value = page.value; fetchData(); }
}
function nextPage() {
  if (page.value < totalPages.value) { page.value++; pageInput.value = page.value; fetchData(); }
}
function goFirstPage() {
  page.value = 1; pageInput.value = 1; fetchData();
}
function goLastPage() {
  page.value = totalPages.value; pageInput.value = page.value; fetchData();
}
function goToPage() {
  let target = pageInput.value;
  if (typeof target !== "number" || isNaN(target)) { pageInput.value = page.value; return; }
  target = Math.max(1, Math.min(target, totalPages.value));
  if (target === page.value) { pageInput.value = target; return; }
  page.value = target;
  pageInput.value = target;
  fetchData();
}

function saveRsSettings() {
  try {
    localStorage.setItem(RS_STORAGE_KEY, JSON.stringify({
      minRating: minRating.value,
      sortBy: sortBy.value,
      volumeTop: volumeTop.value,
      selectedSector: selectedSector.value,
    }));
  } catch {}
}

onMounted(async () => {
  // 从 localStorage 恢复设置
  try {
    const raw = localStorage.getItem(RS_STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.minRating != null) minRating.value = s.minRating;
      if (s.sortBy) sortBy.value = s.sortBy;
      if (s.volumeTop != null) volumeTop.value = s.volumeTop;
      if (s.selectedSector) selectedSector.value = s.selectedSector;
    }
  } catch {}

  // 参数变更自动保存
  watch([minRating, sortBy, volumeTop, selectedSector], saveRsSettings);

  // 获取有 RS 数据的日期列表
  try {
    const res = await $fetch<any>("/api/rs/dates");
    rsDates.value = res.dates || [];
    // 默认选最新日期
    if (res.latest) {
      selectedDate.value = res.latest;
    }
  } catch {}

  fetchData();
  fetchSectors();
  // 检查是否有正在运行的回填任务
  try {
    const s = await $fetch<any>("/api/rs/backfill-status");
    if (s.running) {
      backfilling.value = true;
      backfillMsg.value = "回填进行中...";
      backfillMsgType.value = "msg-info";
      pollBackfillStatus();
    }
  } catch {}
});
</script>

<style scoped>
.rs-header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1rem;
}
.rs-header h2 { margin-bottom: 0; }
.rs-meta {
  font-size: 0.8rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.date-picker {
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #444;
  background: #282b36;
  color: #ddd;
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
}
.date-picker::-webkit-calendar-picker-indicator {
  filter: invert(0.7);
  cursor: pointer;
}

.btn-small {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  border-radius: 4px;
  background: #333;
  color: #ccc;
  border: 1px solid #444;
  cursor: pointer;
}
.btn-small:hover { background: #444; }

.filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.filter-input {
  padding: 0.45rem 0.8rem;
  border-radius: 6px;
  border: 1px solid #333;
  background: #222;
  color: #ddd;
  font-size: 0.85rem;
  width: 180px;
}
.filter-select {
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #333;
  background: #222;
  color: #ddd;
  font-size: 0.85rem;
}

.table-wrap { overflow-x: auto; }

.clickable-row { cursor: pointer; }
.clickable-row:hover { background: #282b36 !important; }

.ticker-cell {
  font-weight: 600;
  color: #fff;
}

.company-cell {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  color: #999;
}

.sector-tag {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-size: 0.72rem;
  background: #2a3040;
  color: #8ab4f8;
  white-space: nowrap;
}

.btn-secondary {
  background: #333;
  color: #ccc;
  border: 1px solid #555;
  padding: 0.45rem 0.8rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn-secondary:hover { background: #444; }
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.rs-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.rs-hot { background: #d93025; color: #fff; }
.rs-warm { background: #e8a01a; color: #000; }
.rs-neutral { background: #444; color: #ccc; }
.rs-cold { background: #2a2d37; color: #888; }

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 1rem;
}
.btn-page {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  border-radius: 6px;
}
.page-input-wrap {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.page-input {
  width: 52px;
  padding: 0.3rem 0.4rem;
  border-radius: 6px;
  border: 1px solid #444;
  background: #282b36;
  color: #ddd;
  font-size: 0.85rem;
  text-align: center;
  font-family: inherit;
  -moz-appearance: textfield;
}
.page-input::-webkit-outer-spin-button,
.page-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.msg {
  padding: 0.6rem 1rem;
  border-radius: 6px;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}
.msg-info { background: #1a3a5c; color: #7db8f0; }
.msg-success { background: #1a3a2c; color: #6fcf97; }
.msg-error { background: #3a1a1a; color: #f09090; }

.empty-state {
  text-align: center;
  padding: 3rem;
  color: #666;
  font-size: 0.9rem;
}

/* TopN 自定义输入 */
.topn-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.topn-label {
  font-size: 13px;
  color: #94a3b8;
  white-space: nowrap;
}
.topn-input {
  width: 72px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid #334155;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 13px;
  text-align: center;
}
.topn-input:focus {
  outline: none;
  border-color: #3b82f6;
}
.topn-presets {
  display: inline-flex;
  gap: 3px;
}
.topn-btn {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  transition: all .15s;
}
.topn-btn:hover {
  border-color: #3b82f6;
  color: #e2e8f0;
}
.topn-btn.active {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
}
</style>
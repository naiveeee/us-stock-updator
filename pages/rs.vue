<template>
  <div>
    <section class="card">
      <div class="rs-header">
        <h2>📊 RS Rating 排名</h2>
        <div class="rs-meta" v-if="data">
          <span class="text-muted">{{ data.date }}</span>
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
        <select v-model="volumeTop" @change="fetchData" class="filter-select">
          <option :value="500">成交量 Top 500</option>
          <option :value="1000">成交量 Top 1000</option>
          <option :value="3000">成交量 Top 3000</option>
          <option :value="50000">不限</option>
        </select>
        <button v-if="!hasRS" @click="runBackfill" :disabled="backfilling" class="btn btn-primary">
          {{ backfilling ? '回填中...' : '⚡ 回填历史 RS' }}
        </button>
        <button v-if="sectors.length === 0" @click="fetchTickerInfo" :disabled="fetchingInfo" class="btn btn-secondary">
          {{ fetchingInfo ? '拉取中...' : '🏭 拉取行业数据' }}
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
              <th>Volume</th>
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
              <td>{{ formatVolume(row.volume) }}</td>
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
        <button @click="prevPage" :disabled="page <= 1" class="btn">◀ 上一页</button>
        <span class="text-muted">{{ page }} / {{ totalPages }}</span>
        <button @click="nextPage" :disabled="page >= totalPages" class="btn">下一页 ▶</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
const data = ref<any>(null);
const searchInput = ref("");
const minRating = ref(0);
const sortBy = ref("rating");
const volumeTop = ref(1000);
const selectedSector = ref("");
const page = ref(1);
const pageSize = 50;
const hasRS = ref(true);
const backfilling = ref(false);
const backfillMsg = ref("");
const backfillMsgType = ref("");
const sectors = ref<{ name: string; count: number }[]>([]);
const fetchingInfo = ref(false);

const totalPages = computed(() => {
  if (!data.value) return 1;
  return Math.max(1, Math.ceil(data.value.total / pageSize));
});

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedFetch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    page.value = 1;
    fetchData();
  }, 300);
}

function onSectorChange() {
  page.value = 1;
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
    if (minRating.value > 0) params.min_rating = minRating.value;
    if (searchInput.value.trim()) params.search = searchInput.value.trim();
    if (selectedSector.value) params.sector = selectedSector.value;

    data.value = await $fetch("/api/rs/ranking", { params });
    hasRS.value = !(data.value.message && data.value.message.includes("No RS data"));
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

async function fetchTickerInfo() {
  fetchingInfo.value = true;
  backfillMsg.value = "正在拉取 ticker 行业数据（约 20 分钟）...";
  backfillMsgType.value = "msg-info";
  try {
    const res = await $fetch<any>("/api/ticker-info/fetch", { method: "POST" });
    backfillMsg.value = res.message;
    backfillMsgType.value = "msg-success";
    await fetchSectors();
  } catch (e: any) {
    backfillMsg.value = e?.data?.message || e.message;
    backfillMsgType.value = "msg-error";
  } finally {
    fetchingInfo.value = false;
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

function formatVolume(v: number | null) {
  if (v == null) return "-";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(v);
}

function prevPage() {
  if (page.value > 1) { page.value--; fetchData(); }
}
function nextPage() {
  if (page.value < totalPages.value) { page.value++; fetchData(); }
}

onMounted(async () => {
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
.rs-meta { font-size: 0.8rem; }

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
  gap: 1rem;
  margin-top: 1rem;
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
</style>

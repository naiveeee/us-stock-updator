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
      </div>

      <div v-if="backfillMsg" class="msg" :class="backfillMsgType">{{ backfillMsg }}</div>

      <!-- 表格 -->
      <div v-if="data && data.results.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Ticker</th>
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
const page = ref(1);
const pageSize = 50;
const hasRS = ref(true);
const backfilling = ref(false);
const backfillMsg = ref("");
const backfillMsgType = ref("");

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

    data.value = await $fetch("/api/rs/ranking", { params });
    hasRS.value = !(data.value.message && data.value.message.includes("No RS data"));
  } catch (e: any) {
    console.error(e);
  }
}

async function runBackfill() {
  backfilling.value = true;
  backfillMsg.value = "正在回填历史 RS Rating，可能需要几分钟...";
  backfillMsgType.value = "msg-info";
  try {
    const res = await $fetch<any>("/api/rs/backfill", { method: "POST" });
    backfillMsg.value = res.message;
    backfillMsgType.value = "msg-success";
    hasRS.value = true;
    fetchData();
  } catch (e: any) {
    backfillMsg.value = e?.data?.message || e.message;
    backfillMsgType.value = "msg-error";
  } finally {
    backfilling.value = false;
  }
}

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

onMounted(() => fetchData());
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

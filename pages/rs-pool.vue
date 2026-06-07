<template>
  <div>
    <section class="card">
      <div class="pool-header">
        <h2>🔥 RS 强势池</h2>
        <div class="pool-meta" v-if="data">
          <span class="text-muted">{{ data.date }}</span>
          <span class="text-muted">· {{ filteredResults.length }} / {{ data.total }} 只</span>
        </div>
      </div>

      <!-- 筛选栏 -->
      <div class="filters">
        <input
          v-model="searchInput"
          type="text"
          placeholder="🔍 搜索 ticker..."
          class="filter-input"
        />
        <select v-model="minTurnover" @change="applyFilter" class="filter-select">
          <option :value="0">全部成交额</option>
          <option :value="1e6">≥ $1M</option>
          <option :value="5e6">≥ $5M</option>
          <option :value="1e7">≥ $10M</option>
          <option :value="5e7">≥ $50M</option>
          <option :value="1e8">≥ $100M</option>
          <option :value="5e8">≥ $500M</option>
          <option :value="1e9">≥ $1B</option>
        </select>
        <select v-model="sortKey" @change="applyFilter" class="filter-select">
          <option value="days_in_pool">按入池天数</option>
          <option value="current_rating">按 RS Rating</option>
          <option value="turnover">按成交额</option>
          <option value="pct_3m">按 3M 涨幅</option>
          <option value="score">按得分</option>
        </select>
        <button @click="showParams = !showParams" class="btn btn-small">
          ⚙️ {{ showParams ? '收起' : '参数' }}
        </button>
      </div>

      <!-- 可调参数面板 -->
      <div v-if="showParams" class="params-panel">
        <div class="param-row">
          <label>入池阈值 R1</label>
          <input v-model.number="paramR1" type="number" min="50" max="99" class="param-input" />
        </div>
        <div class="param-row">
          <label>出池阈值 R2</label>
          <input v-model.number="paramR2" type="number" min="50" max="99" class="param-input" />
        </div>
        <div class="param-row">
          <label>入池连续天数 N</label>
          <input v-model.number="paramN" type="number" min="1" max="60" class="param-input" />
        </div>
        <div class="param-row">
          <label>出池连续天数 M</label>
          <input v-model.number="paramM" type="number" min="1" max="60" class="param-input" />
        </div>
        <button @click="fetchData" class="btn btn-primary" :disabled="loading">
          {{ loading ? '加载中...' : '应用' }}
        </button>
      </div>

      <!-- 表格 -->
      <div v-if="filteredResults.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Ticker</th>
              <th>RS Rating</th>
              <th>入池日</th>
              <th>天数</th>
              <th>Close</th>
              <th>3M%</th>
              <th>R²</th>
              <th>Score</th>
              <th>日成交额</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in paginatedResults"
              :key="row.ticker"
              @click="goToStock(row.ticker)"
              class="clickable-row"
            >
              <td class="text-muted">{{ (page - 1) * pageSize + i + 1 }}</td>
              <td class="ticker-cell">{{ row.ticker }}</td>
              <td>
                <span class="rs-badge" :class="rsBadgeClass(row.current_rating)">
                  {{ row.current_rating }}
                </span>
              </td>
              <td class="text-muted">{{ row.entry_date }}</td>
              <td>
                <span class="days-badge" :class="daysBadgeClass(row.days_in_pool)">
                  {{ row.days_in_pool }}d
                </span>
              </td>
              <td>${{ row.close?.toFixed(2) }}</td>
              <td :class="row.pct_3m >= 0 ? 'text-green' : 'text-red'">
                {{ row.pct_3m != null ? (row.pct_3m >= 0 ? '+' : '') + row.pct_3m.toFixed(1) + '%' : '-' }}
              </td>
              <td>{{ row.r2?.toFixed(2) }}</td>
              <td class="text-muted">{{ row.score?.toFixed(1) }}</td>
              <td>{{ formatTurnover(row.turnover) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="data && !loading" class="empty-state">
        暂无匹配结果
      </div>

      <div v-if="loading" class="empty-state">加载中...</div>

      <!-- 分页 -->
      <div v-if="totalPages > 1" class="pagination">
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
defineOptions({ name: "RsPool" });
interface PoolItem {
  ticker: string;
  entry_date: string;
  days_in_pool: number;
  current_rating: number;
  pct_3m: number;
  r2: number;
  score: number;
  close: number;
  turnover: number;
}

const data = ref<{ date: string; params: any; total: number; results: PoolItem[] } | null>(null);
const loading = ref(false);
const searchInput = ref("");
// localStorage 持久化
const STORAGE_KEY = "rs-pool-settings";
const minTurnover = ref(0);
const sortKey = ref("days_in_pool");
const showParams = ref(false);
const page = ref(1);
const pageInput = ref(1);
const pageSize = 50;

// 可调参数
const paramN = ref(10);
const paramM = ref(10);
const paramR1 = ref(95);
const paramR2 = ref(85);

// 客户端挂载后从 localStorage 恢复设置
onMounted(() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.minTurnover != null) minTurnover.value = s.minTurnover;
      if (s.sortKey) sortKey.value = s.sortKey;
      if (s.paramN != null) paramN.value = s.paramN;
      if (s.paramM != null) paramM.value = s.paramM;
      if (s.paramR1 != null) paramR1.value = s.paramR1;
      if (s.paramR2 != null) paramR2.value = s.paramR2;
    }
  } catch {}

  // 参数变更自动保存到 localStorage
  watch([minTurnover, sortKey, paramN, paramM, paramR1, paramR2], () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        minTurnover: minTurnover.value,
        sortKey: sortKey.value,
        paramN: paramN.value,
        paramM: paramM.value,
        paramR1: paramR1.value,
        paramR2: paramR2.value,
      }));
    } catch {}
  });
});

// 过滤 + 排序（前端完成，API 一次返回全量池数据）
const filteredResults = computed(() => {
  if (!data.value) return [];
  let list = data.value.results;

  // 搜索
  const q = searchInput.value.trim().toUpperCase();
  if (q) {
    list = list.filter(r => r.ticker.includes(q));
  }

  // 成交额过滤
  if (minTurnover.value > 0) {
    list = list.filter(r => r.turnover >= minTurnover.value);
  }

  // 排序
  const key = sortKey.value as keyof PoolItem;
  list = [...list].sort((a, b) => {
    const va = a[key] as number;
    const vb = b[key] as number;
    if (key === "days_in_pool") return va - vb; // 升序：新入池在前
    if (key === "entry_date") return va < vb ? -1 : va > vb ? 1 : 0;
    return (vb ?? 0) - (va ?? 0); // 其他字段降序
  });

  return list;
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredResults.value.length / pageSize)));

const paginatedResults = computed(() => {
  const start = (page.value - 1) * pageSize;
  return filteredResults.value.slice(start, start + pageSize);
});

function applyFilter() {
  page.value = 1;
  pageInput.value = 1;
}

async function fetchData() {
  loading.value = true;
  try {
    data.value = await $fetch("/api/rs/pool", {
      params: {
        n: paramN.value,
        m: paramM.value,
        r1: paramR1.value,
        r2: paramR2.value,
      },
    });
    page.value = 1;
    pageInput.value = 1;
  } catch (e: any) {
    console.error("Failed to fetch pool:", e);
  } finally {
    loading.value = false;
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

function daysBadgeClass(days: number) {
  if (days >= 60) return "days-long";
  if (days >= 30) return "days-mid";
  return "days-new";
}

function formatTurnover(v: number | null) {
  if (v == null || v === 0) return "-";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(0) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + "K";
  return "$" + v.toFixed(0);
}

function prevPage() { if (page.value > 1) { page.value--; pageInput.value = page.value; } }
function nextPage() { if (page.value < totalPages.value) { page.value++; pageInput.value = page.value; } }
function goFirstPage() { page.value = 1; pageInput.value = 1; }
function goLastPage() { page.value = totalPages.value; pageInput.value = page.value; }
function goToPage() {
  let t = pageInput.value;
  if (typeof t !== "number" || isNaN(t)) { pageInput.value = page.value; return; }
  t = Math.max(1, Math.min(t, totalPages.value));
  page.value = t;
  pageInput.value = t;
}

// 搜索防抖
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    page.value = 1;
    pageInput.value = 1;
  }, 200);
});

onMounted(() => {
  fetchData();
});
</script>

<style scoped>
.pool-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.pool-header h2 { margin-bottom: 0; }
.pool-meta { display: flex; gap: 0.5rem; align-items: center; }

.filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  align-items: center;
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

.params-panel {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: flex-end;
  padding: 1rem;
  margin-bottom: 1rem;
  background: #22252f;
  border-radius: 8px;
}
.param-row {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.param-row label {
  font-size: 0.75rem;
  color: #888;
}
.param-input {
  width: 80px;
  padding: 0.4rem;
  border-radius: 6px;
  border: 1px solid #333;
  background: #1a1d27;
  color: #ddd;
  font-size: 0.85rem;
  text-align: center;
}

.btn-small {
  padding: 0.3rem 0.8rem;
  font-size: 0.8rem;
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

.days-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.78rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.days-new { background: #1b3a2a; color: #4caf50; }
.days-mid { background: #2a3040; color: #8ab4f8; }
.days-long { background: #3a2a1a; color: #ffa726; }

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

.empty-state {
  text-align: center;
  padding: 3rem;
  color: #666;
  font-size: 0.9rem;
}
</style>

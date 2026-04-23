<template>
  <div>
    <h1>📈 数据采集 & 管理</h1>
    <p class="subtitle">Massive API → SQLite | 美股每日行情数据采集 & 查询</p>

    <!-- 采集控制 -->
    <section class="card">
      <h2>🔄 采集控制</h2>
      <div class="actions">
        <button @click="startFetch" :disabled="status?.fetcher?.running" class="btn btn-primary">
          ▶️ 开始采集
        </button>
        <button @click="startFetchRetry" :disabled="status?.fetcher?.running" class="btn btn-warning">
          🔁 重试失败
        </button>
        <button @click="stopFetch" :disabled="!status?.fetcher?.running" class="btn btn-danger">
          ⏹️ 停止
        </button>
        <button @click="refreshStatus" class="btn">🔄 刷新</button>
      </div>

      <div v-if="message" class="message" :class="messageType">{{ message }}</div>

      <div v-if="status?.fetcher?.running" class="progress-section">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="progress-text">
          {{ progressPct.toFixed(1) }}%
          ({{ status.fetcher.progress.completed }}/{{ status.fetcher.progress.total }})
          — 当前: {{ status.fetcher.currentDate }}
        </div>
      </div>
    </section>

    <!-- 数据库状态 -->
    <section class="card" v-if="status">
      <h2>📊 数据库状态</h2>
      <div class="stats-grid">
        <div class="stat">
          <span class="stat-value">{{ status.database.totalRecords?.toLocaleString() }}</span>
          <span class="stat-label">总记录数</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ status.database.uniqueTickers?.toLocaleString() }}</span>
          <span class="stat-label">股票数</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ status.database.dateRange?.min_date || '-' }}</span>
          <span class="stat-label">最早日期</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ status.database.dateRange?.max_date || '-' }}</span>
          <span class="stat-label">最新日期</span>
        </div>
      </div>
    </section>

    <!-- 快速查询 -->
    <section class="card">
      <h2>🔍 快速查询</h2>
      <div class="query-form">
        <input v-model="queryTicker" placeholder="输入 Ticker (如 AAPL)" @keyup.enter="queryDaily" />
        <input v-model="queryFrom" type="date" />
        <input v-model="queryTo" type="date" />
        <button @click="queryDaily" class="btn btn-primary">查询</button>
      </div>

      <div v-if="queryResult" class="query-result">
        <p>{{ queryResult.ticker }} | {{ queryResult.from }} → {{ queryResult.to }} | {{ queryResult.count }} 条</p>
        <table class="table" v-if="queryResult.results?.length">
          <thead>
            <tr><th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>成交量</th><th>VWAP</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in queryResult.results.slice(0, 50)" :key="r.date">
              <td>{{ r.date }}</td>
              <td>{{ r.open?.toFixed(2) }}</td>
              <td>{{ r.high?.toFixed(2) }}</td>
              <td>{{ r.low?.toFixed(2) }}</td>
              <td>{{ r.close?.toFixed(2) }}</td>
              <td>{{ r.volume?.toLocaleString() }}</td>
              <td>{{ r.vwap?.toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
const status = ref<any>(null);
const message = ref("");
const messageType = ref("");

const queryTicker = ref("AAPL");
const queryFrom = ref(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
const queryTo = ref(new Date().toISOString().slice(0, 10));
const queryResult = ref<any>(null);

const progressPct = computed(() => {
  const p = status.value?.fetcher?.progress;
  if (!p || !p.total) return 0;
  return (p.completed / p.total) * 100;
});

let timer: ReturnType<typeof setInterval> | null = null;

async function refreshStatus() {
  try {
    status.value = await $fetch("/api/fetch/status");
  } catch (e: any) {
    console.error(e);
  }
}

async function startFetch() {
  try {
    const res = await $fetch<any>("/api/fetch/start", { method: "POST" });
    message.value = res.message;
    messageType.value = res.status === "started" ? "success" : "info";
    refreshStatus();
  } catch (e: any) {
    message.value = e?.data?.message || e.message;
    messageType.value = "error";
  }
}

async function startFetchRetry() {
  try {
    const res = await $fetch<any>("/api/fetch/start", {
      method: "POST",
      body: { retryErrors: true },
    });
    message.value = res.message;
    messageType.value = res.status === "started" ? "success" : "info";
    refreshStatus();
  } catch (e: any) {
    message.value = e?.data?.message || e.message;
    messageType.value = "error";
  }
}

async function stopFetch() {
  try {
    const res = await $fetch<any>("/api/fetch/stop", { method: "POST" });
    message.value = res.message;
    messageType.value = "info";
    refreshStatus();
  } catch (e: any) {
    message.value = e?.data?.message || e.message;
    messageType.value = "error";
  }
}

async function queryDaily() {
  if (!queryTicker.value) return;
  try {
    queryResult.value = await $fetch("/api/stocks/daily", {
      params: { ticker: queryTicker.value, from: queryFrom.value, to: queryTo.value, limit: 500 },
    });
  } catch (e: any) {
    message.value = e?.data?.message || e.message;
    messageType.value = "error";
  }
}

onMounted(() => {
  refreshStatus();
  timer = setInterval(refreshStatus, 5000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
h1 { font-size: 1.8rem; margin-bottom: 0.3rem; }
.subtitle { color: #888; margin-bottom: 2rem; }
.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
.message { padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.85rem; margin-bottom: 1rem; }
.message.success { background: #1b3a2a; color: #4caf50; }
.message.error { background: #3a1b1b; color: #f44336; }
.message.info { background: #1b2a3a; color: #2196f3; }
.progress-section { margin-top: 1rem; }
.progress-bar { background: #333; border-radius: 8px; height: 20px; overflow: hidden; }
.progress-fill { background: linear-gradient(90deg, #1a73e8, #34a853); height: 100%; transition: width 0.3s; border-radius: 8px; }
.progress-text { font-size: 0.8rem; color: #aaa; margin-top: 0.3rem; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.stat { text-align: center; padding: 0.8rem; background: #22252f; border-radius: 8px; }
.stat-value { display: block; font-size: 1.2rem; font-weight: 600; color: #fff; }
.stat-label { font-size: 0.75rem; color: #888; }
.query-form { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
.query-form input { padding: 0.5rem; border-radius: 6px; border: 1px solid #333; background: #222; color: #ddd; font-size: 0.85rem; }
.query-result { margin-top: 1rem; }
</style>

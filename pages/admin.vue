<template>
  <div>
    <h1>🛠️ 数据管理</h1>
    <p class="subtitle">Ticker 元数据、行业信息管理</p>

    <!-- Ticker Info 拉取 -->
    <section class="card">
      <h2>🏭 Ticker 元数据（行业信息）</h2>
      <p class="desc">
        从 Polygon API 拉取全市场 ticker 列表，再从 SEC 补充 SIC 行业代码。
        整体耗时约 20 分钟。
      </p>

      <div class="actions">
        <button
          @click="startFetch"
          :disabled="taskStatus?.running"
          class="btn btn-primary"
        >
          {{ taskStatus?.running ? '⏳ 执行中...' : '▶️ 开始拉取' }}
        </button>
        <button @click="refreshStatus" class="btn">🔄 刷新状态</button>
      </div>

      <!-- 状态消息 -->
      <div v-if="opMessage" class="msg" :class="opMessageType">{{ opMessage }}</div>

      <!-- 进度展示 -->
      <div v-if="taskStatus?.running" class="progress-section">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="progress-info">
          <span class="phase-badge" :class="'phase-' + taskStatus.phase">
            {{ phaseLabel }}
          </span>
          <span class="progress-text">{{ taskStatus.message }}</span>
        </div>
        <div class="progress-meta" v-if="taskStatus.startedAt">
          开始于: {{ formatTime(taskStatus.startedAt) }}
          · 已运行 {{ elapsed }}
        </div>
      </div>

      <!-- 上次结果 -->
      <div v-if="!taskStatus?.running && taskStatus?.phase !== 'idle'" class="result-section">
        <div class="result-badge" :class="taskStatus?.phase === 'done' ? 'result-success' : 'result-error'">
          {{ taskStatus?.phase === 'done' ? '✅ 上次执行成功' : '❌ 上次执行失败' }}
        </div>
        <div class="result-detail" v-if="taskStatus?.result">
          共 {{ taskStatus.result.total.toLocaleString() }} 只 ticker，
          {{ taskStatus.result.withSic.toLocaleString() }} 只有行业信息
        </div>
        <div class="result-detail" v-if="taskStatus?.error">
          错误: {{ taskStatus.error }}
        </div>
        <div class="result-meta" v-if="taskStatus?.finishedAt">
          完成于: {{ formatTime(taskStatus.finishedAt) }}
        </div>
      </div>
    </section>

    <!-- Ticker Info 统计 -->
    <section class="card" v-if="sectorStats">
      <h2>📊 行业数据统计</h2>
      <div class="stats-grid">
        <div class="stat">
          <span class="stat-value">{{ sectorStats.total.toLocaleString() }}</span>
          <span class="stat-label">总 Ticker 数</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ sectorStats.withSector.toLocaleString() }}</span>
          <span class="stat-label">有行业信息</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ sectorStats.sectors.length }}</span>
          <span class="stat-label">板块数</span>
        </div>
      </div>

      <table class="table" v-if="sectorStats.sectors.length">
        <thead>
          <tr><th>板块</th><th>数量</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in sectorStats.sectors" :key="s.sector">
            <td>{{ s.sector }}</td>
            <td>{{ s.count.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
interface TaskStatus {
  running: boolean;
  phase: "idle" | "polygon" | "sec" | "done" | "error";
  message: string;
  progress: { current: number; total: number };
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: { total: number; withSic: number } | null;
}

const taskStatus = ref<TaskStatus | null>(null);
const sectorStats = ref<any>(null);
const opMessage = ref("");
const opMessageType = ref("");

let pollTimer: ReturnType<typeof setInterval> | null = null;

const phaseLabel = computed(() => {
  switch (taskStatus.value?.phase) {
    case "polygon": return "Polygon";
    case "sec": return "SEC";
    case "done": return "完成";
    case "error": return "错误";
    default: return "空闲";
  }
});

const progressPct = computed(() => {
  const s = taskStatus.value;
  if (!s?.running || !s.progress.total) {
    // polygon 阶段总数未知，用页数估算（~10 页）
    if (s?.phase === "polygon" && s.progress.current > 0) {
      return Math.min(95, (s.progress.current / 12) * 100);
    }
    return 0;
  }
  return Math.min(99, (s.progress.current / s.progress.total) * 100);
});

const elapsed = computed(() => {
  if (!taskStatus.value?.startedAt) return "";
  const start = new Date(taskStatus.value.startedAt).getTime();
  const diff = Math.floor((Date.now() - start) / 1000);
  if (diff < 60) return `${diff}s`;
  const min = Math.floor(diff / 60);
  const sec = diff % 60;
  return `${min}m ${sec}s`;
});

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function refreshStatus() {
  try {
    taskStatus.value = await $fetch<TaskStatus>("/api/ticker-info/status");
    // 如果正在运行，启动轮询
    if (taskStatus.value.running && !pollTimer) {
      startPolling();
    }
    // 如果已完成，停止轮询
    if (!taskStatus.value.running && pollTimer) {
      stopPolling();
    }
  } catch (e: any) {
    console.error(e);
  }
}

async function fetchSectorStats() {
  try {
    sectorStats.value = await $fetch("/api/ticker-info/sectors");
  } catch {
    // 表可能还没数据
  }
}

async function startFetch() {
  opMessage.value = "";
  try {
    const res = await $fetch<any>("/api/ticker-info/fetch", { method: "POST" });
    if (res.status === "already_running") {
      opMessage.value = "任务已在运行中";
      opMessageType.value = "msg-info";
    } else {
      opMessage.value = "✅ 任务已启动";
      opMessageType.value = "msg-success";
    }
    // 立即刷新状态
    await refreshStatus();
    startPolling();
  } catch (e: any) {
    opMessage.value = e?.data?.message || e.message;
    opMessageType.value = "msg-error";
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await refreshStatus();
    // 完成后刷新行业数据
    if (!taskStatus.value?.running && taskStatus.value?.phase === "done") {
      fetchSectorStats();
    }
  }, 3000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(() => {
  refreshStatus();
  fetchSectorStats();
});

onUnmounted(() => {
  stopPolling();
});
</script>

<style scoped>
h1 { font-size: 1.8rem; margin-bottom: 0.3rem; }
.subtitle { color: #888; margin-bottom: 2rem; }
.desc { color: #999; font-size: 0.85rem; margin-bottom: 1rem; }
.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }

.msg {
  padding: 0.6rem 1rem;
  border-radius: 6px;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}
.msg-info { background: #1a3a5c; color: #7db8f0; }
.msg-success { background: #1a3a2c; color: #6fcf97; }
.msg-error { background: #3a1a1a; color: #f09090; }

.progress-section { margin-top: 1rem; }
.progress-bar {
  background: #333;
  border-radius: 8px;
  height: 22px;
  overflow: hidden;
}
.progress-fill {
  background: linear-gradient(90deg, #1a73e8, #34a853);
  height: 100%;
  transition: width 0.5s ease;
  border-radius: 8px;
}
.progress-info {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.5rem;
}
.phase-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.phase-polygon { background: #1a3a5c; color: #7db8f0; }
.phase-sec { background: #3a2a1a; color: #f0c87d; }
.phase-done { background: #1a3a2c; color: #6fcf97; }
.phase-error { background: #3a1a1a; color: #f09090; }

.progress-text { font-size: 0.85rem; color: #ccc; }
.progress-meta { font-size: 0.75rem; color: #888; margin-top: 0.3rem; }

.result-section { margin-top: 1rem; padding: 1rem; background: #22252f; border-radius: 8px; }
.result-badge { font-weight: 600; margin-bottom: 0.4rem; }
.result-success { color: #6fcf97; }
.result-error { color: #f09090; }
.result-detail { font-size: 0.85rem; color: #ccc; margin-top: 0.3rem; }
.result-meta { font-size: 0.75rem; color: #888; margin-top: 0.3rem; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
}
.stat {
  text-align: center;
  padding: 0.8rem;
  background: #22252f;
  border-radius: 8px;
}
.stat-value { display: block; font-size: 1.2rem; font-weight: 600; color: #fff; }
.stat-label { font-size: 0.75rem; color: #888; }
</style>

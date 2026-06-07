<template>
  <div>
    <h1>Settings</h1>
    <p class="subtitle">RS Weight Config & Data Management</p>

    <div class="tabs">
      <button v-for="tab in tabs" :key="tab.id" class="tab-btn" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">
        {{ tab.label }}
      </button>
    </div>

    <div v-if="activeTab === 'weights'" class="tab-content">
      <section class="card">
        <h2>RS Rating Weight Config</h2>
        <p class="desc">
          Adjust the weight of each period for RS rating. IBD default: 3M 40%, 6M 20%, 9M 20%, 12M 20%.
          <br>Missing periods (stock listed less than 12 months) are treated as 0% gain.
        </p>

        <div class="weight-grid">
          <div class="weight-item" v-for="(w, i) in weights" :key="i">
            <label class="weight-label">{{ w.label }}</label>
            <div class="weight-input-row">
              <input type="range" :min="0" :max="100" v-model.number="w.value" class="weight-slider" @input="onWeightChange" />
              <input type="number" :min="0" :max="100" v-model.number="w.value" class="weight-number" @input="onWeightChange" />
              <span class="weight-unit">%</span>
            </div>
          </div>
        </div>

        <div class="weight-summary">
          <span>Total: <strong :class="{ 'text-red': totalWeight === 0 }">{{ totalWeight }}%</strong></span>
          <span class="weight-note">(normalized before use, doesn't need to be exactly 100%)</span>
        </div>

        <div class="presets">
          <span class="preset-label">Presets:</span>
          <button class="btn btn-sm" @click="applyPreset([40,20,20,20])">IBD Standard</button>
          <button class="btn btn-sm" @click="applyPreset([100,0,0,0])">Pure 3M</button>
          <button class="btn btn-sm" @click="applyPreset([50,30,20,0])">Short Momentum</button>
          <button class="btn btn-sm" @click="applyPreset([25,25,25,25])">Equal Weight</button>
        </div>

        <div class="actions" style="margin-top: 1rem;">
          <button class="btn btn-primary" @click="saveWeights">Save</button>
          <button class="btn" @click="resetWeights">Reset Default</button>
        </div>
        <div v-if="weightMsg" class="msg msg-success" style="margin-top: 0.8rem;">{{ weightMsg }}</div>
      </section>
    </div>

    <div v-if="activeTab === 'data'" class="tab-content">
      <section class="card">
        <h2>Ticker Metadata (Sector Info)</h2>
        <p class="desc">Fetch all tickers from Polygon API, then supplement SIC codes from SEC. Takes about 20 minutes.</p>
        <div class="actions">
          <button @click="startFetch" :disabled="taskStatus?.running" class="btn btn-primary">
            {{ taskStatus?.running ? 'Running...' : 'Start Fetch' }}
          </button>
          <button @click="refreshStatus" class="btn">Refresh</button>
        </div>
        <div v-if="opMessage" class="msg" :class="opMessageType">{{ opMessage }}</div>
        <div v-if="taskStatus?.running" class="progress-section">
          <div class="progress-bar"><div class="progress-fill" :style="{ width: progressPct + '%' }"></div></div>
          <div class="progress-info">
            <span class="phase-badge" :class="'phase-' + taskStatus.phase">{{ phaseLabel }}</span>
            <span class="progress-text">{{ taskStatus.message }}</span>
          </div>
          <div class="progress-meta" v-if="taskStatus.startedAt">Started: {{ formatTime(taskStatus.startedAt) }} | Elapsed: {{ elapsed }}</div>
        </div>
        <div v-if="!taskStatus?.running && taskStatus?.phase !== 'idle'" class="result-section">
          <div class="result-badge" :class="taskStatus?.phase === 'done' ? 'result-success' : 'result-error'">
            {{ taskStatus?.phase === 'done' ? 'Last run succeeded' : 'Last run failed' }}
          </div>
          <div class="result-detail" v-if="taskStatus?.result">Total: {{ taskStatus.result.total.toLocaleString() }} tickers, {{ taskStatus.result.withSic.toLocaleString() }} with sector info</div>
          <div class="result-detail" v-if="taskStatus?.error">Error: {{ taskStatus.error }}</div>
          <div class="result-meta" v-if="taskStatus?.finishedAt">Finished: {{ formatTime(taskStatus.finishedAt) }}</div>
        </div>
      </section>
      <section class="card" v-if="sectorStats">
        <h2>Sector Stats</h2>
        <div class="stats-grid">
          <div class="stat"><span class="stat-value">{{ sectorStats.total.toLocaleString() }}</span><span class="stat-label">Total Tickers</span></div>
          <div class="stat"><span class="stat-value">{{ sectorStats.withSector.toLocaleString() }}</span><span class="stat-label">With Sector</span></div>
          <div class="stat"><span class="stat-value">{{ sectorStats.sectors }}</span><span class="stat-label">Sectors</span></div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
const activeTab = ref("weights");
const tabs = [
  { id: "weights", label: "RS Weights" },
  { id: "data", label: "Data Mgmt" },
];

// RS Weight Config
const STORAGE_KEY = "rs-weights";
const DEFAULT_WEIGHTS = [40, 20, 20, 20];

const weights = ref([
  { label: "Last 3 Months (Q4)", value: 40 },
  { label: "Last 6 Months (Q3)", value: 20 },
  { label: "Last 9 Months (Q2)", value: 20 },
  { label: "Last 12 Months (Q1)", value: 20 },
]);

const weightMsg = ref("");
const totalWeight = computed(() => weights.value.reduce((s, w) => s + w.value, 0));

function onWeightChange() { weightMsg.value = ""; }

function applyPreset(vals: number[]) {
  vals.forEach((v, i) => { weights.value[i].value = v; });
  weightMsg.value = "";
}

function saveWeights() {
  const vals = weights.value.map(w => w.value);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vals));
  weightMsg.value = "Saved! RS ranking page will use new weights.";
}

function resetWeights() {
  applyPreset(DEFAULT_WEIGHTS);
  localStorage.removeItem(STORAGE_KEY);
  weightMsg.value = "Restored to IBD default weights.";
}

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const vals = JSON.parse(saved) as number[];
      if (Array.isArray(vals) && vals.length === 4) {
        vals.forEach((v, i) => { weights.value[i].value = v; });
      }
    } catch {}
  }
});

// Data Management
const taskStatus = ref<any>(null);
const opMessage = ref("");
const opMessageType = ref("msg-info");
const sectorStats = ref<any>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const progressPct = computed(() => {
  if (!taskStatus.value?.running) return 0;
  const { progress } = taskStatus.value;
  if (!progress) return 0;
  return Math.min(100, Math.round((progress.current / progress.total) * 100));
});

const phaseLabel = computed(() => {
  const labels: Record<string, string> = { polygon: "Polygon API", sec: "SEC SIC", done: "Done", error: "Error", idle: "Idle" };
  return labels[taskStatus.value?.phase] || taskStatus.value?.phase || "";
});

const elapsed = computed(() => {
  if (!taskStatus.value?.startedAt) return "";
  const start = new Date(taskStatus.value.startedAt).getTime();
  const diff = Math.round((Date.now() - start) / 1000);
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
});

function formatTime(t: string) { return new Date(t).toLocaleTimeString("zh-CN"); }

async function refreshStatus() {
  try {
    taskStatus.value = await $fetch("/api/ticker-info/status");
    if (taskStatus.value?.running) startPolling(); else stopPolling();
  } catch (e: any) {
    opMessage.value = "Failed: " + e.message;
    opMessageType.value = "msg-error";
  }
}

async function startFetch() {
  try {
    opMessage.value = "";
    await $fetch("/api/ticker-info/fetch", { method: "POST" });
    opMessage.value = "Task started";
    opMessageType.value = "msg-success";
    startPolling();
    await refreshStatus();
  } catch (e: any) {
    opMessage.value = "Failed: " + e.message;
    opMessageType.value = "msg-error";
  }
}

async function fetchSectorStats() {
  try { sectorStats.value = await $fetch("/api/ticker-info/sectors"); } catch {}
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await refreshStatus();
    if (!taskStatus.value?.running && taskStatus.value?.phase === "done") fetchSectorStats();
  }, 3000);
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

onMounted(() => { refreshStatus(); fetchSectorStats(); });
onUnmounted(() => { stopPolling(); });
</script>

<style scoped>
h1 { font-size: 1.8rem; margin-bottom: 0.3rem; }
.subtitle { color: #888; margin-bottom: 1.5rem; }
.desc { color: #999; font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.5; }
.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
.tabs { display: flex; gap: 0.3rem; margin-bottom: 1.5rem; border-bottom: 1px solid #2a2d37; }
.tab-btn { padding: 0.6rem 1.2rem; border: none; background: none; color: #888; font-size: 0.9rem; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; }
.tab-btn:hover { color: #ccc; }
.tab-btn.active { color: #fff; border-bottom-color: #1a73e8; }
.weight-grid { display: grid; gap: 1.2rem; margin-bottom: 1.2rem; }
.weight-label { display: block; font-size: 0.85rem; color: #ccc; margin-bottom: 0.4rem; font-weight: 500; }
.weight-input-row { display: flex; align-items: center; gap: 0.8rem; }
.weight-slider { flex: 1; height: 6px; -webkit-appearance: none; appearance: none; background: #333; border-radius: 3px; outline: none; }
.weight-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #1a73e8; cursor: pointer; }
.weight-number { width: 60px; padding: 0.3rem 0.5rem; background: #22252f; border: 1px solid #333; border-radius: 6px; color: #fff; font-size: 0.9rem; text-align: center; }
.weight-unit { color: #888; font-size: 0.85rem; }
.weight-summary { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1rem; font-size: 0.9rem; color: #ccc; }
.weight-note { font-size: 0.75rem; color: #666; }
.presets { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.preset-label { font-size: 0.8rem; color: #888; }
.btn-sm { padding: 0.3rem 0.7rem; font-size: 0.75rem; border-radius: 6px; border: 1px solid #444; background: #2a2d37; color: #ccc; cursor: pointer; }
.btn-sm:hover { background: #3a3d47; color: #fff; }
.msg { padding: 0.6rem 1rem; border-radius: 6px; font-size: 0.85rem; margin-bottom: 1rem; }
.msg-info { background: #1a3a5c; color: #7db8f0; }
.msg-success { background: #1a3a2c; color: #6fcf97; }
.msg-error { background: #3a1a1a; color: #f09090; }
.progress-section { margin-top: 1rem; }
.progress-bar { background: #333; border-radius: 8px; height: 22px; overflow: hidden; }
.progress-fill { background: linear-gradient(90deg, #1a73e8, #34a853); height: 100%; transition: width 0.5s ease; border-radius: 8px; }
.progress-info { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
.phase-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
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
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.stat { text-align: center; padding: 0.8rem; background: #22252f; border-radius: 8px; }
.stat-value { display: block; font-size: 1.2rem; font-weight: 600; color: #fff; }
.stat-label { font-size: 0.75rem; color: #888; }
</style>

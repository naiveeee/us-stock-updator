<template>
  <div class="app-shell">
    <nav class="top-nav">
      <NuxtLink to="/" class="nav-brand">📈 US Stock Data</NuxtLink>
      <div class="nav-links">
        <NuxtLink to="/" class="nav-link">🔄 数据管理</NuxtLink>
      </div>
    </nav>
    <main class="main-content">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0f1117;
  color: #e0e0e0;
}

.app-shell { min-height: 100vh; }

.top-nav {
  display: flex;
  align-items: center;
  padding: 0.8rem 1.5rem;
  background: #1a1d27;
  border-bottom: 1px solid #2a2d37;
  position: sticky;
  top: 0;
  z-index: 100;
}
.nav-brand {
  font-size: 1.1rem;
  font-weight: 600;
  color: #fff;
  text-decoration: none;
  margin-right: 2rem;
}
.nav-links { display: flex; gap: 0.5rem; }
.nav-link {
  padding: 0.4rem 0.8rem;
  border-radius: 6px;
  font-size: 0.85rem;
  color: #aaa;
  text-decoration: none;
  transition: all 0.2s;
}
.nav-link:hover { color: #fff; background: #2a2d37; }
.nav-link.router-link-active,
.nav-link.router-link-exact-active {
  color: #fff;
  background: #1a73e8;
}

.main-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 1rem;
}

/* ── 全局组件样式 ── */
.card {
  background: #1a1d27;
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  border: 1px solid #2a2d37;
}
.card h2 {
  font-size: 1.1rem;
  margin-bottom: 1rem;
  color: #ccc;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: 1px solid #333;
  background: #222;
  color: #ddd;
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.15s;
}
.btn:hover { background: #333; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.btn-primary:hover { background: #1557b0; }
.btn-warning { background: #e8a01a; border-color: #e8a01a; color: #000; }
.btn-danger { background: #d93025; border-color: #d93025; color: #fff; }
.btn-success { background: #34a853; border-color: #34a853; color: #fff; }

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.table th, .table td {
  padding: 0.5rem 0.6rem;
  text-align: left;
  border-bottom: 1px solid #2a2d37;
}
.table th { color: #888; font-weight: 500; }
.table td { font-variant-numeric: tabular-nums; }
.table tr:hover { background: #22252f; }

.text-green { color: #34a853; }
.text-red { color: #ea4335; }
.text-muted { color: #888; }
</style>

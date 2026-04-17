// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2024-11-01",
  devtools: { enabled: false },

  // 默认端口
  devServer: {
    port: 3456,
  },

  // 运行时配置，可通过环境变量覆盖
  runtimeConfig: {
    // 服务端私有配置
    massiveApiKey: process.env.MASSIVE_API_KEY || "",
    dbPath: process.env.DB_PATH || "./data/stocks.db",

    // 公开配置（前端可访问）
    public: {
      appName: "US Stock Updator",
    },
  },

  // Nitro 服务端引擎配置
  nitro: {
    // 确保 better-sqlite3 不被打包（原生模块）
    externals: {
      inline: [],
    },
    // 预设为 Node.js 服务器
    preset: "node-server",
  },
});

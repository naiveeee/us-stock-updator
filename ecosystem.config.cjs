module.exports = {
  apps: [
    {
      name: "us-stock-updator",
      script: ".output/server/index.mjs",
      cwd: __dirname,
      env: {
        PORT: 3456,
        NODE_ENV: "production",
        MASSIVE_API_KEY: process.env.MASSIVE_API_KEY || "",
      },
      // 日志
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // 进程管理
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "512M",
      // 监听文件变化自动重启（生产环境建议关闭）
      watch: false,
    },
  ],
};

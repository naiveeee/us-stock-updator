module.exports = {
  apps: [
    {
      name: "us-stock-updator",
      script: ".output/server/index.mjs",
      cwd: "/root/work/us-stock-updator",
      env: {
        NODE_ENV: "production",
        MASSIVE_API_KEY: "VsiyG3gMoyDkLA_rsBpuStN4FK__Pw3B",
        NITRO_PORT: 3456,
      },
    },
  ],
};

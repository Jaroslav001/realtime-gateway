module.exports = {
  apps: [
    {
      name: 'realtime-gateway',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/var/log/pm2/realtime-gateway-error.log',
      out_file: '/var/log/pm2/realtime-gateway-out.log',
      merge_logs: true,
    },
  ],
};

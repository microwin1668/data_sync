module.exports = {
  apps: [{
    name: 'data-sync',
    cwd: './server',
    script: 'dist/index.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    error_file: '../logs/pm2-error.log',
    out_file: '../logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};

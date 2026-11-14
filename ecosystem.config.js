// PM2 config for a VPS: `pm2 start ecosystem.config.js && pm2 save`
// Keep instances at 1: bookings are stored in one JSON file.
module.exports = {
  apps: [{
    name: 'bookmyshow-world',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
    kill_timeout: 10000,
  }],
};

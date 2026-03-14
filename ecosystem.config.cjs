module.exports = {
  apps: [{
    name: 'codex-discord-bridge',
    script: 'scripts/start-with-proxy.mjs',
    interpreter: '/Users/aias/.nvm/versions/node/v22.22.0/bin/node',
    cwd: '/Users/aias/.openclaw/ai-bot-gateway',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      FEISHU_UNBOUND_CHAT_MODE: 'open',
      FEISHU_UNBOUND_CHAT_CWD: '/Users/aias/.openclaw/workspace'
    },
    error_file: '/tmp/codex-discord-bridge.pm2.err.log',
    out_file: '/tmp/codex-discord-bridge.pm2.out.log',
    log_file: '/tmp/codex-discord-bridge.pm2.log',
    time: true,
    merge_logs: true,
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    shutdown_with_message: true
  }]
};

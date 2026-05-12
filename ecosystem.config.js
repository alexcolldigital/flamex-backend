module.exports = {
  apps: [
    {
      name: 'flamex-api',
      script: './server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '500M',
      watch: false,
      ignore_watch: ['node_modules', 'logs'],
      max_restarts: 10,
      min_uptime: '10s',
      autorestart: true,
      combine_logs: true,
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 3000,
      shutdown_with_message: true,
      merge_logs: true
    }
  ],
  deploy: {
    production: {
      user: 'deploy',
      host: 'your-production-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:alexcolldigital/flamex-backend.git',
      path: '/var/www/flamex-api',
      'post-deploy': 'npm install && npm run prod:pm2',
      'pre-deploy-local': ''
    },
    staging: {
      user: 'deploy',
      host: 'your-staging-server.com',
      ref: 'origin/staging',
      repo: 'git@github.com:alexcolldigital/flamex-backend.git',
      path: '/var/www/flamex-api-staging',
      'post-deploy': 'npm install && npm run prod:pm2',
      'pre-deploy-local': ''
    }
  }
};

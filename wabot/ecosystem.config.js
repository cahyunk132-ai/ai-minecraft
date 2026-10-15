module.exports = {
  apps: [
    {
      name: 'hyunkbot',
      script: 'dist/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

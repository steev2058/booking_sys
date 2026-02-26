module.exports = {
  apps: [
    {
      name: 'baraka-booking',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8090,
      },
    },
  ],
};

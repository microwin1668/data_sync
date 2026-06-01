module.exports = {
  apps: [{
    name: 'data-sync',
    cwd: '/Users/microwin/microwin1668/data-sync/server',
    script: './src/index.ts',
    interpreter: 'npx',
    interpreter_args: 'tsx',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
  }]
};

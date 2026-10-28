'use strict';

const os = require('node:os');
const { createForumServer } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const forum = createForumServer({
  dbPath: process.env.DB_PATH || undefined,
  seed: process.env.SEED !== 'false',
});

forum.server.listen(port, host, () => {
  console.log('');
  console.log("  Island's forum（离岛的论坛）已启动");
  console.log(`  本机访问: http://127.0.0.1:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) {
          console.log(`  局域网(手机)访问: http://${address.address}:${port}`);
        }
      }
    }
  }
  console.log('  访客账号: linwan / demo1234');
  console.log('');
});

forum.server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。可以设置 PORT=其他端口 后重试。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭服务…`);
  const timer = setTimeout(() => process.exit(1), 5000);
  timer.unref();
  try {
    await forum.close();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

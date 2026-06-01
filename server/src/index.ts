import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from 'koa-cors';
import fs from 'fs';
import path from 'path';
import configRouter from './routes/config';
import { initDb } from './db/sqlite';

const app = new Koa();
const PORT = process.env.PORT || 3001;

// 生产环境：serve 前端静态文件
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors({ origin: '*' }));
app.use(bodyParser());

// 生产环境：先尝试作为静态文件请求处理
if (isProduction && fs.existsSync(CLIENT_DIST)) {
  const mimeMap: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
    '.woff': 'font/woff', '.ttf': 'font/ttf',
  };

  app.use(async (ctx, next) => {
    // 仅处理非 /api 开头的请求
    if (ctx.path.startsWith('/api')) {
      await next();
      return;
    }

    // 尝试匹配静态文件
    let filePath = path.join(CLIENT_DIST, ctx.path === '/' ? 'index.html' : ctx.path);
    // SPA 回退：如果文件不存在且不是 /api，返回 index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(CLIENT_DIST, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      ctx.type = mimeMap[ext] || 'application/octet-stream';
      ctx.body = fs.createReadStream(filePath);
    } else {
      await next();
    }
  });
}

app.use(configRouter.routes());
app.use(configRouter.allowedMethods());

async function start() {
  await initDb();
  app.listen(PORT, () => {
    if (isProduction) {
      console.log('OK 数据同步服务已启动 (production): http://0.0.0.0:' + PORT);
      console.log('前端静态文件: ' + CLIENT_DIST);
    } else {
      console.log('OK 数据同步服务已启动 (development): http://localhost:' + PORT);
    }
    console.log('');
    console.log('API 端点:');
    console.log('  GET    /api/config/token              - Token 配置');
    console.log('  POST   /api/config/token              - 保存 Token');
    console.log('  POST   /api/token/fetch               - 获取 Access Token');
    console.log('  GET    /api/config/pg-sources         - PG 数据源');
    console.log('  POST   /api/config/pg-sources/test    - 测试 PG 连接');
    console.log('  GET    /api/config/remote-tables      - 远程表配置');
    console.log('  POST   /api/data/fetch                - 拉取数据');
    console.log('  GET    /api/sync-configs              - 导入配置');
    console.log('  GET    /api/sync-tasks                - 定时任务');
    console.log('  GET    /api/logs/:filename            - 下载日志');
    console.log('  POST   /api/config/export             - 导出配置');
    console.log('  POST   /api/config/import             - 导入配置');
    console.log('  POST   /api/config/clear              - 清空配置');
  });
}

start().catch(console.error);

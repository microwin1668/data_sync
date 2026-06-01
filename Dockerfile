# ========== 构建阶段 ==========
FROM node:22-alpine AS builder

WORKDIR /app

# 1. 后端依赖
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci

# 2. 后端编译 TypeScript → JavaScript
COPY server/tsconfig.json ./server/
COPY server/src/ ./server/src/
RUN cd server && npx tsc

# 3. 前端依赖 & 构建
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
COPY client/ ./client/
RUN cd client && npm run build

# ========== 运行阶段 ==========
FROM node:22-alpine

WORKDIR /app

# 从 builder 复制
# - 编译后的后端 JS (server/dist/)
# - node_modules (含运行时依赖)
# - package.json (用于后续可能的 npm scripts)
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/
# - 前端构建产物
COPY --from=builder /app/client/dist ./client/dist

EXPOSE 3001

# 持久化数据
VOLUME ["/app/server/data", "/app/server/logs"]

ENV NODE_ENV=production

CMD ["node", "/app/server/dist/index.js"]

#!/bin/bash
set -e

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================"
echo "  数据同步系统 - 服务器部署"
echo "========================================"
echo ""

# 1. 安装后端依赖
echo "[1/2] 安装后端依赖..."
cd "$BASE_DIR/server"
npm install --omit=dev
echo "✅ 依赖安装完成"
echo ""

# 2. 启动 PM2
echo "[2/2] 启动 PM2..."
cd "$BASE_DIR"
mkdir -p data logs
pm2 start ecosystem.config.cjs
echo ""

# 3. 显示状态
echo "========================================"
echo "  部署完成!"
echo ""
echo "  访问地址: http://$(curl -s ip.sb 2>/dev/null || echo '服务器IP'):3001"
echo ""
pm2 status
echo ""
echo "  查看日志: pm2 logs data-sync"
echo "  重启:     pm2 restart data-sync"
echo "  停止:     pm2 stop data-sync"
echo "========================================"

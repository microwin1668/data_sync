#!/bin/bash
# ============================================
# 数据同步系统 - 本地启动脚本
# ============================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "  数据同步系统 - 启动中..."
echo "========================================"

# 1. 安装后端依赖
echo ""
echo "[1/4] 安装后端依赖..."
cd server
npm install --silent 2>/dev/null || npm install
cd ..

# 2. 安装前端依赖
echo "[2/4] 安装前端依赖..."
cd client
npm install --silent 2>/dev/null || npm install
cd ..

# 3. 构建前端
echo "[3/4] 构建前端..."
cd client
npx vite build
cd ..

# 4. 启动服务器（生产模式）
echo "[4/4] 启动服务器..."
echo ""
echo "  ➜  http://localhost:3001"
echo ""
echo "========================================"
echo ""

cd server
NODE_ENV=production npx tsx src/index.ts

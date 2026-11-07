#!/bin/bash

# ============================================
# 数据同步系统 - 本地开发一键启动脚本
# ============================================

# 保存根目录路径并进入
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "========================================"
echo "  数据同步系统 (开发模式) - 启动中..."
echo "========================================"

# 1. 检查/安装后端依赖
if [ ! -d "server/node_modules" ]; then
  echo "[1/2] 正在安装后端依赖..."
  cd server && npm install && cd "$ROOT_DIR"
else
  echo "[1/2] 后端依赖已安装，跳过"
fi

# 2. 检查/安装前端依赖
if [ ! -d "client/node_modules" ]; then
  echo "[2/2] 正在安装前端依赖..."
  cd client && npm install && cd "$ROOT_DIR"
else
  echo "[2/2] 前端依赖已安装，跳过"
fi

echo "========================================"
echo "  正在启动开发服务器..."
echo "  - 后端 API: http://localhost:3001"
echo "  - 前端 UI: http://localhost:5173"
echo "  按 Ctrl+C 停止所有服务"
echo "========================================"

# 定义清理函数，在退出时关闭所有后台进程
cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "正在停止所有后台服务..."
  # 获取所有后台进程的 PID 并杀死它们
  local pids=$(jobs -p)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
  fi
  echo "服务已成功关闭。"
}

# 绑定信号，在脚本退出或接收到中断信号时清理后台任务
trap cleanup EXIT INT TERM

# 3. 启动后端 (后台运行)
cd server
npm run dev &
cd "$ROOT_DIR"

# 4. 启动前端 (后台运行)
cd client
npm run dev &
cd "$ROOT_DIR"

# 保持脚本运行以监听 Ctrl+C 并显示输出
wait

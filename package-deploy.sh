#!/bin/bash
set -e

NAME="data-sync"
VERSION=$(date +%Y%m%d_%H%M)
OUTPUT="${NAME}-${VERSION}.zip"

echo "========================================="
echo "  打包最小部署包: $OUTPUT"
echo "========================================="

cd "$(dirname "$0")"

# 1. 编译后端
echo "[1/4] 编译后端 TypeScript..."
cd server && npx tsc && cd ..

# 2. 构建前端（跳过 tsc 类型检查，只 vite build）
echo "[2/4] 构建前端..."
cd client && npm run build && cd ..

# 3. 创建临时打包目录
echo "[3/4] 整理文件..."
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/server"
mkdir -p "$TMPDIR/client"
mkdir -p "$TMPDIR/data"
mkdir -p "$TMPDIR/logs"

# 复制后端编译产物
cp -r server/dist "$TMPDIR/server/dist"
cp server/package.json "$TMPDIR/server/"
cp server/package-lock.json "$TMPDIR/server/"

# 复制前端构建产物（从项目根目录的 client/dist）
cp -r client/dist "$TMPDIR/client/dist"

# 复制 ecosystem.config.cjs
cp ecosystem.config.cjs "$TMPDIR/" 2>/dev/null || true

# 复制部署脚本
cp install.sh "$TMPDIR/" 2>/dev/null || true

# 4. 打包
echo "[4/4] 打包 $OUTPUT..."
cd "$TMPDIR"
zip -r "$OLDPWD/$OUTPUT" . > /dev/null
cd "$OLDPWD"

# 清理临时目录
rm -rf "$TMPDIR"

echo ""
echo "✅ 打包完成!"
echo "   文件: $OUTPUT"
echo "   大小: $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "📋 服务器部署步骤（假设放到 /opt/data-sync）:"
echo "  unzip $OUTPUT -d /opt/data-sync"
echo "  cd /opt/data-sync/server"
echo "  npm install --omit=dev"
echo "  cd /opt/data-sync"
echo "  mkdir -p data logs"
echo "  node server/dist/index.js"
echo ""
echo "或用 PM2:"
echo "  pm2 start ecosystem.config.cjs"
echo ""

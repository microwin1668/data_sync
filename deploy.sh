#!/bin/bash
# ============================================================
# 数据同步系统 - 一键部署/更新脚本
#
# 首次部署(目标机任意目录执行,自动 clone 到当前目录 data-sync/):
#   bash <(curl -fsSL https://raw.githubusercontent.com/microwin1668/data_sync/main/deploy.sh)
# 或手动 clone 后执行:
#   git clone https://github.com/microwin1668/data_sync.git data-sync && cd data-sync && ./deploy.sh
#
# 日常更新(项目目录内):
#   ./deploy.sh              # git pull --ff-only,有本地改动则中止
#   ./deploy.sh --force      # 丢弃本地改动,强制对齐远端 main
#   ./deploy.sh --skip-build # 跳过构建,只重启服务
#
# 环境变量:
#   REPO_URL   仓库地址(默认 https://github.com/microwin1668/data_sync.git)
#   PORT       服务端口(默认 3001)
# ============================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/microwin1668/data_sync.git}"
PORT="${PORT:-3001}"
FORCE=0
SKIP_BUILD=0

# ---------- 输出工具 ----------
if [ -t 1 ]; then
  C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_C="\033[36m"; C_0="\033[0m"
else
  C_G=""; C_Y=""; C_R=""; C_C=""; C_0=""
fi
info()  { echo -e "${C_C}[INFO]${C_0} $*"; }
ok()    { echo -e "${C_G}  ✅${C_0} $*"; }
warn()  { echo -e "${C_Y}  ⚠️ ${C_0} $*"; }
fail()  { echo -e "${C_R}  ❌${C_0} $*"; }
step()  { echo -e "\n${C_C}======== [$1] $2 ========${C_0}"; }

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) grep '^#' "$0" | head -30; exit 0 ;;
    *) fail "未知参数: $arg"; exit 1 ;;
  esac
done

# ---------- 1. 前置检测 ----------
step "1/6" "环境检测"

have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi

PKG_MGR=""
if have apt-get; then PKG_MGR="apt"
elif have dnf; then PKG_MGR="dnf"
elif have yum; then PKG_MGR="yum"
fi

# --- git ---
if have git; then
  ok "git $(git --version | awk '{print $3}')"
else
  if [ "$PKG_MGR" = "apt" ] && [ -n "$SUDO" ]; then
    info "自动安装 git..."; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git
  elif [ "$PKG_MGR" = "dnf" ] && [ -n "$SUDO" ]; then $SUDO dnf install -y -q git
  elif [ "$PKG_MGR" = "yum" ] && [ -n "$SUDO" ]; then $SUDO yum install -y -q git
  else
    fail "未安装 git,请先安装: apt install git / yum install git / brew install git"; exit 1
  fi
  ok "git 安装完成"
fi

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

install_node22() {
  info "安装 Node.js 22..."
  if [ "$(uname -s)" = "Darwin" ]; then
    fail "macOS 请手动安装 Node 22: brew install node@22"; exit 1
  fi
  if [ -z "$SUDO" ]; then
    fail "缺少管理员权限,无法自动安装 Node 22。请用 root 执行或先手动安装:"; fail "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"; exit 1
  fi
  if [ "$PKG_MGR" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - && $SUDO apt-get install -y -qq nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash - && $SUDO "$PKG_MGR" install -y -q nodejs
  fi
}

# --- node >= 22 (better-sqlite3 原生模块硬要求) ---
if have node; then
  if [ "$(node_major)" -ge 22 ] 2>/dev/null; then
    ok "Node.js $(node -v)"
  else
    warn "当前 Node $(node -v) 版本过低,需要 >= 22,尝试自动升级..."
    install_node22
    hash -r
    if [ "$(node_major)" -ge 22 ] 2>/dev/null; then ok "Node.js 已升级到 $(node -v)"
    else fail "Node 22 安装失败,请手动安装后重试"; exit 1; fi
  fi
else
  install_node22
  hash -r
  ok "Node.js $(node -v) 安装完成"
fi

# --- pm2 ---
if ! have pm2; then
  info "安装 pm2..."
  npm install -g pm2 --silent || { fail "pm2 全局安装失败,请手动执行: npm install -g pm2"; exit 1; }
  hash -r
fi
ok "pm2 $(pm2 -v)"

# --- 编译工具链(better-sqlite3 有预编译包,通常不需要;仅告警) ---
if ! { have make && have g++; } || ! have python3; then
  warn "未检测到完整编译工具链(make/g++/python3)。better-sqlite3 通常使用预编译包,不影响部署;"
  warn "若后续 npm install 报 node-gyp 错误,请执行: apt install -y build-essential python3"
fi

# ---------- 2. 获取代码 ----------
step "2/6" "获取最新代码"

REPO_DIR=""
# 优先级: 当前目录是仓库 > 当前目录下的 data-sync > 脚本所在目录是仓库 > 全新 clone
if [ -d "$PWD/.git" ] && [ -f "$PWD/ecosystem.config.cjs" ]; then
  REPO_DIR="$PWD"
elif [ -d "$PWD/data-sync/.git" ]; then
  REPO_DIR="$PWD/data-sync"
elif [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/ecosystem.config.cjs" ] && [ -d "$(dirname "${BASH_SOURCE[0]}")/.git" ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

FRESH=0
if [ -z "$REPO_DIR" ]; then
  REPO_DIR="$PWD/data-sync"
  if [ -d "$REPO_DIR" ]; then
    fail "目录 $REPO_DIR 已存在但不是 git 仓库,请更换执行目录或手动处理"; exit 1
  fi
  info "克隆仓库 $REPO_URL -> $REPO_DIR"
  git clone --quiet "$REPO_URL" "$REPO_DIR"
  FRESH=1
fi
cd "$REPO_DIR"
# 规范化为物理路径(macOS 下 /tmp 是 /private/tmp 软链,避免与 pm2 报告的路径字符串不一致)
REPO_DIR="$(pwd -P)"
ok "代码目录: $REPO_DIR"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
if [ "$BRANCH" != "main" ]; then
  info "当前分支 $BRANCH,切换到 main..."
  git checkout main 2>/dev/null || { fail "main 分支不存在,请检查仓库"; exit 1; }
fi

if [ "$FRESH" -eq 0 ]; then
  git fetch --quiet origin
  if [ "$FORCE" -eq 1 ]; then
    warn "--force 模式:丢弃全部本地改动,强制对齐 origin/main"
    git reset --hard origin/main
  else
    # 主动检测已跟踪文件的本地改动(无新提交时 pull 不会失败,必须显式检查)
    DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null | head -5 || true)"
    if [ -n "$DIRTY" ]; then
      fail "更新中止:本地存在未提交的改动(可能与远端冲突):"
      echo "$DIRTY" | sed 's/^/       /'
      fail "  处理方式: 1) git stash 后重试  2) 确认丢弃改动则执行 ./deploy.sh --force"
      exit 1
    fi
    if ! git pull --ff-only --quiet origin main; then
      fail "更新失败:无法快进合并到 origin/main。"
      fail "  处理方式: 1) git stash 后重试  2) 确认丢弃改动则执行 ./deploy.sh --force"
      exit 1
    fi
  fi
  ok "已更新到最新提交: $(git log -1 --format='%h %s')"
else
  ok "首次部署,当前提交: $(git log -1 --format='%h %s')"
fi

# ---------- 3. 安装依赖 ----------
step "3/6" "安装依赖(server + client)"
(cd server && npm install --no-audit --no-fund --loglevel=error) && ok "server 依赖完成"
(cd client && npm install --no-audit --no-fund --loglevel=error) && ok "client 依赖完成"

# ---------- 4. 构建 ----------
step "4/6" "编译构建"
if [ "$SKIP_BUILD" -eq 1 ]; then
  if [ ! -f "server/dist/index.js" ] || [ ! -d "client/dist" ]; then
    fail "--skip-build 需要已有构建产物(server/dist, client/dist),当前缺失,请去掉该参数执行"
    exit 1
  fi
  warn "跳过构建,使用现有产物"
else
  info "编译后端 TypeScript..."
  (cd server && npx tsc) && ok "server/dist 生成"
  info "构建前端 Vite...(版本号自动 +1)"
  (cd client && npm run build --silent) && ok "client/dist 生成"
  # 还原 npm install/构建对锁定文件与版本号的改动,保持工作区干净以便下次更新
  git checkout -- client/package.json client/package-lock.json server/package-lock.json 2>/dev/null || true
fi

# ---------- 5. 启动 / 重载 ----------
step "5/6" "启动服务 (PM2)"
mkdir -p server/data logs
# pm2 的 reload 不会更新 script path/cwd:若 pm2 中已有同名应用但指向旧目录(如部署目录变更/重新 clone),
# 必须先删除旧实例再启动,否则会继续用旧路径导致崩溃循环
EXPECTED_SCRIPT="$REPO_DIR/server/dist/index.js"
# 注意:pm2 describe 在应用不存在时返回非零,set -o pipefail 下需 || true 兜底
CURRENT_SCRIPT="$(pm2 describe data-sync 2>/dev/null | awk -F'│' '/script path/{v=$3; gsub(/^ +| +$/,"",v); print v; exit}' || true)"
if [ -n "$CURRENT_SCRIPT" ] && [ "$CURRENT_SCRIPT" != "$EXPECTED_SCRIPT" ]; then
  warn "pm2 中存在旧路径实例($CURRENT_SCRIPT),与当前目录不一致,移除后重新启动"
  pm2 delete data-sync >/dev/null 2>&1 || true
fi
pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null
pm2 save >/dev/null 2>&1 || true
ok "服务已启动: pm2 进程 data-sync (端口 $PORT)"
if [ "$FRESH" -eq 1 ]; then
  warn "建议配置开机自启(需管理员密码): pm2 startup 并按提示执行输出的命令,然后 pm2 save"
fi

# ---------- 6. 健康检查 ----------
step "6/6" "健康检查"
HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/server/time" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  sleep 1
done

LOCAL_IP=""
if [ "$(uname -s)" = "Darwin" ]; then
  LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
else
  LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

if [ "$HEALTH_OK" -eq 1 ]; then
  ok "接口健康检查通过"
  echo ""
  echo -e "${C_G}========================================"
  echo -e "  🚀 部署成功!"
  echo -e "========================================${C_0}"
  echo -e "  访问地址: ${C_G}http://${LOCAL_IP:-127.0.0.1}:${PORT}${C_0}  (默认账号 admin)"
  echo ""
  echo "  常用命令:"
  echo "    pm2 status            查看运行状态"
  echo "    pm2 logs data-sync    查看日志"
  echo "    pm2 restart data-sync 重启服务"
  echo ""
  echo "  以后更新版本: 进入本目录执行 ./deploy.sh"
  echo "  数据安全: server/data/(SQLite)与 logs/ 不受更新影响"
  echo "========================================"
else
  fail "健康检查未通过(30 秒),请排查:"
  echo "    pm2 status             # 查看进程是否存活"
  echo "    pm2 logs data-sync     # 查看启动日志"
  echo "    端口占用检查: lsof -i :${PORT}"
  exit 1
fi

#!/bin/bash
# ============================================================
# 数据同步系统 - 一体化部署运维脚本
#
# 部署/更新:
#   ./deploy.sh                    # 拉取最新代码 → 编译构建 → PM2 重载 → 健康检查
#   ./deploy.sh --force            # 丢弃本地改动,强制对齐远端 main
#   ./deploy.sh --skip-build       # 跳过构建,只重启
#   (每次更新前会自动做一次配置库在线备份,存于 config-backups/)
#
# 配置数据运维:
#   ./deploy.sh --backup           # 在线备份配置库(不停服务,保留最近 10 份)
#   ./deploy.sh --restore <文件>   # 从备份恢复配置(自动 停→拷→清WAL→启→校验)
#   ./deploy.sh --status           # 查看服务状态与配置概况
#
# 首次部署(目标机任意目录执行,自动 clone 到当前目录 data-sync/):
#   bash <(curl -fsSL https://raw.githubusercontent.com/microwin1668/data_sync/main/deploy.sh)
# 或手动 clone 后执行:
#   git clone https://github.com/microwin1668/data_sync.git data-sync && cd data-sync && ./deploy.sh
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
MODE="deploy"
RESTORE_FILE=""

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

show_usage() { grep '^#' "$0" | head -28; }

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --backup) MODE="backup" ;;
    --restore) MODE="restore"; RESTORE_FILE="${2:-}"; [ $# -lt 2 ] && { fail "--restore 需要指定备份文件路径"; exit 1; }
      # 此时还未切换目录,先把相对路径固定为绝对路径
      [ -n "$RESTORE_FILE" ] && [ "${RESTORE_FILE:0:1}" != "/" ] && RESTORE_FILE="$PWD/$RESTORE_FILE"
      shift ;;
    --status) MODE="status" ;;
    -h|--help) show_usage; exit 0 ;;
    *) fail "未知参数: $1(用 -h 查看用法)"; exit 1 ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 定位代码目录(四种优先级) ----------
locate_repo() {
  REPO_DIR=""
  if [ -d "$PWD/.git" ] && [ -f "$PWD/ecosystem.config.cjs" ]; then
    REPO_DIR="$PWD"
  elif [ -d "$PWD/data-sync/.git" ]; then
    REPO_DIR="$PWD/data-sync"
  elif [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/ecosystem.config.cjs" ] && [ -d "$(dirname "${BASH_SOURCE[0]}")/.git" ]; then
    REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [ -n "$REPO_DIR" ]; then
    cd "$REPO_DIR"
    # 规范化为物理路径(macOS /tmp 是 /private/tmp 软链)
    REPO_DIR="$(pwd -P)"
  fi
}

# ---------- better-sqlite3 可用性(备份/恢复/状态需要) ----------
require_sqlite() {
  if ! have node; then fail "未找到 node,请先部署一次(./deploy.sh)以安装环境"; exit 1; fi
  if [ ! -d "server/node_modules/better-sqlite3" ]; then
    warn "server 依赖未安装,尝试自动安装(仅运行依赖)..."
    (cd server && npm install --omit=dev --no-audit --no-fund --loglevel=error) \
      || { fail "依赖安装失败;若 better-sqlite3 编译/下载报错,请先完整执行一次 ./deploy.sh"; exit 1; }
  fi
}

# ---------- 配置库计数 ----------
# 注意:better-sqlite3 装在 server/node_modules,须在 server 目录下执行 node
print_db_counts() {
  (cd server && node -e '
const Database=require("better-sqlite3");
try{
  const db=new Database("data/config.db",{readonly:true});
  const q=(t)=>{try{return db.prepare("SELECT COUNT(*) c FROM "+t).get().c}catch(e){return "-"}};
  console.log("  数据源:",q("pg_datasources"),"| 导入配置:",q("sync_configs"),"| 定时任务:",q("sync_tasks"),"| 数据库备份配置:",q("backup_configs"),"| 文件备份配置:",q("file_backup_configs"));
  db.close();
}catch(e){console.error("  打开配置库失败:",e.message);process.exit(1);}
')
}

# ---------- 在线一致性备份核心(参数:目标文件的绝对路径) ----------
do_backup_to() {
  local DEST="$1"
  (cd server && node -e '
const Database=require("better-sqlite3");
(async()=>{
  const src=new Database("data/config.db",{readonly:true});
  await src.backup(process.argv[1]);
  await src.close();
  const chk=new Database(process.argv[1],{readonly:true});
  const ok=chk.pragma("integrity_check",{simple:true});
  chk.close();
  if(ok!=="ok"){console.error("备份完整性校验失败:",ok);process.exit(1);}
})().catch(e=>{console.error(e.message);process.exit(1);});
' "$DEST")
  # 只读校验连接会留下空的 wal/shm 伴随文件,清掉
  rm -f "$DEST-wal" "$DEST-shm" 2>/dev/null || true
}

prune_backups() {
  ls -1t config-backups/*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
  # 清理已删除备份残留的空伴随文件
  for f in config-backups/*.db-wal config-backups/*.db-shm; do
    [ -f "$f" ] || continue
    base="${f%.db-wal}"; base="${base%.db-shm}"
    [ -f "$base.db" ] || rm -f "$f"
  done
}

pm2_app_exists() { pm2 describe data-sync >/dev/null 2>&1 || return 1; }

# ============================================================
# 模式:备份
# ============================================================
if [ "$MODE" = "backup" ]; then
  locate_repo
  [ -n "$REPO_DIR" ] || { fail "未找到项目目录,请在项目目录内执行,或先完成首次部署"; exit 1; }
  [ -f "server/data/config.db" ] || { fail "未找到配置库 server/data/config.db"; exit 1; }
  step "备份" "在线导出配置库(服务不中断)"
  require_sqlite
  mkdir -p config-backups
  DEST="$REPO_DIR/config-backups/config-backup-$(date +%Y%m%d_%H%M%S).db"
  do_backup_to "$DEST"
  prune_backups
  ok "备份完成: $DEST"
  print_db_counts
  echo -e "\n  恢复方法: ./deploy.sh --restore $DEST"
  exit 0
fi

# ============================================================
# 模式:恢复
# ============================================================
if [ "$MODE" = "restore" ]; then
  locate_repo
  [ -n "$REPO_DIR" ] || { fail "未找到项目目录,请在项目目录内执行"; exit 1; }
  [ -n "$RESTORE_FILE" ] || { fail "用法: ./deploy.sh --restore <备份文件.db>"; exit 1; }
  [ -f "$RESTORE_FILE" ] || { fail "备份文件不存在: $RESTORE_FILE"; exit 1; }
  step "恢复前检查" "校验备份文件"
  require_sqlite
  # 只读打开校验完整性 + 预览内容
  (cd server && node -e '
const Database=require("better-sqlite3");
const db=new Database(process.argv[1],{readonly:true});
const ok=db.pragma("integrity_check",{simple:true});
if(ok!=="ok"){console.error("  备份文件完整性校验失败:"+ok);process.exit(1);}
const q=(t)=>{try{return db.prepare("SELECT COUNT(*) c FROM "+t).get().c}catch(e){return "-"}};
console.log("  备份完整性: ok | 数据源:",q("pg_datasources"),"| 导入配置:",q("sync_configs"),"| 定时任务:",q("sync_tasks"));
db.close();
' "$RESTORE_FILE") || { fail "备份文件校验未通过,已取消恢复(未做任何改动)"; exit 1; }
  [ -f "server/data/config.db" ] || { warn "目标配置库不存在(首次部署?),将直接放入备份内容"; }

  echo -e "\n${C_Y}即将把配置恢复为以上内容,当前配置会被覆盖(覆盖前会自动再做一次保护性备份)。${C_0}"
  read -r -p "确认继续? [y/N] " ANSWER
  [ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ] || { warn "已取消,未做任何改动"; exit 0; }

  mkdir -p config-backups
  if [ -f "server/data/config.db" ]; then
    PRE="$REPO_DIR/config-backups/pre-restore-$(date +%Y%m%d_%H%M%S).db"
    info "保护性备份当前配置 → $PRE"
    do_backup_to "$PRE" || warn "保护性备份失败(当前库可能损坏),仍将继续"
  fi

  step "恢复" "停服务 → 拷贝 → 清 WAL → 启动"
  WAS_RUNNING=0
  if have pm2 && pm2_app_exists; then
    if pm2 describe data-sync 2>/dev/null | grep -q "online"; then WAS_RUNNING=1; fi
    pm2 stop data-sync >/dev/null 2>&1 || true
    ok "服务已停止"
  else
    warn "pm2 中无 data-sync 应用,仅放置文件(下次启动生效)"
  fi

  mkdir -p server/data
  cp "$RESTORE_FILE" server/data/config.db
  # 关键:清掉残留 WAL/SHM,否则启动时会重放旧 WAL 把恢复的数据覆盖掉
  rm -f server/data/config.db-wal server/data/config.db-shm
  ok "配置文件已恢复,残留 WAL/SHM 已清除"

  if [ "$WAS_RUNNING" = "1" ] && have pm2; then
    pm2 start data-sync >/dev/null 2>&1 || true
    ok "服务已启动"
    echo "== 恢复后数据库校验:"
    sleep 2
    print_db_counts
    echo "== 接口健康检查:"
    HEALTH=0
    for i in $(seq 1 15); do
      curl -sf -m 2 "http://127.0.0.1:${PORT}/api/server/time" >/dev/null 2>&1 && { HEALTH=1; break; }
      sleep 1
    done
    [ "$HEALTH" = "1" ] && ok "健康检查通过" || warn "健康检查未通过,请查看 pm2 logs data-sync"
  fi
  echo -e "\n${C_G}✅ 恢复完成。登录密码以恢复的配置为准。${C_0}"
  exit 0
fi

# ============================================================
# 模式:状态
# ============================================================
if [ "$MODE" = "status" ]; then
  locate_repo
  [ -n "$REPO_DIR" ] || { fail "未找到项目目录"; exit 1; }
  step "状态" "服务 / 版本 / 配置"
  echo "  代码提交: $(git log -1 --format='%h %s' 2>/dev/null || echo '-')"
  echo "  前端版本: $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' client/package.json 2>/dev/null | head -1)"
  if have pm2 && pm2_app_exists; then
    pm2 describe data-sync 2>/dev/null | grep -E "│ (status|script path)" | sed 's/^/  /'
    curl -sf -m 3 "http://127.0.0.1:${PORT}/api/server/time" >/dev/null 2>&1 \
      && ok "接口健康: http://127.0.0.1:${PORT}" \
      || warn "接口无响应: http://127.0.0.1:${PORT}"
  else
    warn "pm2 中无 data-sync 应用"
  fi
  [ -f "server/data/config.db" ] && { echo "  配置概况:"; print_db_counts; }
  LATEST=$(ls -1t config-backups/*.db 2>/dev/null | head -1)
  [ -n "$LATEST" ] && echo "  最近备份: $LATEST" || echo "  最近备份: 无(可执行 ./deploy.sh --backup)"
  exit 0
fi

# ============================================================
# 模式:部署 / 更新(默认)
# ============================================================
step "1/6" "环境检测"

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

# --- 编译工具链(better-sqlite3 有预编译包,仅告警) ---
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

# 更新前自动备份配置库(全新部署无配置库则跳过)
if [ "$FRESH" -eq 0 ] && [ -f "server/data/config.db" ]; then
  if require_sqlite && do_backup_to "$REPO_DIR/config-backups/auto-pre-deploy-$(date +%Y%m%d_%H%M%S).db" 2>/dev/null; then
    LATEST_BACKUP=$(ls -1t config-backups/auto-pre-deploy-*.db 2>/dev/null | head -1)
    ok "更新前已自动备份配置 → $LATEST_BACKUP"
  fi
fi
mkdir -p config-backups; prune_backups

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
  echo "    ./deploy.sh --status     查看服务与配置概况"
  echo "    ./deploy.sh --backup     备份配置数据(不停服务)"
  echo "    ./deploy.sh --restore <文件>  从备份恢复配置"
  echo "    pm2 status / pm2 logs data-sync   查看状态/日志"
  echo ""
  echo "  以后更新版本: 进入本目录执行 ./deploy.sh(更新前自动备份配置)"
  echo "  数据安全: server/data/(SQLite)与 logs/ 不受更新影响"
  echo "========================================"
else
  fail "健康检查未通过(30 秒),请排查:"
  echo "    pm2 status             # 查看进程是否存活"
  echo "    pm2 logs data-sync     # 查看启动日志"
  echo "    端口占用检查: lsof -i :${PORT}"
  exit 1
fi

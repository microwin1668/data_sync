import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  listBackupConfigs, getBackupConfig, createBackupLog, updateBackupLog,
  listPgDatasources, updateBackupRunTime, updateTaskExecutionLog,
} from '../db/sqlite';

let backupInterval: NodeJS.Timeout | null = null;

// 定期将进度写入 backup_log 的 error_message 字段
let progressLogTimers = new Map<number, NodeJS.Timeout>();

function startProgressLogUpdates(logId: number, configId: number) {
  if (progressLogTimers.has(logId)) return;
  const timer = setInterval(async () => {
    const prog = backupProgressMap.get(configId);
    if (!prog) return;
    try {
      await updateBackupLog(logId, {
        error_message: JSON.stringify({
          progress: prog.progress,
          message: prog.message,
          doneTables: prog.doneTables,
          totalTables: prog.totalTables,
          currentTable: prog.currentTable,
        }),
      });
    } catch {}
  }, 2000);
  progressLogTimers.set(logId, timer);
}

function stopProgressLogUpdates(logId: number) {
  const timer = progressLogTimers.get(logId);
  if (timer) { clearInterval(timer); progressLogTimers.delete(logId); }
}

// 存储正在运行的 pg_dump 子进程，用于停止
const runningPgDumps = new Map<number, { process: any; logId: number }>();

// 安装进度跟踪
let installProgress: { status: string; message: string; stage: string } = { status: 'idle', message: '', stage: '' };

export function getInstallProgress() {
  return installProgress;
}

export function resetInstallProgress() {
  installProgress = { status: 'idle', message: '', stage: '' };
}

// 监视备份进度并更新 task_execution_log
const progressMonitors = new Map<number, NodeJS.Timeout>();
// 反向映射: configId → [logId]
const configToExecLogIds = new Map<number, number[]>();

export function startBackupProgressMonitor(configId: number, logId: number) {
  stopBackupProgressMonitor(logId);
  const timer = setInterval(async () => {
    const prog = backupProgressMap.get(configId);
    if (!prog) return;
    try {
      // 更新 task_execution_log
      if (prog.status === 'success') {
        await updateTaskExecutionLog(logId, {
          status: 'success',
          total_records: prog.totalTables || 0,
          success_count: prog.doneTables || 0,
          error_message: prog.message,
          backup_file: prog.filename || '',
          file_size: prog.fileSize || 0,
        });
        clearInterval(timer);
        progressMonitors.delete(logId);
      } else if (prog.status === 'error') {
        await updateTaskExecutionLog(logId, {
          status: 'error',
          error_message: prog.message || '备份失败',
          total_records: prog.totalTables || 0,
          success_count: prog.doneTables || 0,
        });
        clearInterval(timer);
        progressMonitors.delete(logId);
      } else {
        await updateTaskExecutionLog(logId, {
          status: 'running',
          total_records: prog.totalTables || 0,
          success_count: prog.doneTables || 0,
          error_count: prog.progress,
          error_message: prog.message,
        });
      }
    } catch {}
  }, 2000);
  progressMonitors.set(logId, timer);
  // 记录反向映射
  if (!configToExecLogIds.has(configId)) configToExecLogIds.set(configId, []);
  const ids = configToExecLogIds.get(configId)!;
  if (!ids.includes(logId)) ids.push(logId);
}

export function stopBackupProgressMonitor(logId: number) {
  const timer = progressMonitors.get(logId);
  if (timer) { clearInterval(timer); progressMonitors.delete(logId); }
  // 清理反向映射
  for (const [cfgId, ids] of configToExecLogIds) {
    const filtered = ids.filter(id => id !== logId);
    if (filtered.length === 0) configToExecLogIds.delete(cfgId);
    else configToExecLogIds.set(cfgId, filtered);
  }
}

export function stopBackup(configId: number): { success: boolean; message: string } {
  const entry = runningPgDumps.get(configId);
  if (!entry) return { success: false, message: '没有正在执行的备份' };
  try {
    entry.process.kill('SIGTERM');
    runningPgDumps.delete(configId);
    stopProgressLogUpdates(entry.logId);

    // 更新进度状态
    const prog = backupProgressMap.get(configId);
    if (prog) { prog.status = 'error'; prog.message = '用户手动停止'; }

    // 直接更新备份日志
    updateBackupLog(entry.logId, {
      status: 'error',
      error_message: '用户手动停止',
    }).catch(() => {});

    // 直接更新所有关联的 task_execution_log
    const execLogIds = configToExecLogIds.get(configId) || [];
    for (const lid of execLogIds) {
      updateTaskExecutionLog(lid, {
        status: 'error',
        error_message: '用户手动停止',
      }).catch(() => {});
      // 停止进度监视器
      const timer = progressMonitors.get(lid);
      if (timer) { clearInterval(timer); progressMonitors.delete(lid); }
    }
    configToExecLogIds.delete(configId);

    return { success: true, message: '备份已停止' };
  } catch (err: any) {
    return { success: false, message: '停止失败: ' + (err.message || '') };
  }
}

// 备份进度存储 Map<configId, progress>
const backupProgressMap = new Map<number, {
  status: string;       // running / success / error
  progress: number;     // 0-100
  message: string;
  currentTable: string;
  totalTables: number;
  doneTables: number;
  filename: string;
  filepath: string;
  fileSize?: number;
}>();

export function getBackupProgress(configId: number) {
  return backupProgressMap.get(configId) || null;
}

export function clearBackupProgress(configId: number) {
  backupProgressMap.delete(configId);
}

// 恢复进度存储 Map<logId, progress>
export const restoreProgressMap = new Map<number, {
  status: string;       // running / success / error
  progress: number;     // 0-100
  message: string;
  currentTable: string;
  totalTables: number;
  doneTables: number;
}>();

export function getRestoreProgress(logId: number) {
  return restoreProgressMap.get(logId) || null;
}

// 正在运行的恢复进程 Map<logId, ChildProcess>
export const runningRestores = new Map<number, any>();

export function stopRestore(logId: number): { success: boolean; message: string } {
  const child = runningRestores.get(logId);
  if (child) {
    try {
      child.kill('SIGTERM');
      const prog = restoreProgressMap.get(logId);
      if (prog) {
        prog.status = 'error';
        prog.message = '恢复任务已被用户手动中断';
      }
      runningRestores.delete(logId);
      return { success: true, message: '已发送中断信号' };
    } catch (err: any) {
      return { success: false, message: '中断失败: ' + err.message };
    }
  }
  return { success: false, message: '未找到正在运行的恢复任务' };
}

/**
 * 检查 pg_dump 是否已安装
 */
export function checkPgDumpInstalled(): { installed: boolean; pgDump: boolean; pgRestore: boolean; path: string; version: string; compatible: boolean } {
  let pgDump = false, pgRestore = false, pgPath = '', version = '';
  const { execSync } = require('child_process');
  
  // 查找 pg_dump：先检查所有已知安装路径（含版本号目录），再 fallback 到 which
  // 收集所有找到的版本，选最高的
  const dumpCandidates: { path: string; version: number }[] = [];
  const knownDirs = [16, 15, 14, 13, 12];
  for (const ver of knownDirs) {
    try {
      const p = execSync(`ls /usr/lib/postgresql/${ver}/bin/pg_dump 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (p) {
        const vOut = execSync(`"${p}" --version 2>/dev/null || echo '0'`, { encoding: 'utf8' }).trim();
        const vNum = parseInt(vOut.replace(/^pg_dump \(PostgreSQL\) /, '').split('.')[0]) || 0;
        dumpCandidates.push({ path: p, version: vNum });
      }
    } catch {}
  }
  // macOS Homebrew 路径
  const brewPaths = ['/opt/homebrew/opt/libpq/bin/pg_dump', '/usr/local/opt/libpq/bin/pg_dump'];
  for (const bp of brewPaths) {
    try {
      execSync(`test -f "${bp}"`);
      const vOut = execSync(`"${bp}" --version 2>/dev/null || echo '0'`, { encoding: 'utf8' }).trim();
      const vNum = parseInt(vOut.replace(/^pg_dump \(PostgreSQL\) /, '').split('.')[0]) || 0;
      dumpCandidates.push({ path: bp, version: vNum });
    } catch {}
  }
  // 按版本降序排列，选最高的
  dumpCandidates.sort((a, b) => b.version - a.version);
  const bestDump = dumpCandidates[0];
  if (bestDump) {
    pgDump = true;
    pgPath = bestDump.path;
    version = String(bestDump.version);
  } else {
    // 最后尝试 which pg_dump
    try {
      const p = execSync('which pg_dump 2>/dev/null', { encoding: 'utf8' }).trim();
      if (p) {
        pgPath = p;
        pgDump = true;
        const vOut = execSync(`"${p}" --version 2>/dev/null || echo ''`, { encoding: 'utf8' }).trim();
        version = vOut.replace(/^pg_dump \(PostgreSQL\) /, '');
      }
    } catch {}
  }
  
  // 查找 pg_restore：同样找最高版本
  const restoreCandidates: string[] = [];
  for (const ver of knownDirs) {
    try {
      const p = execSync(`ls /usr/lib/postgresql/${ver}/bin/pg_restore 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (p) restoreCandidates.push(p);
    } catch {}
  }
  for (const bp of brewPaths.map(p => p.replace('pg_dump', 'pg_restore'))) {
    try { execSync(`test -f "${bp}"`); restoreCandidates.push(bp); } catch {}
  }
  if (restoreCandidates.length === 0) {
    try { restoreCandidates.push(execSync('which pg_restore 2>/dev/null', { encoding: 'utf8' }).trim()); } catch {}
  }
  pgRestore = restoreCandidates.length > 0 && restoreCandidates[0] !== '';
  
  // 检测版本是否兼容（pg_dump 需 >= 15 才能备份 PG 15+ 服务器）
  const versionNum = parseInt(version.split('.')[0]) || 0;
  const compatible = pgDump && versionNum >= 15;
  return { installed: pgDump && pgRestore, pgDump, pgRestore, path: pgPath, version, compatible };
}

/**
/**
 * 尝试安装 PostgreSQL 备份工具（异步，不阻塞事件循环）
 */
async function execStep(cmd: string, label: string, opts: any = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    installProgress = { status: 'running', message: label, stage: label };
    console.log('[Backup] ' + label);
    const child = spawn('sh', ['-c', cmd], { stdio: 'pipe', timeout: opts.timeout || 300000 });
    let errOut = '';
    child.stderr.on('data', (d: Buffer) => { errOut += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errOut.substring(0, 200) || cmd.substring(0, 80) + ' 失败(code=' + code + ')'));
    });
    child.on('error', (e) => reject(e));
  });
}

export async function installPgTools(): Promise<{ success: boolean; message: string }> {
  const platform = process.platform;
  installProgress = { status: 'running', message: '准备安装...', stage: 'init' };
  try {
    if (platform === 'darwin') {
      await execStep('which brew 2>/dev/null', '检测 Homebrew...');
      installProgress = { status: 'running', message: '正在通过 Homebrew 安装 libpq（pg_dump）...', stage: 'brew_install' };
      await execStep('brew install libpq 2>&1', '正在安装 libpq（可能需要几分钟）...', { timeout: 300000 });
      await execStep('echo "export PATH=/opt/homebrew/opt/libpq/bin:\$PATH" >> ~/.zshrc', '配置 PATH 环境变量...');
      installProgress = { status: 'success', message: '安装完成', stage: 'done' };
      return { success: true, message: '已通过 Homebrew 安装 libpq（包含 pg_dump / pg_restore）' };
    } else if (platform === 'linux') {
      // 先检查是否已有满足要求的版本（扫描所有已知路径，选最高版本）
      const preCheck = checkPgDumpInstalled();
      if (preCheck.pgDump && preCheck.compatible) {
        installProgress = { status: 'success', message: 'pg_dump 版本已满足要求（' + preCheck.version + '）', stage: 'done' };
        return { success: true, message: 'pg_dump ' + preCheck.version + ' 已就绪，位于 ' + preCheck.path };
      }
      
      try {
        // 步骤1: 安装依赖工具
        installProgress = { status: 'running', message: '步骤 1/5: 安装 curl 和 ca-certificates...', stage: 'install_deps' };
        await execStep('apt-get install -y -qq curl ca-certificates 2>&1', '安装 curl 和 ca-certificates...', { timeout: 60000 });

        // 步骤2: 添加官方 PG 仓库密钥
        installProgress = { status: 'running', message: '步骤 2/5: 添加 PostgreSQL 官方仓库密钥...', stage: 'add_key' };
        await execStep('curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg 2>&1', '添加官方 GPG 密钥...', { timeout: 30000 });

        // 步骤3: 添加 APT 源
        installProgress = { status: 'running', message: '步骤 3/5: 配置 PostgreSQL APT 源...', stage: 'add_repo' };
        await execStep('echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list', '配置 APT 源...');

        // 步骤4: 更新包列表
        installProgress = { status: 'running', message: '步骤 4/5: 更新软件包列表（可能需要 1-2 分钟）...', stage: 'apt_update' };
        await execStep('apt-get update -qq 2>&1', '更新软件包列表...', { timeout: 120000 });

        // 步骤5: 安装 postgresql-client-16
        installProgress = { status: 'running', message: '步骤 5/5: 正在安装 PostgreSQL 16 客户端...', stage: 'install_pg' };
        await execStep('apt-get install -y -qq postgresql-client-16 2>&1', '安装 postgresql-client-16...', { timeout: 120000 });

        // 验证安装结果
        const checkVer = checkPgDumpInstalled();
        if (checkVer.pgDump && checkVer.compatible) {
          installProgress = { status: 'success', message: '安装完成（版本 ' + checkVer.version + '）', stage: 'done' };
          return { success: true, message: '安装成功！pg_dump ' + checkVer.version };
        }
        // 安装了但版本不对，继续走 fallback
        throw new Error('版本验证失败，当前: ' + checkVer.version);
      } catch (err2: any) {
        installProgress = { status: 'error', message: '官方仓库安装失败，尝试默认包', stage: 'fallback' };
        console.log('[Backup] 官方仓库安装失败，尝试默认 postgresql-client');
        await execStep('apt-get update -qq && apt-get install -y -qq postgresql-client 2>&1', '安装默认 postgresql-client...', { timeout: 300000 });
        // 检查安装后的版本，如果仍不满足要求则返回失败
        const verCheck = checkPgDumpInstalled();
        if (verCheck.pgDump && verCheck.compatible) {
          installProgress = { status: 'success', message: '安装完成（版本 ' + verCheck.version + '）', stage: 'done' };
          return { success: true, message: 'pg_dump 已就绪: ' + verCheck.version };
        }
        installProgress = { status: 'error', message: '版本仍不满足要求（当前: ' + verCheck.version + '）', stage: 'error' };
        return { success: false, message: '自动安装失败。pg_dump 版本为 ' + verCheck.version + '，需要 >= 15。请点击查看手动安装方法。' };
      }
    } else {
      return { success: false, message: '不支持自动安装：' + platform + ' 平台请手动安装 PostgreSQL 客户端' };
    }
  } catch (err: any) {
    installProgress = { status: 'error', message: err.message || '安装失败', stage: 'error' };
    return { success: false, message: '安装失败: ' + (err.message || '未知错误') };
  }
}


/**
 * 启动备份调度器
 */
export function startBackupScheduler(): void {
  if (backupInterval) return;
  console.log('[Backup] 备份调度器已启动');
  backupInterval = setInterval(async () => {
    try {
      const configs = await listBackupConfigs();
      const now = new Date();
      const nowStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + ' ' + String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');

      for (const cfg of configs) {
        if (!cfg.enabled || !cfg.next_run_at) continue;
        if (cfg.next_run_at <= nowStr) {
          runBackup(cfg).catch(err => console.error('[Backup] 执行失败:', err.message));
          const next = calcNextRun(cfg);
          await updateBackupRunTime(cfg.id, next);
        }
      }
    } catch (err: any) { console.error('[Backup] 检查失败:', err.message); }
  }, 60 * 1000);
}

export function stopBackupScheduler(): void {
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
}

/**
 * 检测数据库中有多少张表
 */
async function detectTableCount(src: any, dbName: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const env = { ...process.env, PGPASSWORD: src.password };
      const child = spawn('psql', [
        '-h', src.host, '-p', String(src.port), '-U', src.user,
        '-d', dbName, '-t', '-A',
        '-c', "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
      ], { env, timeout: 30000 });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) { const n = parseInt(out.trim()); resolve(isNaN(n) ? 0 : n); }
        else resolve(0);
      });
      child.on('error', () => resolve(0));
    } catch { resolve(0); }
  });
}

function spawnPgDump(
  cfg: any, src: any, backupDir: string, dbName: string,
  format: 'sql' | 'dump', now: Date, logId: number, formatLabel: string,
): Promise<{ filename: string; filepath: string }> {
  return new Promise(async (resolve, reject) => {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad2(now.getMonth()+1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const ext = format === 'sql' ? 'sql' : 'dump';
    const filename = `${dbName}_${dateStr}.${ext}`;
    const filepath = path.join(backupDir, filename);

    const env = { ...process.env, PGPASSWORD: src.password };
    const fmtArg = format === 'sql' ? 'p' : 'c';

    // 先探测表数量
    const totalTables = await detectTableCount(src, dbName);

    const progKey = cfg.id;
    if (!backupProgressMap.has(progKey)) {
      backupProgressMap.set(progKey, {
        status: 'running', progress: 0, message: `正在备份 ${formatLabel}...`,
        currentTable: '', totalTables, doneTables: 0,
        filename, filepath,
      });
    } else {
      // 更新检测到的总表数和文件名（多格式备份时覆盖）
      const existing = backupProgressMap.get(progKey);
      if (existing) {
        existing.totalTables = totalTables;
        existing.filename = filename;
        existing.filepath = filepath;
      }
    }

    // 先检查 pg_dump 是否可用（查找正确版本的 pg_dump）
    let pgDumpPath = 'pg_dump';
    const dumpCandidates = [
      '/opt/homebrew/opt/libpq/bin/pg_dump',
      '/usr/local/opt/libpq/bin/pg_dump',
      '/usr/lib/postgresql/16/bin/pg_dump',
      '/usr/lib/postgresql/15/bin/pg_dump',
    ];
    for (const candidate of dumpCandidates) {
      try {
        require('child_process').execSync(`test -f "${candidate}"`, { env });
        pgDumpPath = candidate;
        break;
      } catch {}
    }
    if (pgDumpPath === 'pg_dump') {
      try {
        const checkPath = require('child_process').execSync('which pg_dump 2>/dev/null || command -v pg_dump 2>/dev/null', { encoding: 'utf8', env }).trim();
        if (checkPath) pgDumpPath = checkPath;
      } catch {}
    }
    if (pgDumpPath === 'pg_dump') {
      console.error('[Backup] pg_dump 未找到，检查系统 PATH:', process.env.PATH);
    }

    const pgDump = spawn(pgDumpPath, [
      '-h', src.host, '-p', String(src.port), '-U', src.user,
      '-d', dbName, '-F', fmtArg, '-f', filepath, '-v',
    ], { env, timeout: 600000 });
    runningPgDumps.set(cfg.id, { process: pgDump, logId });
    
    // 消费 stdout 防止缓冲区溢出导致挂起
    pgDump.stdout.on('data', () => {});

    let doneTables = 0;

    pgDump.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;

      // pg_dump -v 输出格式: "pg_dump: dumping contents of table X"
      if (line.includes('dumping contents of table') || line.includes('dumping contents of')) {
        doneTables++;
        const tableMatch = line.match(/table "([^"]+)"/) || line.match(/table (\S+)/);
        const currentTable = tableMatch ? tableMatch[1] : '';

        const progress = totalTables > 0 ? Math.min(Math.round(doneTables / totalTables * 100), 99) : Math.min(doneTables * 5, 90);

        const prog = backupProgressMap.get(progKey);
        if (prog) {
          prog.progress = progress;
          prog.doneTables = doneTables;
          prog.currentTable = currentTable;
          prog.message = `正在备份 ${formatLabel}: ${currentTable || `表 ${doneTables}/${totalTables || '?'}`}`;
        }
      } else if (line.includes('dumping')) {
        const prog = backupProgressMap.get(progKey);
        if (prog) {
          const shortLine = line.replace(/^pg_dump:\s*/, '').substring(0, 80);
          prog.message = `备份 ${formatLabel}: ${shortLine}`;
        }
      }
    });

    let stderrBuffer = '';

    pgDump.on('close', (code) => {
      runningPgDumps.delete(cfg.id);
      if (code === 0) {
        if (!fs.existsSync(filepath)) {
          reject(new Error('备份文件未生成: ' + filepath));
          return;
        }
        const prog = backupProgressMap.get(progKey);
        if (prog) {
          prog.progress = 100;
          prog.message = `${formatLabel} 备份完成`;
        }
        resolve({ filename, filepath });
      } else if (code === 1 && fs.existsSync(filepath)) {
        // code=1 但文件已生成 → 部分错误（如某些表权限不够），降级视为成功
        const prog = backupProgressMap.get(progKey);
        if (prog) {
          prog.progress = 100;
          prog.message = `${formatLabel} 备份完成（部分表有警告）`;
        }
        // 记录警告
        console.warn(`[Backup] pg_dump 退出(code=1)但文件已生成，可能部分表有警告: ${filepath}`);
        resolve({ filename, filepath });
      } else {
        const prog = backupProgressMap.get(progKey);
        if (prog) { prog.status = 'error'; prog.message = `备份失败 (exit code ${code})`; }

        // 提取 pg_dump 错误详情
        const errLines = stderrBuffer.split('\n').filter((l: string) => l.includes('Error') || l.includes('error') || l.includes('could not') || l.includes('fe_sendauth') || l.includes('password') || l.includes('FATAL'));
        const errDetail = errLines.length > 0 ? errLines.join('; ').substring(0, 300) : stderrBuffer.substring(0, 300).replace(/\n/g, '; ');

        let userMsg = `pg_dump 退出(code=${code})`;
        if (errDetail.includes('could not connect') || errDetail.includes('Connection refused')) {
          userMsg += '，无法连接到数据库服务器，请检查主机地址和端口';
        } else if (errDetail.includes('password') || errDetail.includes('fe_sendauth') || errDetail.includes('authentication') || errDetail.includes('FATAL')) {
          userMsg += '，数据库认证失败，请检查用户名和密码。完整错误: ' + errDetail;
        } else if (errDetail.includes('does not exist')) {
          userMsg += `，数据库 "${dbName}" 不存在`;
        } else if (errDetail.includes('Permission denied')) {
          userMsg += '，权限不足，请检查目录写入权限和数据库用户权限';
        } else if (code === 127 || code === 32512) {
          userMsg += '，系统未找到 pg_dump 命令，请先在服务器安装 postgresql-client';
        } else if (errDetail) {
          userMsg += '。' + errDetail;
        } else {
          userMsg += '，请检查连接和权限';
        }
        reject(new Error(userMsg));
      }
    });

    // Modify the original stderr handler to also capture stderrBuffer
    const origDataListeners = pgDump.stderr.listeners('data');
    pgDump.stderr.removeAllListeners('data');
    pgDump.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
      for (const listener of origDataListeners) {
        listener(data);
      }
    });

    pgDump.on('error', (err) => {
      const prog = backupProgressMap.get(progKey);
      if (prog) { prog.status = 'error'; prog.message = err.message; }
      reject(err);
    });
  });
}

/**
 * 执行备份（支持多种格式，带进度跟踪）
 */
export async function runBackup(cfg: any): Promise<void> {
  const backupFormat = cfg.backup_format || 'sql';
  console.log(`[Backup] 开始备份: ${cfg.name} (${cfg.database_name}), 格式: ${backupFormat}`);

  // 初始化进度
  const progKey = cfg.id;
  backupProgressMap.set(progKey, {
    status: 'running', progress: 0, message: '准备中...',
    currentTable: '', totalTables: 0, doneTables: 0,
    filename: '', filepath: '',
  });

  const logId = await createBackupLog({
    config_id: cfg.id, config_name: cfg.name, database_name: cfg.database_name,
    status: 'running',
  });
  startProgressLogUpdates(logId, cfg.id);

  try {
    const sources = await listPgDatasources();
    const src = sources.find(s => s.id === cfg.pg_source_id);
    if (!src) throw new Error('未找到 PG 数据源 #' + cfg.pg_source_id);

    const backupDir = cfg.backup_dir || path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const now = new Date();
    const dbName = cfg.database_name || src.database;
    const generatedFiles: string[] = [];

    if (backupFormat === 'sql' || backupFormat === 'both') {
      const result = await spawnPgDump(cfg, src, backupDir, dbName, 'sql', now, logId, 'SQL');
      generatedFiles.push(result.filepath);
    }

    if (backupFormat === 'dump' || backupFormat === 'both') {
      const result = await spawnPgDump(cfg, src, backupDir, dbName, 'dump', now, logId, 'DUMP');
      generatedFiles.push(result.filepath);
    }

    // 计算总文件大小
    let totalSize = 0;
    const fileList = generatedFiles.map(fp => {
      const stat = fs.statSync(fp);
      totalSize += stat.size;
      return path.basename(fp);
    }).join(', ');

    stopProgressLogUpdates(logId);
    await updateBackupLog(logId, {
      status: 'success',
      backup_file: fileList,
      file_size: totalSize,
    });

    // 更新进度为完成
    const prog = backupProgressMap.get(progKey);
    if (prog) {
      prog.status = 'success';
      prog.progress = 100;
      prog.message = `备份完成: ${fileList}`;
      prog.filename = fileList;
      prog.fileSize = totalSize;
    }

    // 清理旧备份
    if (cfg.keep_days > 0) {
      const cutoff = now.getTime() - cfg.keep_days * 86400000;
      const files = fs.readdirSync(backupDir);
      for (const f of files) {
        if (!f.startsWith(dbName)) continue;
        const fp = path.join(backupDir, f);
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); }
      }
    }

    console.log(`[Backup] 完成: ${fileList} (${(totalSize/1024).toFixed(1)}KB)`);
  } catch (err: any) {
    stopProgressLogUpdates(logId);
    await updateBackupLog(logId, {
      status: 'error',
      error_message: err.message || String(err),
    });
    const prog = backupProgressMap.get(progKey);
    if (prog) { prog.status = 'error'; prog.message = err.message; }
    console.error('[Backup] 失败:', err.message);
  }

  // 30秒后清除进度
  setTimeout(() => backupProgressMap.delete(progKey), 30000);
}

function calcNextRun(cfg: { type: string; interval_value: number; interval_unit: string; scheduled_time: string }): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  if (cfg.type === 'interval') {
    if (!cfg.interval_value) return '';
    const ms = cfg.interval_unit === 'days' ? cfg.interval_value * 86400000 : cfg.interval_value * 3600000;
    return fmt(new Date(now.getTime() + ms));
  }
  if (cfg.type === 'daily' && cfg.scheduled_time) {
    const [h, m] = cfg.scheduled_time.split(':').map(Number);
    const next = new Date(now); next.setHours(h||0, m||0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return fmt(next);
  }
  return '';
}

/**
 * 立即执行备份（非阻塞，立即返回）
 */
export async function runBackupNow(id: number): Promise<{ success: boolean; message: string }> {
  const cfg = await getBackupConfig(id);
  if (!cfg) return { success: false, message: '备份配置不存在' };
  // 异步执行，不等待完成
  runBackup(cfg).catch(err => console.error('[Backup] 执行异常:', err));
  return { success: true, message: '备份已开始执行，请查看进度' };
}

/**
 * 获取 pg_restore 的执行路径
 */
export function getPgRestorePath(): string {
  const check = checkPgDumpInstalled();
  if (check.installed && check.pgRestore) {
    if (check.path.endsWith('pg_dump')) {
      return check.path.replace('pg_dump', 'pg_restore');
    }
  }
  return 'pg_restore';
}

/**
 * 获取 psql 的执行路径
 */
export function getPsqlPath(): string {
  const check = checkPgDumpInstalled();
  if (check.installed) {
    if (check.path.endsWith('pg_dump')) {
      const psqlPath = check.path.replace('pg_dump', 'psql');
      if (fs.existsSync(psqlPath)) {
        return psqlPath;
      }
    }
  }
  return 'psql';
}

/**
 * 读取 dump 备份文件中的表列表
 */
export async function listDumpTables(filepath: string): Promise<{ schema: string; name: string }[]> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filepath)) {
      reject(new Error('备份文件不存在: ' + filepath));
      return;
    }
    const pgRestorePath = getPgRestorePath();
    const env = { ...process.env };
    
    // 执行 pg_restore -l
    const child = spawn(pgRestorePath, ['-l', filepath], { env });
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    
    child.on('close', (code) => {
      // 如果退出码不为0，且没有得到正常输出，则认为执行出错
      if (code !== 0 && !stdout) {
        reject(new Error(stderr.trim() || `pg_restore 退出错误(code=${code})`));
        return;
      }
      
      const lines = stdout.split('\n');
      const tables: { schema: string; name: string }[] = [];
      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine || cleanLine.startsWith(';')) continue;
        const semiParts = cleanLine.split(';');
        if (semiParts.length < 2) continue;
        const parts = semiParts[1].trim().split(/\s+/);
        // 格式通常为: 1259 41422 TABLE public mytable postgres
        // 或者 (数据内容): 0 0 TABLE DATA public mytable postgres
        if (parts.length >= 5 && parts[2] === 'TABLE') {
          if (parts[3] === 'DATA') {
            if (parts.length >= 6) {
              tables.push({ schema: parts[4], name: parts[5] });
            }
          } else {
            tables.push({ schema: parts[3], name: parts[4] });
          }
        }
      }
      
      // 去重
      const seen = new Set<string>();
      const uniqueTables: { schema: string; name: string }[] = [];
      for (const t of tables) {
        const key = `${t.schema}.${t.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueTables.push(t);
        }
      }
      
      // 排序
      uniqueTables.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
      resolve(uniqueTables);
    });
    
    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 执行数据恢复（支持特定表恢复和覆盖同名表，带实时进度跟踪）
 */
export async function restoreBackup(
  filepath: string,
  targetSrc: any,
  dbName: string,
  options: { tables?: string[]; schema?: string; overwrite?: boolean; disableTriggers?: boolean; logId?: number }
): Promise<{ success: boolean; message: string }> {
  return new Promise(async (resolve) => {
    const isSql = filepath.endsWith('.sql');
    const pgToolsPath = isSql ? getPsqlPath() : getPgRestorePath();
    const env = { 
      ...process.env, 
      PGPASSWORD: targetSrc.password,
      PGOPTIONS: '-c lock_timeout=10000 -c statement_timeout=300000' // 10s锁超时，5分钟语句超时，防止挂起
    };
    
    // 初始化进度
    let totalTables = 0;
    let doneTables = 0;
    if (options.logId) {
      if (options.tables && options.tables.length > 0) {
        totalTables = options.tables.length;
      } else if (options.schema) {
        try {
          if (!isSql) {
            const tbls = await listDumpTables(filepath);
            totalTables = tbls.filter(t => t.schema === options.schema).length;
          }
        } catch {
          totalTables = 0;
        }
      } else {
        try {
          if (!isSql) {
            const tbls = await listDumpTables(filepath);
            totalTables = tbls.length;
          }
        } catch {
          totalTables = 0;
        }
      }
      restoreProgressMap.set(options.logId, {
        status: 'running',
        progress: 0,
        message: '准备恢复中...',
        currentTable: '',
        totalTables,
        doneTables: 0
      });
    }

    // 自动创建缺少的 Schema
    const schemasToCreate = new Set<string>();
    if (options.schema) {
      schemasToCreate.add(options.schema);
    } else if (options.tables && options.tables.length > 0) {
      for (const t of options.tables) {
        if (t.includes('.')) {
          schemasToCreate.add(t.split('.')[0]);
        } else {
          schemasToCreate.add('public');
        }
      }
    } else if (!isSql) {
      try {
        const tbls = await listDumpTables(filepath);
        for (const t of tbls) {
          if (t.schema) schemasToCreate.add(t.schema);
        }
      } catch {}
    }

    if (schemasToCreate.size > 0) {
      const { Pool } = require('pg');
      const pool = new Pool({
        host: targetSrc.host,
        port: Number(targetSrc.port) || 5432,
        user: targetSrc.user,
        password: targetSrc.password,
        database: dbName,
        connectionTimeoutMillis: 5000,
      });
      try {
        for (const schema of schemasToCreate) {
          const safeSchemaName = schema.replace(/"/g, '""');
          console.log(`[Restore] 自动检查并创建 Schema: ${safeSchemaName}`);
          await pool.query(`CREATE SCHEMA IF NOT EXISTS "${safeSchemaName}"`);
        }
      } catch (err: any) {
        console.error('[Restore] 自动创建 Schema 失败:', err);
      } finally {
        try { await pool.end(); } catch {}
      }
    }

    let args: string[] = [];
    if (isSql) {
      args = [
        '-h', targetSrc.host,
        '-p', String(targetSrc.port),
        '-U', targetSrc.user,
        '-d', dbName,
        '-f', filepath,
      ];
    } else {
      args = [
        '-h', targetSrc.host,
        '-p', String(targetSrc.port),
        '-U', targetSrc.user,
        '-d', dbName,
        '-v', // 详细输出，方便匹配进度
      ];

      // 如果需要禁用触发器，则添加 --disable-triggers 参数
      if (options.disableTriggers) {
        args.push('--disable-triggers');
      }

      // 如果需要覆盖已存在的表，则添加 --clean 和 --if-exists 参数
      if (options.overwrite) {
        args.push('--clean');
        args.push('--if-exists');
      }

      // 如果指定了特定 Schema，则只恢复该 Schema 的对象
      if (options.schema) {
        args.push('-n', options.schema);
      }

      // 如果指定了特定表，则只恢复这些表。注意：pg_restore 的 -t 参数仅接受不含 Schema 前缀的纯表名
      if (options.tables && options.tables.length > 0) {
        for (const table of options.tables) {
          const pureTableName = table.includes('.') ? table.split('.').slice(1).join('.') : table;
          args.push('-t', pureTableName);
        }
      }

      args.push(filepath);
    }

    const commandLabel = isSql ? 'psql' : 'pg_restore';
    console.log(`[Restore] 启动 ${commandLabel}，目标库: ${dbName}，参数: ${args.map(a => a === targetSrc.password ? '****' : a).join(' ')}`);

    const child = spawn(pgToolsPath, args, { env });
    if (options.logId) {
      runningRestores.set(options.logId, child);
    }
    
    // 消费 stdout 防止缓冲区溢出导致挂起
    child.stdout.on('data', () => {});
    let stderr = '';
    
    child.stderr.on('data', (data) => {
      const outputStr = data.toString();
      stderr += outputStr;
      
      if (options.logId) {
        const lines = outputStr.split('\n');
        for (const line of lines) {
          const cleanLine = line.trim();
          if (!cleanLine) continue;
          
          // 解析恢复进度：pg_restore -v 输出格式例如: "pg_restore: processing data for table "public.users""
          if (cleanLine.includes('processing data for table') || cleanLine.includes('restoring data for table') || cleanLine.includes('restoring table data')) {
            doneTables++;
            const match = cleanLine.match(/table "([^"]+)"/) || cleanLine.match(/table (\S+)/);
            const currentTable = match ? match[1] : '';
            const progress = totalTables > 0 ? Math.min(Math.round(doneTables / totalTables * 100), 99) : Math.min(doneTables * 10, 90);
            
            const prog = restoreProgressMap.get(options.logId);
            if (prog) {
              prog.progress = progress;
              prog.doneTables = doneTables;
              prog.currentTable = currentTable;
              prog.message = `正在恢复表: ${currentTable || `表 ${doneTables}/${totalTables || '?'}`}`;
            }
          } else if (cleanLine.includes('restoring') || cleanLine.includes('creating')) {
            const prog = restoreProgressMap.get(options.logId);
            if (prog) {
              const shortLine = cleanLine.replace(/^pg_restore:\s*/, '').substring(0, 80);
              prog.message = `正在载入: ${shortLine}`;
              prog.currentTable = ''; // 清除当前表，避免显示已导入的最后一张表名从而误导用户以为卡住了
              if (totalTables === 0) {
                prog.progress = Math.min(prog.progress + 2, 90);
              }
            }
          }
        }
      }
    });
    
    child.on('close', (code) => {
      if (options.logId) {
        runningRestores.delete(options.logId);
      }
      // 注意：pg_restore 和 psql 在有一些警告或非致命错误时可能会退出 1
      // 如果退出码是 1，且 stderr 中包含 critical 错误（如表已存在、主键冲突等），应视为失败
      let isSuccess = code === 0;
      if (code === 1) {
        // 'does not exist' 属于在清理阶段（DROP TABLE/CONSTRAINT）时由于表本身不存在产生的无害警告，此处排除
        // 同样，'schema ".*" already exists' 也属于由于自动创建而产生的无害警告，也予以排除
        // 但如果提示关系/表已存在、主键/约束冲突、或是 schema/database 不存在，则是致命错误
        const hasCriticalError = /(relation|table|index|constraint|type|sequence) ".*" already exists|duplicate key|violates|schema ".*" does not exist|database ".*" does not exist/i.test(stderr);
        if (!hasCriticalError) {
          isSuccess = true;
        }
      }
      
      if (options.logId) {
        const prog = restoreProgressMap.get(options.logId);
        if (prog) {
          if (isSuccess) {
            prog.status = 'success';
            prog.progress = 100;
            prog.message = '恢复成功';
            if (prog.totalTables > 0) {
              prog.doneTables = prog.totalTables;
            }
          } else {
            prog.status = 'error';
            prog.message = `恢复失败 (exit code ${code}): ${stderr.trim().substring(0, 300) || '未知错误'}`;
          }
        }
        
        // 30秒后从内存中移除进度
        setTimeout(() => {
          restoreProgressMap.delete(options.logId!);
        }, 30000);
      }

      if (isSuccess) {
        resolve({
          success: true,
          message: code === 1 ? `恢复完成，但有部分警告: ${stderr.trim().substring(0, 300)}` : '恢复成功'
        });
      } else {
        resolve({
          success: false,
          message: `恢复失败 (exit code ${code}): ${stderr.trim() || '未知错误'}`
        });
      }
    });
    
    child.on('error', (err) => {
      if (options.logId) {
        runningRestores.delete(options.logId);
        const prog = restoreProgressMap.get(options.logId);
        if (prog) {
          prog.status = 'error';
          prog.message = `启动工具失败: ${err.message}`;
        }
        setTimeout(() => {
          restoreProgressMap.delete(options.logId!);
        }, 30000);
      }
      resolve({
        success: false,
        message: `启动恢复工具失败: ${err.message}`
      });
    });
  });
}


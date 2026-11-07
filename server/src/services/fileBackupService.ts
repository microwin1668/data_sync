import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  listFileBackupConfigs, getFileBackupConfig, createFileBackupLog, updateFileBackupLog,
  updateFileBackupRunTime, updateTaskExecutionLog, FileBackupConfig,
} from '../db/sqlite';
import { notifyTaskFailure } from './notifyService';

// ========== rsync / sshpass 二进制探测(仿 pg_dump 探测模式) ==========

const RSYNC_CANDIDATES = [
  '/usr/bin/rsync',
  '/usr/local/bin/rsync',
  '/opt/homebrew/bin/rsync',
  '/opt/homebrew/opt/rsync/bin/rsync',
];

const SSHPASS_CANDIDATES = [
  '/usr/local/bin/sshpass',
  '/opt/homebrew/bin/sshpass',
  '/usr/bin/sshpass',
];

function whichCmd(cmd: string): string {
  try {
    const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim();
    return p || '';
  } catch { return ''; }
}

function findRsyncPath(): string {
  for (const c of RSYNC_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return whichCmd('rsync');
}

function findSshpassPath(): string {
  for (const c of SSHPASS_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return whichCmd('sshpass');
}

function sshpassInstallHint(): string {
  return process.platform === 'darwin'
    ? 'brew install hudochenkov/sshpass/sshpass'
    : 'apt-get install -y sshpass(Debian/Ubuntu)或 yum install -y sshpass(CentOS)';
}

/**
 * 检查 rsync / sshpass 是否可用
 */
export function checkRsyncInstalled(): {
  installed: boolean; rsync: boolean; path: string; version: string; isOpenRsync: boolean;
  sshpass: boolean; sshpassHint: string;
} {
  const rsyncPath = findRsyncPath();
  let version = '';
  let isOpenRsync = false;
  if (rsyncPath) {
    try {
      version = execSync(`"${rsyncPath}" --version 2>/dev/null`, { encoding: 'utf8' }).split('\n')[0].trim();
      isOpenRsync = /openrsync/i.test(version);
    } catch {}
  }
  const hasSshpass = !!findSshpassPath();
  return {
    installed: !!rsyncPath,
    rsync: !!rsyncPath,
    path: rsyncPath,
    version,
    isOpenRsync,
    sshpass: hasSshpass,
    sshpassHint: hasSshpass ? '' : sshpassInstallHint(),
  };
}

/**
 * 测试 SSH 连接是否可达(用于配置保存前的连通性验证)
 */
export async function testSshConnection(cfg: {
  ssh_host: string; ssh_port: string; ssh_user: string;
  auth_type: string; ssh_key_path: string; ssh_password: string;
}): Promise<{ success: boolean; message: string }> {
  if (!cfg.ssh_host || !cfg.ssh_user) return { success: false, message: '请先填写主机地址和用户名' };
  if (cfg.auth_type === 'password' && !cfg.ssh_password) return { success: false, message: '请填写 SSH 密码' };
  if (cfg.auth_type === 'password' && !findSshpassPath()) {
    return { success: false, message: '密码认证需要本机安装 sshpass: ' + sshpassInstallHint() };
  }

  const marker = '__DS_FILE_BACKUP_OK__';
  const sshArgs = [
    '-p', String(cfg.ssh_port || '22'),
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  let cmd = 'ssh';
  let args: string[];
  const env = { ...process.env };
  if (cfg.auth_type === 'password') {
    const sshpass = findSshpassPath();
    args = ['-e', 'ssh', ...sshArgs, '-o', 'PreferredAuthentications=password,keyboard-interactive',
      `${cfg.ssh_user}@${cfg.ssh_host}`, `echo ${marker}`];
    env.SSHPASS = cfg.ssh_password;
    cmd = sshpass;
  } else {
    const keyPath = (cfg.ssh_key_path || '').trim();
    if (keyPath) { sshArgs.push('-i', keyPath, '-o', 'IdentitiesOnly=yes'); }
    sshArgs.push('-o', 'BatchMode=yes');
    args = [...sshArgs, `${cfg.ssh_user}@${cfg.ssh_host}`, `echo ${marker}`];
  }

  return new Promise((resolve) => {
    let out = '';
    let errOut = '';
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { env, timeout: 20000 });
    } catch (err: any) {
      resolve({ success: false, message: '启动 ssh 失败: ' + (err.message || '') });
      return;
    }
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { errOut += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && out.includes(marker)) {
        resolve({ success: true, message: `连接成功:${cfg.ssh_user}@${cfg.ssh_host}:${cfg.ssh_port || '22'}` });
      } else {
        resolve({ success: false, message: translateSshError(code, errOut) });
      }
    });
    child.on('error', (err) => resolve({ success: false, message: '连接失败: ' + err.message }));
  });
}

function translateSshError(code: number | null, errOut: string): string {
  const detail = errOut.trim().split('\n').filter(Boolean).slice(-2).join('; ').slice(0, 300);
  let base = `连接失败(退出码 ${code})`;
  if (/permission denied/i.test(errOut)) base = '认证失败:请检查密钥是否已添加到远端(authorized_keys)或密码是否正确';
  else if (/could not resolve hostname/i.test(errOut)) base = '无法解析主机名,请检查主机地址';
  else if (/connection refused/i.test(errOut)) base = '连接被拒绝:远端 SSH 服务未启动或端口不正确';
  else if (/connection timed out|connect timed out/i.test(errOut)) base = '连接超时:请检查网络和防火墙';
  else if (/no route to host/i.test(errOut)) base = '网络不可达:请检查主机地址和网络';
  else if (/host key verification failed/i.test(errOut)) base = '主机密钥校验失败';
  return detail ? `${base}(${detail})` : base;
}

// ========== 进度与运行状态 ==========

// 备份进度存储 Map<configId, progress>
const fileBackupProgressMap = new Map<number, {
  status: string;       // running / success / error
  progress: number;     // 0-100
  message: string;
  totalFiles: number;
  transferredFiles: number;
  transferredBytes: number;
  currentFile: string;
  deletedFiles: number;
  snapshotDir: string;
}>();

// 存储正在运行的 rsync 子进程,用于停止
const runningFileBackups = new Map<number, { process: ChildProcess; logId: number }>();

// 监视备份进度并更新 task_execution_log(仿 backupService)
const progressMonitors = new Map<number, NodeJS.Timeout>();
// 反向映射: configId → [logId]
const configToExecLogIds = new Map<number, number[]>();

export function getFileBackupProgress(configId: number) {
  return fileBackupProgressMap.get(configId) || null;
}

export function clearFileBackupProgress(configId: number) {
  fileBackupProgressMap.delete(configId);
}

export function startFileBackupProgressMonitor(configId: number, logId: number) {
  stopFileBackupProgressMonitor(logId);
  const timer = setInterval(async () => {
    const prog = fileBackupProgressMap.get(configId);
    if (!prog) return;
    try {
      if (prog.status === 'success') {
        await updateTaskExecutionLog(logId, {
          status: 'success',
          total_records: prog.totalFiles || 0,
          success_count: prog.transferredFiles || 0,
          error_message: prog.message,
          backup_file: prog.snapshotDir || '',
          file_size: prog.transferredBytes || 0,
        });
        clearInterval(timer);
        progressMonitors.delete(logId);
      } else if (prog.status === 'error') {
        await updateTaskExecutionLog(logId, {
          status: 'error',
          error_message: prog.message || '文件备份失败',
          total_records: prog.totalFiles || 0,
          success_count: prog.transferredFiles || 0,
        });
        clearInterval(timer);
        progressMonitors.delete(logId);
      } else {
        await updateTaskExecutionLog(logId, {
          status: 'running',
          total_records: prog.totalFiles || 0,
          success_count: prog.transferredFiles || 0,
          // 复用 error_count 字段存进度百分比,供前端进度条显示
          error_count: prog.progress,
          error_message: prog.message,
        });
      }
    } catch {}
  }, 2000);
  progressMonitors.set(logId, timer);
  if (!configToExecLogIds.has(configId)) configToExecLogIds.set(configId, []);
  const ids = configToExecLogIds.get(configId)!;
  if (!ids.includes(logId)) ids.push(logId);
}

export function stopFileBackupProgressMonitor(logId: number) {
  const timer = progressMonitors.get(logId);
  if (timer) { clearInterval(timer); progressMonitors.delete(logId); }
  for (const [cfgId, ids] of configToExecLogIds) {
    const filtered = ids.filter(id => id !== logId);
    if (filtered.length === 0) configToExecLogIds.delete(cfgId);
    else configToExecLogIds.set(cfgId, filtered);
  }
}

/**
 * 停止正在执行的文件备份(杀整个进程组,含 rsync 与 ssh 子进程)
 */
export function stopFileBackup(configId: number): { success: boolean; message: string } {
  const entry = runningFileBackups.get(configId);
  if (!entry) return { success: false, message: '没有正在执行的文件备份' };
  try {
    try { process.kill(-(entry.process.pid as number), 'SIGTERM'); }
    catch { entry.process.kill('SIGTERM'); }
    runningFileBackups.delete(configId);

    const prog = fileBackupProgressMap.get(configId);
    if (prog) { prog.status = 'error'; prog.message = '用户手动停止'; }

    updateFileBackupLog(entry.logId, { status: 'error', error_message: '用户手动停止' }).catch(() => {});

    const execLogIds = configToExecLogIds.get(configId) || [];
    for (const lid of execLogIds) {
      updateTaskExecutionLog(lid, { status: 'error', error_message: '用户手动停止' }).catch(() => {});
      stopFileBackupProgressMonitor(lid);
    }
    configToExecLogIds.delete(configId);

    return { success: true, message: '文件备份已停止' };
  } catch (err: any) {
    return { success: false, message: '停止失败: ' + (err.message || '') };
  }
}

// ========== 快照目录工具 ==========

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function todayStr(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * 在本地目录中查找今天之前最近的一个日期快照目录,作为 --link-dest 硬链接基准
 */
function findLatestSnapshotBefore(localDir: string, curDateStr: string): string {
  try {
    const names = fs.readdirSync(localDir)
      .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < curDateStr)
      .sort();
    return names.length ? names[names.length - 1] : '';
  } catch { return ''; }
}

/**
 * 原子更新 latest 软链接(临时名 + rename,避免中途读到断链)
 */
function updateLatestLink(localDir: string, dateStr: string): void {
  try {
    const latestPath = path.join(localDir, 'latest');
    const tmpPath = path.join(localDir, `.latest_tmp_${process.pid}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    fs.symlinkSync(dateStr, tmpPath, 'dir');
    fs.renameSync(tmpPath, latestPath);
  } catch (err: any) {
    console.warn('[FileBackup] 更新 latest 软链接失败(不影响备份结果):', err.message);
  }
}

/**
 * 按保留天数清理过期的日期快照目录
 * 只根据目录名(日期)判断,绝不动今天及未来的快照;硬链接保证删除旧快照不会丢失新快照中的数据
 */
function pruneOldSnapshots(localDir: string, keepDays: number, curDateStr: string): number {
  if (!keepDays || keepDays <= 0) return 0;
  let removed = 0;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(localDir, { withFileTypes: true }); } catch { return 0; }
  const cutoffMs = Date.now() - keepDays * 86400000;
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
    if (e.name >= curDateStr) continue;
    const t = new Date(e.name + 'T00:00:00').getTime();
    if (isNaN(t) || t >= cutoffMs) continue;
    try { fs.rmSync(path.join(localDir, e.name), { recursive: true, force: true }); removed++; } catch {}
  }
  if (removed > 0) console.log(`[FileBackup] 已清理 ${removed} 个过期快照(保留 ${keepDays} 天)`);
  return removed;
}

// ========== rsync 命令构建 ==========

function parseExcludes(jsonStr: string): string[] {
  try {
    const arr = JSON.parse(jsonStr || '[]');
    if (Array.isArray(arr)) return arr.map((s: any) => String(s).trim()).filter(Boolean);
  } catch {}
  return [];
}

/**
 * 远端目录以 / 结尾(同步目录内容);源形如 user@host:/remote/dir/
 */
function buildRemoteSpec(cfg: FileBackupConfig): string {
  let rd = (cfg.remote_dir || '').trim();
  if (!rd.endsWith('/')) rd += '/';
  return `${cfg.ssh_user}@${cfg.ssh_host}:${rd}`;
}

/**
 * rsync -e 参数(rsync 会按空格拆分,密钥路径不能含空格)
 */
function buildSshCmd(cfg: FileBackupConfig): string {
  let cmd = `ssh -p ${cfg.ssh_port || '22'} -o StrictHostKeyChecking=accept-new`;
  const keyPath = (cfg.ssh_key_path || '').trim();
  if (cfg.auth_type !== 'password' && keyPath) {
    cmd += ` -i ${keyPath} -o IdentitiesOnly=yes`;
  }
  return cmd;
}

function parseRsyncStats(text: string): { totalFiles: number; transferredFiles: number; transferredBytes: number } {
  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    return m ? (parseInt(m[1].replace(/,/g, ''), 10) || 0) : null;
  };
  return {
    totalFiles: num(/Number of files:\s*([\d,]+)/i) ?? 0,
    // GNU rsync 与 openrsync 的字段名不同,三种都尝试
    transferredFiles: num(/Number of regular files transferred:\s*([\d,]+)/i)
      ?? num(/Number of transferred files:\s*([\d,]+)/i)
      ?? num(/Number of files transferred:\s*([\d,]+)/i)
      ?? -1,
    transferredBytes: num(/Total transferred file size:\s*([\d,]+)/i) ?? 0,
  };
}

function buildRsyncErrorMessage(code: number | null, stderrTail: string): string {
  let base = `rsync 退出码 ${code}`;
  if (code === 255) base = 'SSH 连接失败:请检查主机、端口和认证配置';
  else if (code === 23) base = '部分文件传输失败:请检查远端文件读取权限';
  else if (code === 20) base = '传输被中断';
  else if (/rsync[^\n]*command not found|rsync[^\n]*not found/i.test(stderrTail)) {
    base = '远端服务器未安装 rsync,请先在远端执行 yum/apt install rsync';
  } else if (/permission denied/i.test(stderrTail)) {
    base = '认证失败:请检查 SSH 密钥或密码';
  }
  const detail = stderrTail.trim().split('\n').filter(Boolean).slice(-3).join('; ').slice(0, 500);
  return detail ? `${base}(${detail})` : base;
}

// ========== 主流程 ==========

/**
 * 手动触发一次文件备份(异步,立即返回)
 */
export async function runFileBackupNow(id: number): Promise<{ success: boolean; message: string }> {
  const cfg = await getFileBackupConfig(id);
  if (!cfg) return { success: false, message: '文件备份配置不存在' };
  if (runningFileBackups.has(id)) return { success: false, message: '该配置正在执行中，请稍后再试' };
  runFileBackup(cfg, false).catch(err => console.error('[FileBackup] 手动执行异常:', err.message));
  return { success: true, message: '文件备份已开始执行' };
}

/**
 * 执行一次每日快照备份:
 * 1. 本地目录下创建 YYYY-MM-DD 快照目录
 * 2. rsync --link-dest 指向上一个快照,未变化文件用硬链接共享(增量传输)
 * 3. 完成后原子更新 latest 软链接,按 keep_days 清理过期快照
 */
export async function runFileBackup(cfg: FileBackupConfig, notify: boolean = false): Promise<void> {
  const configId = cfg.id;
  if (runningFileBackups.has(configId)) {
    console.log(`[FileBackup] 配置 #${configId}（${cfg.name}）已在执行中，跳过`);
    return;
  }

  const logId = await createFileBackupLog({
    config_id: configId, config_name: cfg.name,
    remote_dir: cfg.remote_dir, local_dir: cfg.local_dir, status: 'running',
  });

  // 失败收尾:写日志 + 更新进度 + 可选邮件告警
  const failRun = async (message: string) => {
    await updateFileBackupLog(logId, { status: 'error', error_message: message }).catch(() => {});
    const prog = fileBackupProgressMap.get(configId);
    if (prog) { prog.status = 'error'; prog.message = message; }
    else fileBackupProgressMap.set(configId, {
      status: 'error', progress: 0, message, totalFiles: 0, transferredFiles: 0,
      transferredBytes: 0, currentFile: '', deletedFiles: 0, snapshotDir: '',
    });
    console.error(`[FileBackup] 配置 #${configId}（${cfg.name}）失败: ${message}`);
    if (notify) {
      notifyTaskFailure('file_backup', `file-backup-${configId}`, `文件备份「${cfg.name}」执行失败`, [
        ['备份名称', cfg.name || String(configId)],
        ['远端目录', `${cfg.ssh_user}@${cfg.ssh_host}:${cfg.remote_dir}`],
        ['本地目录', cfg.local_dir],
        ['错误信息', message.slice(0, 2000)],
      ]);
    }
  };

  // 基础校验
  if (!cfg.ssh_host || !cfg.ssh_user || !cfg.remote_dir || !cfg.local_dir) {
    await failRun('配置不完整:请填写主机、用户名、远端目录和本地目录');
    return;
  }
  const rsyncPath = findRsyncPath();
  if (!rsyncPath) {
    await failRun('未找到 rsync,请先安装(macOS 系统自带 /usr/bin/rsync,Linux 执行 yum/apt install rsync)');
    return;
  }
  if (cfg.auth_type === 'password' && !findSshpassPath()) {
    await failRun('密码认证需要本机安装 sshpass: ' + sshpassInstallHint());
    return;
  }

  const now = new Date();
  const dateStr = todayStr(now);
  const localDir = cfg.local_dir.trim();
  const snapshotDir = path.join(localDir, dateStr);
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
  } catch (err: any) {
    await failRun(`无法创建本地快照目录 ${snapshotDir}: ${err.message}`);
    return;
  }

  const prevDate = findLatestSnapshotBefore(localDir, dateStr);
  // 当天目录已有内容时属于"更新今日快照"(rsync 基于现有文件增量传输 + --delete 保证与远端一致)
  const todayHasData = (() => {
    try { return fs.readdirSync(snapshotDir).length > 0; } catch { return false; }
  })();
  const runLabel = prevDate ? `增量同步(基于快照 ${prevDate})` : todayHasData ? '今日快照更新' : '首次全量同步';

  // rsync 参数:-a 保留属性 -z 压缩 -v 列出传输文件 --stats 结束统计
  // --delete 只作用于当天快照目录(保证当天快照与远端一致),绝不触碰历史快照
  // --timeout 空闲超时,防止网络中断导致进程挂起(长传输不受影响)
  const args = ['-a', '-z', '-v', '--stats', '--delete', '--timeout=600'];
  if (prevDate) args.push(`--link-dest=../${prevDate}`);
  for (const p of parseExcludes(cfg.exclude_patterns)) args.push(`--exclude=${p}`);
  args.push('-e', buildSshCmd(cfg));
  args.push(buildRemoteSpec(cfg), snapshotDir + '/');

  const env = { ...process.env };
  let cmd = rsyncPath;
  let spawnArgs = args;
  if (cfg.auth_type === 'password') {
    const sshpass = findSshpassPath();
    env.SSHPASS = cfg.ssh_password;
    cmd = sshpass;
    spawnArgs = ['-e', rsyncPath, ...args];
  }

  fileBackupProgressMap.set(configId, {
    status: 'running', progress: 5,
    message: `${runLabel}...`,
    totalFiles: 0, transferredFiles: 0, transferredBytes: 0,
    currentFile: '', deletedFiles: 0, snapshotDir,
  });

  console.log(`[FileBackup] 配置 #${configId}（${cfg.name}）开始 ${runLabel} -> ${snapshotDir}`);
  // detached 使 rsync 成为进程组长,停止时可连带 ssh 子进程一起杀掉
  const child = spawn(cmd, spawnArgs, { env, detached: true });
  runningFileBackups.set(configId, { process: child, logId });

  // 消费 stdout 防止缓冲区溢出导致挂起
  let lineBuf = '';
  let statsText = '';
  let processed = 0;
  let deleted = 0;
  let stderrTail = '';
  let finished = false;

  child.stdout!.on('data', (d: Buffer) => {
    const chunk = d.toString();
    // --stats 输出在末尾,保留尾部足够长度供完成后解析
    statsText = (statsText + chunk).slice(-8000);
    lineBuf += chunk;
    let idx: number;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      // --stats 统计段不作为文件计数
      if (/^(Number of|Total |Literal data|Matched data|File list|sent |total size)/.test(line)) continue;
      if (/building file list|incremental file list/.test(line)) continue;
      if (line.startsWith('deleting ')) { deleted++; continue; }
      processed++;
      const prog = fileBackupProgressMap.get(configId);
      if (prog) {
        prog.transferredFiles = processed;
        prog.currentFile = line;
        prog.deletedFiles = deleted;
        prog.progress = Math.min(5 + processed, 90);
        prog.message = `正在同步: ${line}(已传输 ${processed} 个文件${deleted > 0 ? `,已删除 ${deleted} 个` : ''})`;
      }
    }
  });

  child.stderr!.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  child.on('close', async (code) => {
    if (finished) return;
    finished = true;
    runningFileBackups.delete(configId);
    stopProgressAndLogUpdates(configId);

    const stats = parseRsyncStats(statsText);
    const prog = fileBackupProgressMap.get(configId);
    // 退出码 24 = 部分文件在传输前消失(远端正在变动),视为成功
    const success = code === 0 || code === 24;

    if (success) {
      const totalFiles = stats.totalFiles || 0;
      const transferred = stats.transferredFiles >= 0 ? stats.transferredFiles : processed;
      const bytes = stats.transferredBytes || 0;
      const summary = `${prevDate ? '增量快照完成' : todayHasData ? '今日快照更新完成' : '首次全量快照完成'}${stats.totalFiles ? `,快照共 ${stats.totalFiles} 个文件` : ''},本次传输 ${transferred} 个文件${bytes > 0 ? `(${formatBytes(bytes)})` : ''}`;

      updateLatestLink(localDir, dateStr);
      pruneOldSnapshots(localDir, cfg.keep_days, dateStr);
      await updateFileBackupRunTime(configId, snapshotDir).catch(() => {});
      await updateFileBackupLog(logId, {
        status: 'success', snapshot_dir: snapshotDir,
        total_files: totalFiles, transferred_files: transferred, transferred_bytes: bytes,
        error_message: summary,
      }).catch(() => {});

      if (prog) {
        prog.status = 'success'; prog.progress = 100;
        prog.totalFiles = totalFiles; prog.transferredFiles = transferred; prog.transferredBytes = bytes;
        prog.message = summary;
      }
      console.log(`[FileBackup] 配置 #${configId}（${cfg.name}）${summary}: ${snapshotDir}`);
    } else {
      const message = buildRsyncErrorMessage(code, stderrTail);
      await updateFileBackupLog(logId, {
        status: 'error', snapshot_dir: snapshotDir, error_message: message,
      }).catch(() => {});
      if (prog) { prog.status = 'error'; prog.message = message; }
      console.error(`[FileBackup] 配置 #${configId}（${cfg.name}）失败(code=${code}): ${message}`);
      if (notify) {
        notifyTaskFailure('file_backup', `file-backup-${configId}`, `文件备份「${cfg.name}」执行失败`, [
          ['备份名称', cfg.name || String(configId)],
          ['远端目录', `${cfg.ssh_user}@${cfg.ssh_host}:${cfg.remote_dir}`],
          ['本地目录', localDir],
          ['错误信息', message.slice(0, 2000)],
        ]);
      }
    }
  });

  child.on('error', async (err) => {
    if (finished) return;
    finished = true;
    runningFileBackups.delete(configId);
    await failRun('rsync 启动失败: ' + (err.message || '未知错误'));
  });
}

/**
 * 清理该配置遗留的执行日志监视器
 */
function stopProgressAndLogUpdates(configId: number) {
  const ids = configToExecLogIds.get(configId) || [];
  for (const lid of ids) stopFileBackupProgressMonitor(lid);
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 列出所有文件备份配置(供调试/未来扩展)
 */
export async function listAllFileBackupConfigs(): Promise<FileBackupConfig[]> {
  return listFileBackupConfigs();
}

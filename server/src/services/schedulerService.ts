import {
  listSyncTasks, getSyncTask, getSyncConfig, updateTaskRunTime,
  listSyncConfigs, createTaskExecutionLog, updateTaskExecutionLog, getBackupConfig, listBackupConfigs,
} from '../db/sqlite';
import { executeSyncImportStream } from './syncService';
import { runBackup, getBackupProgress, startBackupProgressMonitor, stopBackupProgressMonitor } from './backupService';
import { saveFailedRecords } from '../utils/logUtils';

interface RunningTask {
  taskId: number;
  timer: NodeJS.Timeout;
}

const runningTimers: Map<number, RunningTask> = new Map();
let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * 初始化调度器，每分钟检查一次待执行的任务
 */
export function startScheduler(): void {
  if (schedulerInterval) return;

  console.log('[Scheduler] 定时任务调度器已启动');
  schedulerInterval = setInterval(async () => {
    try {
      const tasks = await listSyncTasks();
      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const nowStr = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());

      for (const task of tasks) {
        if (!task.enabled || !task.next_run_at) continue;
        if (task.next_run_at <= nowStr) {
          // 异步执行，不阻塞调度器
          executeTask(task).catch(err => console.error(`[Scheduler] 任务 #${task.id} 执行异常:`, err));
          // 更新下次执行时间
          const nextRun = calcNextRun(task);
          await updateTaskRunTime(task.id, nextRun);
        }
      }
    } catch (err: any) {
      console.error('[Scheduler] 检查任务失败:', err.message);
    }
  }, 60 * 1000); // 每分钟检查
}

/**
 * 停止调度器
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  for (const [id, rt] of runningTimers) {
    clearTimeout(rt.timer);
    runningTimers.delete(id);
  }
  console.log('[Scheduler] 调度器已停止');
}

/**
 * 获取任务关联的同步配置 ID 列表
 */
function getConfigIds(task: { sync_config_ids: string; sync_config_id: number }): number[] {
  try {
    const ids = JSON.parse(task.sync_config_ids || '[]');
    if (Array.isArray(ids) && ids.length > 0) return ids;
  } catch {}
  if (task.sync_config_id) return [task.sync_config_id];
  return [];
}

/**
 * 执行任务（可能含多个同步配置）
 */
async function executeTask(task: any): Promise<void> {
  // 备份任务处理 - 创建执行日志并跟踪进度
  if (task.task_type === 'backup') {
    console.log(`[Scheduler] 执行备份任务 #${task.id}（${task.name}）`);
    const backupConfig = await getBackupConfig(task.backup_config_id);
    if (!backupConfig) {
      console.log(`[Scheduler] 备份任务 #${task.id} 关联的备份配置 #${task.backup_config_id} 不存在`);
      return;
    }

    const logId = await createTaskExecutionLog({
      task_id: task.id,
      task_name: task.name,
      sync_config_id: task.backup_config_id || 0,
      sync_config_name: backupConfig.name || '备份:' + task.backup_config_id,
      target_table: backupConfig.database_name || '',
      task_type: 'backup',
      status: 'running',
    });

    try {
      // 启动备份（异步）
      runBackup(backupConfig).catch(err => console.error('[Scheduler] 备份异常:', err));

      // 使用共享的进度监视器更新执行日志
      startBackupProgressMonitor(task.backup_config_id, logId);

      // 等待备份完成
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(async () => {
          const prog = getBackupProgress(task.backup_config_id);
          if (!prog) return;
          if (prog.status === 'success' || prog.status === 'error') {
            clearInterval(checkInterval);
            stopBackupProgressMonitor(logId);
            console.log(`[Scheduler] 备份任务 #${task.id}（${task.name}）${prog.status}`);
            resolve();
          }
        }, 2000);
      });
      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      stopBackupProgressMonitor(logId);
      await updateTaskExecutionLog(logId, {
        status: 'error',
        error_message: err.message || '执行异常',
      });
      console.error(`[Scheduler] 备份任务 #${task.id} 失败:`, err.message);
    }
    return;
  }

  const configIds = getConfigIds(task);
  console.log(`[Scheduler] 执行任务 #${task.id}（${task.name}），包含 ${configIds.length} 个同步配置`);

  const allConfigs = await listSyncConfigs();
  const configMap = Object.fromEntries(allConfigs.map(c => [c.id, c]));

  for (const cfgId of configIds) {
    const cfg = configMap[cfgId];
    if (!cfg) {
      console.log(`[Scheduler] 任务 #${task.id} 跳过配置 #${cfgId}：未找到`);
      continue;
    }

    // 创建执行日志
    const logId = await createTaskExecutionLog({
      task_id: task.id,
      task_name: task.name,
      sync_config_id: cfgId,
      sync_config_name: cfg.name || String(cfgId),
      target_table: cfg.target_table || '',
      task_type: task.task_type || 'sync',
      status: 'running',
    });

    console.log(`[Scheduler] 任务 #${task.id} 开始导入 ${cfg.name} -> ${cfg.target_table}`);

    let totalSuccess = 0, totalErrors = 0, totalRecords = 0;
    let logFilename = '';
    let apiTotal = 0;

    try {
      await executeSyncImportStream(cfgId, async (event, data) => {
        if (event === 'start') {
          apiTotal = data.total || 0;
          updateTaskExecutionLog(logId, { total_records: apiTotal }).catch(() => {});
        } else if (event === 'progress') {
          totalSuccess = data.success || 0;
          totalErrors = data.error || 0;
          totalRecords = data.imported || 0;
          // 实时更新日志
          updateTaskExecutionLog(logId, {
            total_records: apiTotal || totalRecords,
            success_count: totalSuccess,
            error_count: totalErrors,
          }).catch(() => {});
        } else if (event === 'done') {
          totalSuccess = data.success || 0;
          totalErrors = data.error || 0;
          totalRecords = (data.success || 0) + (data.error || 0);
          logFilename = data.logFilename || '';
          // 更新日志
          await updateTaskExecutionLog(logId, {
            status: totalErrors > 0 ? 'error' : 'success',
            total_records: apiTotal || totalRecords,
            success_count: totalSuccess,
            error_count: totalErrors,
            log_filename: logFilename,
          });
          console.log(`[Scheduler] 任务 #${task.id} ${cfg.name} 完成: ${totalSuccess} 成功, ${totalErrors} 失败`);
        } else if (event === 'error') {
          await updateTaskExecutionLog(logId, {
            status: 'error',
            error_message: data.message || '未知错误',
          });
          console.error(`[Scheduler] 任务 #${task.id} ${cfg.name} 错误:`, data.message);
        } else if (event === 'cancelled') {
          totalSuccess = data.success || 0;
          totalErrors = data.error || 0;
          logFilename = data.logFilename || '';
          await updateTaskExecutionLog(logId, {
            status: 'cancelled',
            total_records: apiTotal || totalRecords,
            success_count: totalSuccess,
            error_count: totalErrors,
            log_filename: logFilename,
          });
          console.log(`[Scheduler] 任务 #${task.id} ${cfg.name} 被中断`);
        }
      });
    } catch (err: any) {
      await updateTaskExecutionLog(logId, {
        status: 'error',
        error_message: err.message || '执行异常',
      });
    }
  }

  console.log(`[Scheduler] 任务 #${task.id}（${task.name}）全部配置执行完成`);
}

/**
 * 手动执行任务（调用方等待完成）
 */
export async function executeTaskSync(task: any): Promise<{ success: boolean; message: string; logs: any[] }> {
  const configIds = getConfigIds(task);
  const allConfigs = await listSyncConfigs();
  const configMap = Object.fromEntries(allConfigs.map(c => [c.id, c]));
  const logResults: any[] = [];

  for (const cfgId of configIds) {
    const cfg = configMap[cfgId];
    if (!cfg) {
      logResults.push({ configId: cfgId, status: 'skipped', message: '未找到配置' });
      continue;
    }

    const logId = await createTaskExecutionLog({
      task_id: task.id,
      task_name: task.name,
      sync_config_id: cfgId,
      sync_config_name: cfg.name || String(cfgId),
      target_table: cfg.target_table || '',
      task_type: task.task_type || 'sync',
      status: 'running',
    });

    let totalSuccess = 0, totalErrors = 0, totalRecords = 0;
    let logFilename = '';
    let apiTotal = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        executeSyncImportStream(cfgId, (event, data) => {
          if (event === 'start') {
            apiTotal = data.total || 0;
            updateTaskExecutionLog(logId, { total_records: apiTotal }).catch(() => {});
          } else if (event === 'progress') {
            totalSuccess = data.success || 0;
            totalErrors = data.error || 0;
            totalRecords = data.imported || 0;
            // 实时更新日志
            updateTaskExecutionLog(logId, {
              total_records: apiTotal || totalRecords,
              success_count: totalSuccess,
              error_count: totalErrors,
            }).catch(() => {});
          } else if (event === 'done') {
            totalSuccess = data.success || 0;
            totalErrors = data.error || 0;
            totalRecords = (data.success || 0) + (data.error || 0);
            logFilename = data.logFilename || '';
            updateTaskExecutionLog(logId, {
              status: totalErrors > 0 ? 'error' : 'success',
              total_records: apiTotal || totalRecords,
              success_count: totalSuccess,
              error_count: totalErrors,
              log_filename: logFilename,
            }).then(() => resolve());
          } else if (event === 'error') {
            updateTaskExecutionLog(logId, { status: 'error', error_message: data.message || '未知错误' })
              .then(() => resolve());
          } else if (event === 'cancelled') {
            logFilename = data.logFilename || '';
            updateTaskExecutionLog(logId, { status: 'cancelled', total_records: apiTotal || totalRecords, success_count: data.success || 0, error_count: data.error || 0, log_filename: logFilename })
              .then(() => resolve());
          }
        });
      });
    } catch (err: any) {
      await updateTaskExecutionLog(logId, { status: 'error', error_message: err.message || '执行异常' });
    }

    logResults.push({
      configId: cfgId,
      configName: cfg.name,
      targetTable: cfg.target_table,
      success: totalSuccess,
      error: totalErrors,
      total: totalRecords,
      logFilename,
      status: totalErrors > 0 ? 'error' : 'success',
    });
  }

  return {
    success: true,
    message: `执行完成: ${configIds.length} 个配置`,
    logs: logResults,
  };
}

function calcNextRun(task: {
  type: string; interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string;
}): string {
  const now = new Date();
  switch (task.type) {
    case 'interval': {
      if (!task.interval_value) return '';
      const unit = task.interval_unit || 'minutes';
      const ms = unit === 'hours' ? task.interval_value * 3600000
                : unit === 'days' ? task.interval_value * 86400000
                : task.interval_value * 60000;
      const next = new Date(now.getTime() + ms);
      const pad2 = (n: number) => String(n).padStart(2, '0');
      return next.getFullYear() + '-' + pad2(next.getMonth() + 1) + '-' + pad2(next.getDate()) + ' ' + pad2(next.getHours()) + ':' + pad2(next.getMinutes()) + ':' + pad2(next.getSeconds());
    }
    case 'daily': {
      if (!task.scheduled_time) return '';
      const [h, m] = task.scheduled_time.split(':').map(Number);
      const next = new Date(now);
      next.setHours(h || 0, m || 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const pad2 = (n: number) => String(n).padStart(2, '0');
      return next.getFullYear() + '-' + pad2(next.getMonth() + 1) + '-' + pad2(next.getDate()) + ' ' + pad2(next.getHours()) + ':' + pad2(next.getMinutes()) + ':' + pad2(next.getSeconds());
    }
    case 'weekly': {
      if (!task.scheduled_time || !task.scheduled_days) return '';
      const days = task.scheduled_days.split(',').map(Number);
      const [h, m] = task.scheduled_time.split(':').map(Number);
      const next = new Date(now);
      next.setHours(h || 0, m || 0, 0, 0);
      for (let i = 0; i < 7; i++) {
        const candidate = new Date(next);
        candidate.setDate(candidate.getDate() + i);
        const dayOfWeek = candidate.getDay() === 0 ? 7 : candidate.getDay();
        if (days.includes(dayOfWeek) && candidate > now) {
          return candidate.toISOString().slice(0, 19).replace('T', ' ');
        }
      }
      const nextWeek = new Date(next);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return nextWeek.toISOString().slice(0, 19).replace('T', ' ');
    }
    case 'once': {
      if (!task.scheduled_time) return '';
      const [h, m] = task.scheduled_time.split(':').map(Number);
      const next = new Date(now);
      next.setHours(h || 0, m || 0, 0, 0);
      if (next <= now) return '';
      const pad2 = (n: number) => String(n).padStart(2, '0');
      return next.getFullYear() + '-' + pad2(next.getMonth() + 1) + '-' + pad2(next.getDate()) + ' ' + pad2(next.getHours()) + ':' + pad2(next.getMinutes()) + ':' + pad2(next.getSeconds());
    }
    default:
      return '';
  }
}

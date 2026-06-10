import Router from '@koa/router';
import fs from "fs";
import path from "path";
import { getLogFilePath, logFileExists } from "../utils/logUtils";
import { getConfig, upsertTokenConfig, upsertDataApiUrl, updateAccessToken } from '../db/sqlite';
import { listPgDatasources, createPgDatasource, updatePgDatasource, deletePgDatasource, listSyncTasks, getSyncTask, createSyncTask, updateSyncTask, deleteSyncTask, listTaskExecutionLogs, createTaskExecutionLog, updateTaskExecutionLog, deleteTaskExecutionLog, listBackupConfigs, listBackupConfigsNames, getBackupConfig, createBackupConfig, updateBackupConfig, deleteBackupConfig, listBackupLogs, getBackupLog, deleteBackupLogs } from '../db/sqlite';
import axios from 'axios';
import { fetchAccessToken, fetchDataFromApi, QueryParams } from '../services/apiService';
import {
  listRemoteTables, getRemoteTable, createRemoteTable, updateRemoteTable, deleteRemoteTable
} from '../db/sqlite';
import { Pool } from 'pg';
import {
  createSyncConfig, updateSyncConfig, deleteSyncConfig, listSyncConfigs, getSyncConfig,
} from '../db/sqlite';
import { listPgTables, listPgColumns, previewSyncData, executeSyncImport, executeSyncImportStream, cancelImport } from '../services/syncService';
import { executeExcelImport } from '../services/excelImportService';
import { startScheduler, executeTaskSync } from '../services/schedulerService';
import { startBackupScheduler, runBackupNow, checkPgDumpInstalled, installPgTools, getInstallProgress, resetInstallProgress, getBackupProgress, stopBackup, startBackupProgressMonitor, stopBackupProgressMonitor, listDumpTables, restoreBackup, getRestoreProgress } from '../services/backupService';
import { exportConfig, importConfig, clearConfig } from '../db/sqlite';

const router = new Router({ prefix: '/api' });

// 服务器时间
router.get('/server/time', async (ctx) => {
  const now = new Date();
  ctx.body = {
    success: true,
    data: {
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      timestamp: now.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
});

// ========== Token 配置 ==========

router.get('/config/token', async (ctx) => {
  const config = await getConfig();
  if (config) {
    ctx.body = {
      success: true,
      data: {
        key: config.key,
        secret: config.secret,
        token_url: config.token_url,
        access_token: config.access_token,
      }
    };
  } else {
    ctx.body = { success: false, message: '未找到配置' };
  }
});

router.post('/config/token', async (ctx) => {
  const { key, secret, token_url } = ctx.request.body as any;
  if (!token_url) {
    ctx.body = { success: false, message: 'Token URL 不能为空' };
    return;
  }
  await upsertTokenConfig(key || '', secret || '', token_url);
  ctx.body = { success: true, message: 'Token 配置保存成功' };
});

router.post('/token/fetch', async (ctx) => {
  const result = await fetchAccessToken();
  if (result.success && result.token) {
    await updateAccessToken(result.token);
    ctx.body = { success: true, token: result.token, message: result.message };
  } else {
    ctx.body = { success: false, message: result.message };
  }
});

// ========== 数据 API 配置 ==========

router.get('/config/data-api', async (ctx) => {
  const config = await getConfig();
  if (config) {
    ctx.body = { success: true, data: { data_api_url: config.data_api_url } };
  } else {
    ctx.body = { success: false, message: '未找到配置' };
  }
});

router.post('/config/data-api', async (ctx) => {
  const { data_api_url } = ctx.request.body as any;
  if (!data_api_url) {
    ctx.body = { success: false, message: '数据 API URL 不能为空' };
    return;
  }
  await upsertDataApiUrl(data_api_url);
  ctx.body = { success: true, message: '数据 API 配置保存成功' };
});

// ========== PG 多数据源 CRUD ==========

// 列表
router.get('/config/pg-sources', async (ctx) => {
  const list = await listPgDatasources();
  ctx.body = { success: true, data: list };
});

// 新增
router.post('/config/pg-sources', async (ctx) => {
  const body = ctx.request.body as any;
  if (!body.name || !body.host || !body.user || !body.database) {
    ctx.body = { success: false, message: '名称、主机地址、用户名、数据库名为必填项' };
    return;
  }
  const id = await createPgDatasource({
    name: body.name,
    host: body.host,
    port: body.port || '5432',
    user: body.user,
    password: body.password || '',
    database: body.database,
    schema: body.schema || 'public',
    disable_import: body.disable_import !== undefined ? (body.disable_import ? 1 : 0) : 0,
  });
  ctx.body = { success: true, message: '数据源添加成功', data: { id } };
});

// 修改
router.put('/config/pg-sources/:id', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const body = ctx.request.body as any;
  await updatePgDatasource(id, {
    name: body.name || '',
    host: body.host || '',
    port: body.port || '5432',
    user: body.user || '',
    password: body.password || '',
    database: body.database || '',
    schema: body.schema || 'public',
    disable_import: body.disable_import !== undefined ? (body.disable_import ? 1 : 0) : 0,
  });
  ctx.body = { success: true, message: '数据源更新成功' };
});

// 删除
router.delete('/config/pg-sources/:id', async (ctx) => {
  const id = parseInt(ctx.params.id);
  await deletePgDatasource(id);
  ctx.body = { success: true, message: '数据源已删除' };
});

// 测试连接
router.post('/config/pg-sources/test', async (ctx) => {
  const body = ctx.request.body as any;
  const pgConfig = {
    host: body.host || '',
    port: parseInt(body.port || '5432'),
    user: body.user || '',
    password: body.password || '',
    database: body.database || '',
  };

  if (!pgConfig.host || !pgConfig.user || !pgConfig.database) {
    ctx.body = { success: false, message: '请填写完整的主机地址、用户名和数据库名' };
    return;
  }

  const pool = new Pool({ ...pgConfig, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT version()');
    const version = result.rows[0]?.version || '';
    ctx.body = { success: true, message: '连接成功', data: { version: version.split(',')[0] || version } };
  } catch (err: any) {
    ctx.body = { success: false, message: '连接失败: ' + (err.message || String(err)) };
  } finally {
    if (client) { try { client.release(); } catch {} }
    try { await pool.end(); } catch {}
  }
});

// ========== 数据拉取 ==========

router.post('/data/fetch', async (ctx) => {
  const body = ctx.request.body as any;
  const queryParams: QueryParams | undefined = body?.query;
  const apiUrlOverride = body?.apiUrl || undefined;
  const result = await fetchDataFromApi(queryParams, apiUrlOverride);
  ctx.body = result;
});


// ========== 远程数据表配置 CRUD ==========

router.get('/config/remote-tables', async (ctx) => {
  const list = await listRemoteTables();
  ctx.body = { success: true, data: list };
});

router.get('/config/remote-tables/:id', async (ctx) => {
  const t = await getRemoteTable(parseInt(ctx.params.id));
  if (t) ctx.body = { success: true, data: t };
  else ctx.body = { success: false, message: '未找到' };
});

router.post('/config/remote-tables', async (ctx) => {
  const body = ctx.request.body as any;
  if (!body.name || !body.data_api_url) {
    ctx.body = { success: false, message: '表名和数据 API URL 为必填项' };
    return;
  }
  const id = await createRemoteTable({
    name: body.name,
    data_api_url: body.data_api_url,
    conditions: body.conditions || '[]',
    logic: body.logic || 'and',
    page: body.page || 1,
    per_page: body.per_page || 20,
    order_field: body.order_field || '',
    order_dir: body.order_dir || 'asc',
  });
  ctx.body = { success: true, message: '配置保存成功', data: { id } };
});

router.put('/config/remote-tables/:id', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const body = ctx.request.body as any;
  await updateRemoteTable(id, {
    name: body.name || '',
    data_api_url: body.data_api_url || '',
    conditions: body.conditions || '[]',
    logic: body.logic || 'and',
    page: body.page || 1,
    per_page: body.per_page || 20,
    order_field: body.order_field || '',
    order_dir: body.order_dir || 'asc',
  });
  ctx.body = { success: true, message: '配置更新成功' };
});

router.delete('/config/remote-tables/:id', async (ctx) => {
  await deleteRemoteTable(parseInt(ctx.params.id));
  ctx.body = { success: true, message: '配置已删除' };
});


// ========== PG 表/列探索 ==========

router.post('/pg/tables', async (ctx) => {
  const body = ctx.request.body as any;
  const result = await listPgTables({
    host: body.host, port: parseInt(body.port || '5432'),
    user: body.user, password: body.password || '', database: body.database, schema: body.schema || 'public',
  });
  ctx.body = result;
});

router.post('/pg/columns', async (ctx) => {
  const body = ctx.request.body as any;
  const result = await listPgColumns({
    host: body.host, port: parseInt(body.port || '5432'),
    user: body.user, password: body.password || '', database: body.database, schema: body.schema || 'public',
  }, body.table || '');
  ctx.body = result;
});

// ========== Excel 手动导入 ==========

router.post('/excel-import/run', async (ctx) => {
  const body = ctx.request.body as any;
  const result = await executeExcelImport({
    pg_source_id: Number(body.pg_source_id),
    target_table: body.target_table || '',
    rows: Array.isArray(body.rows) ? body.rows : [],
    mappings: Array.isArray(body.mappings) ? body.mappings : [],
    batch_size: body.batch_size,
  });
  ctx.body = result;
});

// 获取远程表的字段列表（通过拉取数据获取 data_struct）
router.get('/config/remote-tables/:id/fields', async (ctx) => {
  const t = await getRemoteTable(parseInt(ctx.params.id));
  if (!t) { ctx.body = { success: false, message: '未找到表配置' }; return; }
  const cfg = await getConfig();
  if (!cfg || !cfg.token_url) { ctx.body = { success: false, message: '请先配置 Token' }; return; }

  try {
    // 先获取 token
    const tokenRes = await axios.post(cfg.token_url, { key: cfg.key, secret: cfg.secret },
      { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
    const token = tokenRes.data.result?.access_token || tokenRes.data.access_token;

    // 拉取一页数据获取 data_struct
    const apiRes = await axios.post(t.data_api_url, { access_token: token, page: 1, per_page: 1 },
      { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
    const rawData = apiRes.data.result || apiRes.data;
    const dataStruct = rawData.data_struct || {};

    const fields = Object.entries(dataStruct).map(([name, desc]) => ({ name, description: desc }));
    ctx.body = { success: true, data: fields };
  } catch (err: any) {
    ctx.body = { success: false, message: err.message || String(err) };
  }
});

// ========== 同步配置 CRUD ==========

router.get('/sync-configs', async (ctx) => {
  const list = await listSyncConfigs();
  ctx.body = { success: true, data: list };
});

router.get('/sync-configs/:id', async (ctx) => {
  const cfg = await getSyncConfig(parseInt(ctx.params.id));
  if (cfg) ctx.body = { success: true, data: cfg };
  else ctx.body = { success: false, message: '未找到' };
});

router.post('/sync-configs', async (ctx) => {
  const body = ctx.request.body as any;
  const id = await createSyncConfig({
    name: body.name || '',
    remote_table_id: body.remote_table_id || 0,
    pg_source_id: body.pg_source_id || 0,
    target_table: body.target_table || '',
    target_pk: body.target_pk || '',
    import_settings: body.import_settings || '[]',
    page: body.page || 1,
    per_page: body.per_page || 200,
    all_import: body.all_import || 0, conditions: body.conditions || '[]', logic: body.logic || 'and', order_field: body.order_field || '', order_dir: body.order_dir || 'asc',
  });
  ctx.body = { success: true, message: '配置保存成功', data: { id } };
});

router.put('/sync-configs/:id', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const body = ctx.request.body as any;
  await updateSyncConfig(id, {
    name: body.name || '',
    remote_table_id: body.remote_table_id || 0,
    pg_source_id: body.pg_source_id || 0,
    target_table: body.target_table || '',
    target_pk: body.target_pk || '',
    import_settings: body.import_settings || '[]',
    page: body.page || 1,
    per_page: body.per_page || 200,
    all_import: body.all_import || 0, conditions: body.conditions || '[]', logic: body.logic || 'and', order_field: body.order_field || '', order_dir: body.order_dir || 'asc',
  });
  ctx.body = { success: true, message: '配置更新成功' };
});

router.delete('/sync-configs/:id', async (ctx) => {
  await deleteSyncConfig(parseInt(ctx.params.id));
  ctx.body = { success: true, message: '配置已删除' };
});

// 预览
router.post('/sync-configs/:id/preview', async (ctx) => {
  const result = await previewSyncData(parseInt(ctx.params.id));
  ctx.body = result;
});

// 导入

// 导入（SSE 流式进度）
router.get('/sync-configs/:id/import-stream', async (ctx) => {
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  ctx.respond = false;
  const { res } = ctx;
  res.writeHead(200);

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await executeSyncImportStream(parseInt(ctx.params.id), send);
  } finally {
    res.end();
  }
});

router.post('/sync-configs/:id/import', async (ctx) => {
  const result = await executeSyncImport(parseInt(ctx.params.id));
  ctx.body = result;
});

router.post('/sync-configs/:id/import-cancel', async (ctx) => {
  const id = parseInt(ctx.params.id);
  cancelImport(id);
  ctx.body = { success: true, message: '已发送中断信号，等待当前页导入完成后停止' };
});


// ========== 定时任务管理 ==========

// 获取所有任务
router.get('/sync-tasks', async (ctx) => {
  const tasks = await listSyncTasks();
  ctx.body = { success: true, data: tasks };
});

// 获取单个任务
router.get('/sync-tasks/:id', async (ctx) => {
  const task = await getSyncTask(parseInt(ctx.params.id));
  if (!task) { ctx.body = { success: false, message: '任务不存在' }; return; }
  ctx.body = { success: true, data: task };
});

// 创建任务
router.post('/sync-tasks', async (ctx) => {
  const body = ctx.request.body as any;
  const syncConfigIds = body.sync_config_ids || (body.sync_config_id ? JSON.stringify([body.sync_config_id]) : '[]');
  const ids = JSON.parse(syncConfigIds);
  if (!body.name) {
    ctx.body = { success: false, message: '任务名称不能为空' };
    return;
  }
  if ((!body.task_type || body.task_type === 'sync') && (!Array.isArray(ids) || ids.length === 0)) {
    ctx.body = { success: false, message: '同步任务需要选择同步配置' };
    return;
  }
  if (body.task_type === 'backup' && !body.backup_config_id) {
    ctx.body = { success: false, message: '备份任务需要选择备份配置' };
    return;
  }
  const id = await createSyncTask({
    name: body.name,
    sync_config_id: ids[0] || 0,
    sync_config_ids: syncConfigIds,
    type: body.type || 'interval',
    interval_value: body.interval_value || 0,
    interval_unit: body.interval_unit || 'minutes',
    cron_expr: body.cron_expr || '',
    scheduled_time: body.scheduled_time || '',
    scheduled_days: body.scheduled_days || '',
    enabled: body.enabled !== undefined ? body.enabled : 1,
    task_type: body.task_type || 'sync',
    backup_config_id: body.backup_config_id || 0,
    backup_dir: body.backup_dir || '',
    keep_days: body.keep_days || 7,
  });
  ctx.body = { success: true, data: { id }, message: '任务创建成功' };
});

// 更新任务
router.put('/sync-tasks/:id', async (ctx) => {
  const body = ctx.request.body as any;
  const id = parseInt(ctx.params.id);
  const existing = await getSyncTask(id);
  if (!existing) { ctx.body = { success: false, message: '任务不存在' }; return; }
  const syncConfigIds = body.sync_config_ids !== undefined ? body.sync_config_ids : existing.sync_config_ids;
  const ids = JSON.parse(typeof syncConfigIds === 'string' ? syncConfigIds : JSON.stringify(syncConfigIds));
  await updateSyncTask(id, {
    name: body.name || existing.name,
    sync_config_id: Array.isArray(ids) && ids.length > 0 ? ids[0] : existing.sync_config_id,
    sync_config_ids: typeof syncConfigIds === 'string' ? syncConfigIds : JSON.stringify(syncConfigIds),
    type: body.type || existing.type,
    interval_value: body.interval_value !== undefined ? body.interval_value : existing.interval_value,
    interval_unit: body.interval_unit || existing.interval_unit,
    cron_expr: body.cron_expr !== undefined ? body.cron_expr : existing.cron_expr,
    scheduled_time: body.scheduled_time !== undefined ? body.scheduled_time : existing.scheduled_time,
    scheduled_days: body.scheduled_days !== undefined ? body.scheduled_days : existing.scheduled_days,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    task_type: body.task_type || existing.task_type || 'sync',
    backup_config_id: body.backup_config_id !== undefined ? body.backup_config_id : (existing.backup_config_id || 0),
    backup_dir: body.backup_dir !== undefined ? body.backup_dir : (existing.backup_dir || ''),
    keep_days: body.keep_days !== undefined ? body.keep_days : (existing.keep_days || 7),
  });
  ctx.body = { success: true, message: '任务更新成功' };
});

// 删除任务
router.delete('/sync-tasks/:id', async (ctx) => {
  await deleteSyncTask(parseInt(ctx.params.id));
  ctx.body = { success: true, message: '任务已删除' };
});

// 手动触发任务执行
router.post('/sync-tasks/:id/run', async (ctx) => {
  const task = await getSyncTask(parseInt(ctx.params.id));
  if (!task) { ctx.body = { success: false, message: '任务不存在' }; return; }
  try {
    if (task.task_type === 'backup') {
      // 手动执行备份任务 - 创建执行日志并异步运行
      const backupConfig = await getBackupConfig(task.backup_config_id);
      if (!backupConfig) {
        ctx.body = { success: false, message: '备份配置不存在' };
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
      // 异步执行备份
      runBackupNow(task.backup_config_id).catch(err => console.error('[Manual] 备份异常:', err));
      // 启动进度监视器，自动更新执行日志
      startBackupProgressMonitor(task.backup_config_id, logId);
      ctx.body = { success: true, message: '备份已开始执行' };
    } else {
      const result = await executeTaskSync(task);
      ctx.body = { success: true, data: result, message: result.message };
    }
  } catch (err: any) {
    ctx.body = { success: false, message: err.message || '执行失败' };
  }
});

// 启动调度器（初始化时调用）
startScheduler();

// 获取任务执行日志
router.get('/sync-tasks/:id/executions', async (ctx) => {
  const logs = await listTaskExecutionLogs(parseInt(ctx.params.id));
  ctx.body = { success: true, data: logs };
});

// ========== 配置导入/导出 ==========

// 导出配置
router.post('/config/export', async (ctx) => {
  const body = ctx.request.body as any;
  const categories = body.categories || [];
  try {
    const data = await exportConfig(categories);
    ctx.body = { success: true, data, message: '导出成功' };
  } catch (err: any) {
    ctx.body = { success: false, message: '导出失败: ' + err.message };
  }
});

// 清空配置
// 删除执行日志
router.post('/task-logs/delete', async (ctx) => {
  const { ids } = ctx.request.body as any;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    ctx.body = { success: false, message: '请选择要删除的日志' };
    return;
  }
  for (const id of ids) {
    await deleteTaskExecutionLog(Number(id));
  }
  ctx.body = { success: true, message: `已删除 ${ids.length} 条日志` };
});

router.post('/config/clear', async (ctx) => {
  const body = ctx.request.body as any;
  const categories = body.categories || [];
  try {
    await clearConfig(categories);
    ctx.body = { success: true, message: '已清空所选配置' };
  } catch (err: any) {
    ctx.body = { success: false, message: '清空失败: ' + err.message };
  }
});

// 导入配置
router.post('/config/import', async (ctx) => {
  const body = ctx.request.body as any;
  const categories = body.categories || [];
  try {
    const result = await importConfig(body.data || {}, categories);
    ctx.body = { success: true, data: result, message: '导入完成: ' + result.imported.join(', ') + (result.errors.length > 0 ? ', 错误: ' + result.errors.join('; ') : '') };
  } catch (err: any) {
    ctx.body = { success: false, message: '导入失败: ' + err.message };
  }
});

// ========== 备份配置管理 ==========

router.get('/backup-configs', async (ctx) => {
  const configs = await listBackupConfigs();
  ctx.body = { success: true, data: configs };
});

router.get('/backup-configs/:id', async (ctx) => {
  const cfg = await getBackupConfig(parseInt(ctx.params.id));
  if (!cfg) { ctx.body = { success: false, message: '配置不存在' }; return; }
  ctx.body = { success: true, data: cfg };
});

router.post('/backup-configs', async (ctx) => {
  const body = ctx.request.body as any;
  if (!body.name || !body.pg_source_id) { ctx.body = { success: false, message: '名称和数据源不能为空' }; return; }
  const id = await createBackupConfig({
    name: body.name, pg_source_id: body.pg_source_id,
    database_name: body.database_name || '',
    backup_dir: body.backup_dir || '', keep_days: body.keep_days || 7,
    backup_format: body.backup_format || 'sql',
    enabled: body.enabled !== undefined ? body.enabled : 1,
    type: body.type || 'daily', interval_value: body.interval_value || 0,
    interval_unit: body.interval_unit || 'hours', scheduled_time: body.scheduled_time || '',
  });
  ctx.body = { success: true, data: { id }, message: '创建成功' };
});

router.put('/backup-configs/:id', async (ctx) => {
  const body = ctx.request.body as any;
  const id = parseInt(ctx.params.id);
  const existing = await getBackupConfig(id);
  if (!existing) { ctx.body = { success: false, message: '配置不存在' }; return; }
  await updateBackupConfig(id, {
    name: body.name || existing.name, pg_source_id: body.pg_source_id !== undefined ? body.pg_source_id : existing.pg_source_id,
    database_name: body.database_name !== undefined ? body.database_name : existing.database_name,
    backup_dir: body.backup_dir !== undefined ? body.backup_dir : existing.backup_dir,
    keep_days: body.keep_days !== undefined ? body.keep_days : existing.keep_days,
    backup_format: body.backup_format !== undefined ? body.backup_format : (existing.backup_format || 'sql'),
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    type: body.type || existing.type, interval_value: body.interval_value !== undefined ? body.interval_value : existing.interval_value,
    interval_unit: body.interval_unit || existing.interval_unit, scheduled_time: body.scheduled_time !== undefined ? body.scheduled_time : existing.scheduled_time,
  });
  ctx.body = { success: true, message: '更新成功' };
});

router.delete('/backup-configs/:id', async (ctx) => {
  await deleteBackupConfig(parseInt(ctx.params.id));
  ctx.body = { success: true, message: '已删除' };
});

// 立即执行备份
router.post('/backup-configs/:id/run', async (ctx) => {
  const result = await runBackupNow(parseInt(ctx.params.id));
  ctx.body = result;
});

// 停止备份
router.post('/backup-configs/:id/stop', async (ctx) => {
  const result = stopBackup(parseInt(ctx.params.id));
  ctx.body = result;
});

// 获取备份进度
router.get('/backup-configs/:id/progress', async (ctx) => {
  const progress = getBackupProgress(parseInt(ctx.params.id));
  if (progress) {
    ctx.body = { success: true, data: progress };
  } else {
    ctx.body = { success: false, message: '没有正在执行的备份或进度已过期' };
  }
});

// 备份配置名称列表（供下拉选择）
router.get('/config/backup-configs-names', async (ctx) => {
  const configs = await listBackupConfigsNames();
  ctx.body = { success: true, data: configs };
});

// 检查 pg_dump 是否已安装
router.get('/backup/check-pgdump', async (ctx) => {
  const result = checkPgDumpInstalled();
  ctx.body = { success: true, data: result };
});

// 安装 PostgreSQL 备份工具
// 启动安装（后台执行）
router.post('/backup/install-pgtools', async (ctx) => {
  resetInstallProgress();
  // 后台执行，立即返回
  installPgTools().catch(err => console.error('[Backup] 安装异常:', err));
  ctx.body = { success: true, message: '安装已启动' };
});

// 安装进度查询
router.get('/backup/install-progress', async (ctx) => {
  ctx.body = getInstallProgress();
});

// 备份日志
router.get('/backup-configs/:id/logs', async (ctx) => {
  const logs = await listBackupLogs(parseInt(ctx.params.id));
  ctx.body = { success: true, data: logs };
});

// 获取 PG 数据源的所有数据库列表
router.get('/config/pg-sources/:id/databases', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const sources = await listPgDatasources();
  const src = sources.find(s => s.id === id);
  if (!src) {
    ctx.body = { success: false, message: '数据源不存在' };
    return;
  }

  const pgConfig = {
    host: src.host,
    port: parseInt(src.port || '5432'),
    user: src.user,
    password: src.password || '',
    database: src.database, // 连接到数据源默认数据库
    connectionTimeoutMillis: 5000,
  };

  const pool = new Pool(pgConfig);
  let client;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
    const databases = result.rows.map((r: any) => r.datname);
    ctx.body = { success: true, data: databases };
  } catch (err: any) {
    ctx.body = { success: false, message: '获取数据库列表失败: ' + err.message };
  } finally {
    if (client) { try { client.release(); } catch {} }
    try { await pool.end(); } catch {}
  }
});

// 获取 PG 数据源的所有数据库列表（支持 POST 传入临时密码）
router.post('/config/pg-sources/:id/databases', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const body = ctx.request.body as { password?: string };
  const sources = await listPgDatasources();
  const src = sources.find(s => s.id === id);
  if (!src) {
    ctx.body = { success: false, message: '数据源不存在' };
    return;
  }

  const pgConfig = {
    host: src.host,
    port: parseInt(src.port || '5432'),
    user: src.user,
    password: body.password || src.password || '',
    database: src.database, // 连接到数据源默认数据库
    connectionTimeoutMillis: 5000,
  };

  const pool = new Pool(pgConfig);
  let client;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
    const databases = result.rows.map((r: any) => r.datname);
    ctx.body = { success: true, data: databases };
  } catch (err: any) {
    ctx.body = { success: false, message: '获取数据库列表失败: ' + err.message };
  } finally {
    if (client) { try { client.release(); } catch {} }
    try { await pool.end(); } catch {}
  }
});

// 获取备份文件中的表结构列表
router.get('/backup-logs/:id/tables', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const log = await getBackupLog(id);
  if (!log) {
    ctx.body = { success: false, message: '备份日志不存在' };
    return;
  }
  if (!log.backup_file) {
    ctx.body = { success: false, message: '该备份日志没有关联的备份文件' };
    return;
  }

  const config = await getBackupConfig(log.config_id);
  const backupDir = config?.backup_dir || path.resolve(process.cwd(), 'backups');

  // 查找 dump 文件
  const files = log.backup_file.split(',').map(f => f.trim()).filter(Boolean);
  const dumpFile = files.find(f => f.endsWith('.dump'));
  
  if (!dumpFile) {
    ctx.body = { success: false, message: '该备份为 SQL 格式，不支持获取表列表进行选择性恢复。' };
    return;
  }

  const filePath = path.join(backupDir, dumpFile);
  if (!fs.existsSync(filePath)) {
    ctx.body = { success: false, message: '备份文件不存在: ' + dumpFile };
    return;
  }

  try {
    const tables = await listDumpTables(filePath);
    ctx.body = { success: true, data: tables };
  } catch (err: any) {
    ctx.body = { success: false, message: '获取表列表失败: ' + err.message };
  }
});

// 恢复备份（异步启动）
router.post('/backup-logs/:id/restore', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const body = ctx.request.body as { 
    pg_source_id: number; 
    database_name: string; 
    tables?: string[]; 
    overwrite: boolean; 
    disable_triggers?: boolean;
    temp_password?: string;
  };
  
  const log = await getBackupLog(id);
  if (!log) {
    ctx.body = { success: false, message: '备份日志不存在' };
    return;
  }
  if (!log.backup_file) {
    ctx.body = { success: false, message: '该备份日志没有关联 of 备份文件' };
    return;
  }

  const config = await getBackupConfig(log.config_id);
  const backupDir = config?.backup_dir || path.resolve(process.cwd(), 'backups');

  const files = log.backup_file.split(',').map(f => f.trim()).filter(Boolean);
  let selectedFile = files[0];
  
  // 优先选择 dump 文件进行恢复（如果指定了表，则必须使用 dump 格式）
  const dumpFile = files.find(f => f.endsWith('.dump'));
  const sqlFile = files.find(f => f.endsWith('.sql'));
  
  if (body.tables && body.tables.length > 0) {
    if (dumpFile) {
      selectedFile = dumpFile;
    } else {
      ctx.body = { success: false, message: '当前备份仅包含 SQL 格式，不支持恢复指定表。请不要选择指定表，或使用 DUMP 格式备份进行恢复。' };
      return;
    }
  } else {
    selectedFile = dumpFile || sqlFile || files[0];
  }

  const filePath = path.join(backupDir, selectedFile);
  if (!fs.existsSync(filePath)) {
    ctx.body = { success: false, message: '备份文件不存在: ' + selectedFile };
    return;
  }

  const sources = await listPgDatasources();
  const targetSrc = sources.find(s => s.id === body.pg_source_id);
  if (!targetSrc) {
    ctx.body = { success: false, message: '目标数据源不存在' };
    return;
  }

  // 如果前端传入了临时密码，则覆盖使用临时密码
  if (body.temp_password) {
    targetSrc.password = body.temp_password;
  }

  const dbName = body.database_name || targetSrc.database;

  // 异步执行数据恢复，并在后台更新进度
  restoreBackup(filePath, targetSrc, dbName, {
    tables: body.tables,
    overwrite: body.overwrite,
    disableTriggers: body.disable_triggers !== undefined ? body.disable_triggers : true,
    logId: id
  }).catch(err => {
    console.error('[Async Restore] 任务运行异常:', err);
  });

  ctx.body = { success: true, message: '数据恢复任务已在后台启动，正在刷新进度...' };
});

// 获取恢复进度
router.get('/backup-logs/:id/restore-progress', async (ctx) => {
  const id = parseInt(ctx.params.id);
  const progress = getRestoreProgress(id);
  if (progress) {
    ctx.body = { success: true, data: progress };
  } else {
    ctx.body = { success: false, message: '未找到该备份的恢复进度，或者恢复任务已结束超过 30 秒' };
  }
});

// 批量删除备份日志
router.delete('/backup-logs', async (ctx) => {
  const { ids } = ctx.request.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    ctx.body = { success: false, message: '请提供要删除的日志 ID' };
    return;
  }
  await deleteBackupLogs(ids);
  ctx.body = { success: true, message: `已删除 ${ids.length} 条日志` };
});

// 下载备份文件
router.get('/backup-logs/:id/download', async (ctx) => {
  const log = await getBackupLog(parseInt(ctx.params.id));
  if (!log) { ctx.body = { success: false, message: '日志不存在' }; return; }
  if (!log.backup_file) { ctx.body = { success: false, message: '无备份文件' }; return; }

  const config = await getBackupConfig(log.config_id);
  const backupDir = config?.backup_dir || path.resolve(process.cwd(), 'backups');

  // 取第一个文件名（支持逗号分隔的多个文件）
  const firstFile = log.backup_file.split(',')[0].trim();
  const filePath = path.join(backupDir, firstFile);

  if (!fs.existsSync(filePath)) {
    ctx.body = { success: false, message: '文件不存在: ' + firstFile };
    return;
  }

  const stat = fs.statSync(filePath);
  ctx.set('Content-Type', 'application/octet-stream');
  ctx.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(firstFile) + '"');
  ctx.set('Content-Length', String(stat.size));
  ctx.body = fs.createReadStream(filePath);
});

// 按文件名下载备份文件（通过遍历所有备份配置查找）
router.get('/backup-logs/by-file/:filename', async (ctx) => {
  const filename = decodeURIComponent(ctx.params.filename);
  if (!filename) { ctx.body = { success: false, message: '文件名不能为空' }; return; }

  // 遍历所有备份配置，查找文件
  const configs = await listBackupConfigs();
  for (const cfg of configs) {
    const backupDir = cfg.backup_dir || path.resolve(process.cwd(), 'backups');
    const filePath = path.join(backupDir, filename);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      ctx.set('Content-Type', 'application/octet-stream');
      ctx.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
      ctx.set('Content-Length', String(stat.size));
      ctx.body = fs.createReadStream(filePath);
      return;
    }
  }

  ctx.body = { success: false, message: '文件未找到: ' + filename };
});

// ==================== 登录认证 ====================

// 检查登录状态
router.get('/auth/check', async (ctx) => {
  const { getConfig } = require('../db/sqlite');
  const config = await getConfig();
  const loggedIn = !!ctx.cookies.get('auth_token');
  ctx.body = { success: true, data: { loggedIn: loggedIn || false, hasDefaultPassword: config?.auth_password === 'admin' } };
});

// 登录
router.post('/auth/login', async (ctx) => {
  const body = ctx.request.body as any;
  const { getConfig } = require('../db/sqlite');
  const config = await getConfig();
  const storedPassword = config?.auth_password || 'admin';
  if (body.username === 'admin' && body.password === storedPassword) {
    // 设置简单的 session cookie（1 天有效期）
    ctx.cookies.set('auth_token', 'authenticated', { httpOnly: true, maxAge: 86400000, sameSite: 'lax' });
    ctx.body = { success: true, message: '登录成功' };
  } else {
    ctx.body = { success: false, message: '用户名或密码错误' };
  }
});

// 修改密码
router.post('/auth/change-password', async (ctx) => {
  const body = ctx.request.body as any;
  const { getConfig, getConfigValue } = require('../db/sqlite');
  const config = await getConfig();
  const storedPassword = config?.auth_password || 'admin';
  if (body.oldPassword !== storedPassword) {
    ctx.body = { success: false, message: '原密码错误' };
    return;
  }
  if (!body.newPassword || body.newPassword.length < 3) {
    ctx.body = { success: false, message: '新密码至少 3 个字符' };
    return;
  }
  // 更新密码
  const crypto = require('crypto');
  const db = (await require('../db/sqlite').initDb());
  require('../db/sqlite').db?.run("UPDATE configs SET auth_password=?, updated_at=datetime('now','localtime') WHERE id=?", [body.newPassword, config.id]);
  require('../db/sqlite').saveDb?.();
  ctx.body = { success: true, message: '密码修改成功' };
});

// 退出登录
router.post('/auth/logout', async (ctx) => {
  ctx.cookies.set('auth_token', '', { maxAge: 0 });
  ctx.body = { success: true, message: '已退出' };
});

// 启动备份调度器
startBackupScheduler();

// 下载导入失败日志
router.get("/logs/:filename", async (ctx) => {
  const filename = ctx.params.filename;
  if (!logFileExists(filename)) {
    ctx.status = 404;
    ctx.body = { success: false, message: "日志文件不存在" };
    return;
  }
  const filepath = getLogFilePath(filename);
  ctx.set("Content-Disposition", "attachment; filename=\"" + filename + "\"");
  ctx.set("Content-Type", "text/csv;charset=utf-8");
  ctx.body = fs.createReadStream(filepath);
});
export default router;

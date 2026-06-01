import axios from 'axios';
import { Pool } from 'pg';
import { getSyncConfig, getRemoteTable, listPgDatasources, getConfig, updateAccessToken } from '../db/sqlite';
import { getValidToken, fetchAccessToken } from './apiService';
import type { SyncConfig } from '../db/sqlite';
import { saveFailedRecords } from '../utils/logUtils';

// 导入取消标记
const cancellationFlags = new Set<number>();

export function cancelImport(syncConfigId: number) {
  cancellationFlags.add(syncConfigId);
}

export function isImportCancelled(syncConfigId: number): boolean {
  return cancellationFlags.has(syncConfigId);
}

function clearCancelled(syncConfigId: number) {
  cancellationFlags.delete(syncConfigId);
}

interface ImportSetting {
  srcField: string;
  distField: string;
  type: string;
  isPk?: boolean;
  transformer?: { methods: string; value?: string; mapping?: Record<string, string>; customCode?: string };
}

/** 判断响应是否为 token 无效/过期 */
function isTokenInvalid(data: any): boolean {
  if (!data) return false;
  const code = data.code;
  if (code === 20010 || code === 401 || code === 20001 || code === 20002) return true;
  const msg = (data.message || data.description || '').toLowerCase();
  if (msg.includes('token') || msg.includes('access_token') || msg.includes('无效') || msg.includes('过期')) return true;
  return false;
}

/** 带 token 刷新的 API 请求 */
async function apiPostWithTokenRetry(
  url: string,
  body: Record<string, unknown>,
  retryOnTokenError = true
): Promise<any> {
  try {
    const res = await axios.post(url, body, {
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' },
    });
    return res;
  } catch (error: any) {
    const respData = error.response?.data;
    if (retryOnTokenError && isTokenInvalid(respData)) {
      // 重新获取 token
      const newTokenResult = await fetchAccessToken();
      if (newTokenResult.success && newTokenResult.token) {
        await updateAccessToken(newTokenResult.token);
        body.access_token = newTokenResult.token;
        return await axios.post(url, body, {
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    throw error;
  }
}

// ========== PG 工具 ==========

export async function listPgTables(pgSource: {
  host: string; port: number; user: string; password: string; database: string;
}): Promise<{ success: boolean; tables?: string[]; message: string }> {
  const pool = new Pool({ ...pgSource, connectionTimeoutMillis: 5000 });
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    return { success: true, tables: result.rows.map((r: any) => r.table_name), message: 'ok' };
  } catch (err: any) {
    return { success: false, message: err.message };
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

export async function listPgColumns(pgSource: {
  host: string; port: number; user: string; password: string; database: string;
}, tableName: string): Promise<{ success: boolean; columns?: { name: string; type: string; comment: string }[]; message: string }> {
  const pool = new Pool({ ...pgSource, connectionTimeoutMillis: 5000 });
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      "SELECT col_description(a.attrelid,a.attnum) as comment, format_type(a.atttypid,a.atttypmod) as type, a.attname as name " +
      "FROM pg_class as c, pg_attribute as a WHERE c.relname=$1 AND a.attrelid=c.oid AND a.attnum>0 AND a.attname NOT LIKE '%pg.dropped%'",
      [tableName]
    );
    return {
      success: true,
      columns: result.rows.map((r: any) => ({ name: r.name, type: r.type, comment: r.comment || '' })),
      message: 'ok',
    };
  } catch (err: any) {
    return { success: false, message: err.message };
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

// ========== 预览 ==========

export async function previewSyncData(syncConfigId: number) {
  const syncCfg = await getSyncConfig(syncConfigId);
  if (!syncCfg) return { success: false, message: '未找到导入配置' };

  const remoteTable = await getRemoteTable(syncCfg.remote_table_id);
  if (!remoteTable) return { success: false, message: '未找到远程表配置' };

  const pgSources = await listPgDatasources();
  const pgSource = pgSources.find((s: any) => s.id === syncCfg.pg_source_id);
  if (!pgSource) return { success: false, message: '未找到 PG 数据源' };

  const importSettings: ImportSetting[] = parseSettings(syncCfg.import_settings);

  try {
    // 动态获取 token
    const token = await getValidToken();

    const apiResponse = await apiPostWithTokenRetry(
      remoteTable.data_api_url,
      buildSyncRequestBody(token, syncCfg, { page: syncCfg.page || 1, per_page: syncCfg.per_page || 10 })
    );

    const rawData = apiResponse.data.result || apiResponse.data;
    const sourceRecords: any[] = rawData.data || rawData.records || rawData.list || [];
    const transformed = applyTransform(sourceRecords, importSettings);

    // 目标表列信息
    const pool = new Pool({
      host: pgSource.host, port: parseInt(pgSource.port), user: pgSource.user,
      password: pgSource.password, database: pgSource.database, connectionTimeoutMillis: 5000,
    });
    let client;
    const targetColumns: any[] = [];
    try {
      client = await pool.connect();
      const colRes = await client.query(
        "SELECT col_description(a.attrelid,a.attnum) as comment, format_type(a.atttypid,a.atttypmod) as type, a.attname as name " +
        "FROM pg_class as c, pg_attribute as a WHERE c.relname=$1 AND a.attrelid=c.oid AND a.attnum>0 AND a.attname NOT LIKE '%pg.dropped%'",
        [syncCfg.target_table]
      );
      targetColumns.push(...colRes.rows);
    } finally {
      if (client) client.release();
      await pool.end();
    }

    return {
      success: true,
      data: {
        sourceTotal: rawData.total || sourceRecords.length,
        previewCount: Math.min(sourceRecords.length, 5),
        sourceRecords: sourceRecords.slice(0, 5),
        transformedRecords: transformed.slice(0, 5),
        importSettings,
        targetColumns: targetColumns.map((c: any) => ({ name: c.name, type: c.type, comment: c.comment || '' })),
      },
      message: '预览成功',
    };
  } catch (err: any) {
    return { success: false, message: err.message || String(err) };
  }
}

// ========== 导入 ==========

/**
 * 带进度回调的导入（用于 SSE 流式推送）
 * onProgress: (event, data) => void
 *   event: 'start', 'progress', 'page', 'done', 'error'
 */
export async function executeSyncImportStream(
  syncConfigId: number,
  onProgress: (event: string, data: any) => void
): Promise<void> {
  const syncCfg = await getSyncConfig(syncConfigId);
  if (!syncCfg) { onProgress('error', { message: '未找到导入配置' }); return; }

  const remoteTable = await getRemoteTable(syncCfg.remote_table_id);
  if (!remoteTable) { onProgress('error', { message: '未找到远程表配置' }); return; }

  const pgSources = await listPgDatasources();
  const pgSource = pgSources.find((s: any) => s.id === syncCfg.pg_source_id);
  if (!pgSource) { onProgress('error', { message: '未找到 PG 数据源' }); return; }

  const importSettings: ImportSetting[] = parseSettings(syncCfg.import_settings);

  try {
    const token = await getValidToken();

    // 获取总数
    const firstPage = await apiPostWithTokenRetry(
      remoteTable.data_api_url,
      buildSyncRequestBody(token, syncCfg, { page: 1, per_page: 1 })
    );
    const firstData = firstPage.data.result || firstPage.data;
    const total = firstData.total || 0;
    const perPage = syncCfg.per_page || 200;
    const maxPage = Math.max(1, Math.ceil(total / perPage));

    onProgress('start', { total, perPage, maxPage });

    const pool = new Pool({
      host: pgSource.host, port: parseInt(pgSource.port), user: pgSource.user,
      password: pgSource.password, database: pgSource.database,
    });

    let totalSuccess = 0, totalErrors = 0;
    let totalImported = 0;
    const allFailedRecords: { data: Record<string, any>; reason: string }[] = [];

    for (let page = 1; page <= maxPage; page++) {
      if (isImportCancelled(syncConfigId)) {
        clearCancelled(syncConfigId);
        // 保存失败记录到日志文件
        let logFilename = '';
        if (allFailedRecords.length > 0) {
          logFilename = saveFailedRecords(syncCfg.target_table, allFailedRecords);
        }
        onProgress('cancelled', { imported: totalImported, success: totalSuccess, error: totalErrors, failedRecords: allFailedRecords.slice(0, 200), logFilename: logFilename });
        await pool.end();
        return;
      }
      try {
        const pageRes = await apiPostWithTokenRetry(
          remoteTable.data_api_url,
          buildSyncRequestBody(token, syncCfg, { page, per_page: perPage })
        );
        const pageData = pageRes.data.result || pageRes.data;
        const records: any[] = pageData.data || pageData.records || pageData.list || [];
        if (records.length === 0) continue;

        const transformed = applyTransform(records, importSettings);
        const result = await upsertRecords(pool, syncCfg.target_table, syncCfg.target_pk, transformed, importSettings);
        totalSuccess += result.success;
        totalErrors += result.error;
        totalImported += result.success + result.error;
        allFailedRecords.push(...result.failedRecords);

        onProgress('progress', {
          page, maxPage, total,
          imported: totalImported,
          success: totalSuccess,
          error: totalErrors,
        });
      } catch (e: any) {
        totalErrors += 1;
        onProgress('progress', {
          page, maxPage, total,
          imported: totalImported + 1,
          success: totalSuccess,
          error: totalErrors,
        });
      }
    }

    await pool.end();

    // 保存失败记录到日志文件
    let logFilename = '';
    if (allFailedRecords.length > 0) {
      logFilename = saveFailedRecords(syncCfg.target_table, allFailedRecords);
    }
    onProgress('done', {
      total: totalSuccess + totalErrors,
      success: totalSuccess,
      error: totalErrors,
      message: '导入完成: ' + totalSuccess + ' 成功, ' + totalErrors + ' 失败',
      failedCount: allFailedRecords.length,
      failedRecords: allFailedRecords.slice(0, 200),
      logFilename: logFilename,
    });
  } catch (err: any) {
    onProgress('error', { message: err.message || String(err) });
  }
}

export async function executeSyncImport(syncConfigId: number) {
  const syncCfg = await getSyncConfig(syncConfigId);
  if (!syncCfg) return { success: false, message: '未找到导入配置' };

  const remoteTable = await getRemoteTable(syncCfg.remote_table_id);
  if (!remoteTable) return { success: false, message: '未找到远程表配置' };

  const pgSources = await listPgDatasources();
  const pgSource = pgSources.find((s: any) => s.id === syncCfg.pg_source_id);
  if (!pgSource) return { success: false, message: '未找到 PG 数据源' };

  const importSettings: ImportSetting[] = parseSettings(syncCfg.import_settings);

  try {
    // 动态获取 token
    const token = await getValidToken();

    // 获取总数
    const firstPage = await apiPostWithTokenRetry(
      remoteTable.data_api_url,
      buildSyncRequestBody(token, syncCfg, { page: 1, per_page: 1 })
    );
    const firstData = firstPage.data.result || firstPage.data;
    const total = firstData.total || 0;
    const perPage = syncCfg.per_page || 200;
    const maxPage = Math.max(1, Math.ceil(total / perPage));

    const pool = new Pool({
      host: pgSource.host, port: parseInt(pgSource.port), user: pgSource.user,
      password: pgSource.password, database: pgSource.database,
    });

    let totalSuccess = 0, totalErrors = 0;
    const allErrors: string[] = [];

    for (let page = 1; page <= maxPage; page++) {
      try {
        const pageRes = await apiPostWithTokenRetry(
          remoteTable.data_api_url,
          buildSyncRequestBody(token, syncCfg, { page, per_page: perPage })
        );
        const pageData = pageRes.data.result || pageRes.data;
        const records: any[] = pageData.data || pageData.records || pageData.list || [];
        if (records.length === 0) continue;

        const transformed = applyTransform(records, importSettings);
        const result = await upsertRecords(pool, syncCfg.target_table, syncCfg.target_pk, transformed, importSettings);
        totalSuccess += result.success;
        totalErrors += result.error;
        allErrors.push(...result.errors);
      } catch (e: any) {
        totalErrors += 1;
        if (allErrors.length < 5) allErrors.push('第 ' + page + ' 页请求失败: ' + (e.message || String(e)));
      }
    }

    await pool.end();

    const msg = '导入完成: ' + totalSuccess + ' 成功, ' + totalErrors + ' 失败';
    return {
      success: true,
      message: allErrors.length > 0 ? msg + '\n\n错误详情:\n' + allErrors.join('\n') : msg,
      stats: { total: totalSuccess + totalErrors, success: totalSuccess, error: totalErrors },
      errors: allErrors,
    };
  } catch (err: any) {
    return { success: false, message: err.message || String(err) };
  }
}

// ========== 辅助函数 ==========

function parseSettings(raw: string): ImportSetting[] {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

/** 构建带条件的 API 请求体 */
function buildSyncRequestBody(token: string, syncCfg: any, extra?: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    access_token: token,
  };
  if (extra?.page) body.page = extra.page;
  else if (syncCfg.page) body.page = syncCfg.page;
  else body.page = 1;

  if (extra?.per_page) body.per_page = extra.per_page;
  else if (syncCfg.per_page) body.per_page = syncCfg.per_page;
  else body.per_page = 10;

  if (syncCfg.order_field) {
    body.order = { [syncCfg.order_field]: syncCfg.order_dir || 'asc' };
  }

  // 解析条件并添加到请求体
  let conditions: any[] = [];
  try { conditions = JSON.parse(syncCfg.conditions || '[]'); } catch {}
  if (conditions.length === 0) return body;

  function condToExpr(c: any): Record<string, unknown> {
    switch (c.operator) {
      case 'eq': return { [c.field]: c.value };
      case 'like': return { [c.field]: '%%' + (c.value || '').replace(/%%/g, '') + '%%' };
      case 'gt': return { [c.field]: { gt: c.value } };
      case 'gte': return { [c.field]: { gte: c.value } };
      case 'lt': return { [c.field]: { lt: c.value } };
      case 'lte': return { [c.field]: { lte: c.value } };
      case 'between': {
        const parts = (c.value || '').split(',').map((s: string) => s.trim());
        return parts.length >= 2 ? { [c.field]: { gte: parts[0], lte: parts[1] } } : { [c.field]: c.value };
      }
      case 'in': return { [c.field]: { in: (c.value || '').split(',').map((s: string) => s.trim()) } };
      case 'neq': return { [c.field]: { neq: c.value } };
      default: return { [c.field]: c.value };
    }
  }

  const exprs = conditions.map(condToExpr);
  if (exprs.length === 1) {
    Object.assign(body, exprs[0]);
    return body;
  }
  if ((syncCfg.logic || 'and') === 'and' && conditions.every((c: any) => c.operator === 'eq')) {
    for (const c of conditions) { body[c.field] = c.value; }
    return body;
  }
  body[syncCfg.logic || 'and'] = exprs;
  return body;
}

function applyTransform(records: any[], importSettings: ImportSetting[]): any[] {
  return records.map(record => {
    const result: Record<string, any> = {};
    for (const s of importSettings) {
      const val = record[s.srcField];
      if (s.transformer) {
        result[s.distField] = transformerFunc(val, s.transformer, s.type);
      } else {
        result[s.distField] = val === null || val === undefined ? null : val;
      }
    }
    return result;
  });
}

function transformerFunc(val: any, t: { methods: string; value?: string; mapping?: Record<string, string>; customCode?: string }, type: string): any {
  switch (t.methods) {
    case 'static': return t.value ?? val;
    case 'mapping': return t.mapping?.[String(val)] ?? val;
    case 'custom':
      if (!t.customCode) return val;
      try {
        const fn = new Function('val', 'type', t.customCode);
        return fn(val, type);
      } catch { return val; }
    case 'upper': return typeof val === 'string' ? val.toUpperCase() : val;
    case 'lower': return typeof val === 'string' ? val.toLowerCase() : val;
    case 'trim': return typeof val === 'string' ? val.trim() : val;
    default: return val;
  }
}

async function upsertRecords(
  pool: Pool, tableName: string, pk: string,
  records: any[], importSettings: ImportSetting[]
): Promise<{ success: number; error: number; errors: string[]; failedRecords: { data: Record<string, any>; reason: string }[] }> {
  const colNames = importSettings.map(s => s.distField);
  const pkFields = importSettings.filter(s => s.isPk).map(s => s.distField);
  const pkClause = pkFields.length > 0 ? pkFields.map(f => '"' + f + '"').join(',') : '"' + (pk || colNames[0]) + '"';
  let success = 0, error = 0;
  const errors: string[] = [];
  const failedRecords: { data: Record<string, any>; reason: string }[] = [];

  for (const record of records) {
    try {
      const values: any[] = [];
      const updateParts: string[] = [];
      const placeholders: string[] = [];

      for (let i = 0; i < importSettings.length; i++) {
        const s = importSettings[i];
        const val = record[s.distField];
        values.push(val === undefined ? null : val);
        placeholders.push('$' + (i + 1));
        if (s.distField !== pk) {
          updateParts.push('"' + s.distField + '" = EXCLUDED."' + s.distField + '"');
        }
      }

      const sql = 'INSERT INTO "' + tableName + '" (' +
        colNames.map(c => '"' + c + '"').join(',') + ') VALUES (' +
        placeholders.join(',') + ') ON CONFLICT (' + pkClause + ') DO UPDATE SET ' +
        updateParts.join(',');
      await pool.query(sql, values);
      success++;
    } catch (e: any) {
      error++;
      const errMsg = e.message || String(e);
      // 记录每条失败数据
      const failedItem: Record<string, any> = {};
      for (const s of importSettings) {
        failedItem[s.distField] = record[s.distField];
      }
      // 只保留前 200 条失败记录，避免内存过大
      if (failedRecords.length < 200) {
        failedRecords.push({ data: failedItem, reason: errMsg });
      }
      // 只记录前 5 条错误摘要
      if (errors.length < 5) {
        errors.push('第 ' + (success + error) + ' 条: ' + errMsg);
      }
    }
  }

  if (errors.length > 0) {
    errors.push('SQL 模板: INSERT INTO "' + tableName + '" (' +
      colNames.map(c => '"' + c + '"').join(',') + ') VALUES (...) ON CONFLICT (' + pkClause + ') DO UPDATE SET ' +
      importSettings.filter(s => s.distField !== pk && !pkFields.includes(s.distField)).map(s => '"' + s.distField + '" = EXCLUDED."' + s.distField + '"').join(','));
  }

  return { success, error, errors, failedRecords };
}

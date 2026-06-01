import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 120000 });

export interface TokenConfig {
  key: string;
  secret: string;
  token_url: string;
  access_token?: string;
}

export interface QueryCondition {
  field: string;
  operator: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'neq';
  value: string;
}

export interface QueryParams {
  conditions: QueryCondition[];
  logic: 'and' | 'or';
  page: number;
  perPage: number;
  orderField: string;
  orderDir: 'asc' | 'desc';
}

export interface FetchResult {
  success: boolean;
  data?: {
    records: any[];
    total: number;
    page: number;
    perPage: number;
    dataStruct?: Record<string, string>;
    rawResponse?: any;
  };
  message: string;
  meta?: { duration: number; recordCount: number };
}

export interface PgDatasource {
  id: number;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  schema: string;
  created_at: string;
  updated_at: string;
}

// ========== Token ==========

export async function getTokenConfig() {
  const res = await api.get('/config/token');
  return res.data;
}

export async function saveTokenConfig(config: { key: string; secret: string; token_url: string }) {
  const res = await api.post('/config/token', config);
  return res.data;
}

export async function fetchAccessToken() {
  const res = await api.post('/token/fetch');
  return res.data;
}

// ========== Data API ==========

export async function getDataApiConfig() {
  const res = await api.get('/config/data-api');
  return res.data;
}

export async function saveDataApiConfig(data_api_url: string) {
  const res = await api.post('/config/data-api', { data_api_url });
  return res.data;
}

export async function fetchRemoteData(query?: QueryParams, apiUrl?: string): Promise<FetchResult> {
  const res = await api.post('/data/fetch', { query, apiUrl });
  return res.data;
}

// ========== 远程数据表配置 ==========

export interface RemoteTable {
  id: number;
  name: string;
  data_api_url: string;
  conditions: string;
  logic: string;
  page: number;
  per_page: number;
  order_field: string;
  order_dir: string;
  created_at: string;
  updated_at: string;
}

export async function listRemoteTables(): Promise<{ success: boolean; data: RemoteTable[] }> {
  const res = await api.get('/config/remote-tables');
  return res.data;
}

export async function getRemoteTableFields(id: number): Promise<{ success: boolean; data: { name: string; description: string }[] }> {
  const res = await api.get('/config/remote-tables/' + id + '/fields');
  return res.data;
}

export async function getRemoteTable(id: number) {
  const res = await api.get('/config/remote-tables/' + id);
  return res.data;
}

export async function createRemoteTable(t: {
  name: string; data_api_url: string; conditions?: string; logic?: string;
  page?: number; per_page?: number; order_field?: string; order_dir?: string;
}) {
  const res = await api.post('/config/remote-tables', t);
  return res.data;
}

export async function updateRemoteTable(id: number, t: {
  name: string; data_api_url: string; conditions?: string; logic?: string;
  page?: number; per_page?: number; order_field?: string; order_dir?: string;
}) {
  const res = await api.put('/config/remote-tables/' + id, t);
  return res.data;
}

export async function deleteRemoteTable(id: number) {
  const res = await api.delete('/config/remote-tables/' + id);
  return res.data;
}

// ========== 导入配置 ==========

export interface SyncConfig {
  id: number;
  name: string;
  remote_table_id: number;
  pg_source_id: number;
  target_table: string;
  target_pk: string;
  import_settings: string;
  page: number;
  per_page: number;
  all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;  created_at: string;
  updated_at: string;
}

export async function listSyncConfigs(): Promise<{ success: boolean; data: SyncConfig[] }> {
  const res = await api.get('/sync-configs');
  return res.data;
}

export async function getSyncConfig(id: number) {
  const res = await api.get('/sync-configs/' + id);
  return res.data;
}

export async function createSyncConfig(cfg: {
  name: string; remote_table_id: number; pg_source_id: number; target_table: string;
  target_pk: string; import_settings: string; page: number; per_page: number; all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;}) {
  const res = await api.post('/sync-configs', cfg);
  return res.data;
}

export async function updateSyncConfig(id: number, cfg: {
  name: string; remote_table_id: number; pg_source_id: number; target_table: string;
  target_pk: string; import_settings: string; page: number; per_page: number; all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;}) {
  const res = await api.put('/sync-configs/' + id, cfg);
  return res.data;
}

export async function deleteSyncConfig(id: number) {
  const res = await api.delete('/sync-configs/' + id);
  return res.data;
}

export async function previewSyncData(id: number) {
  const res = await api.post('/sync-configs/' + id + '/preview');
  return res.data;
}

export async function importSyncData(id: number) {
  const res = await api.post('/sync-configs/' + id + '/import');
  return res.data;
}

export function importSyncDataStream(id: number, onEvent: (event: string, data: any) => void): () => void {
  const es = new EventSource(`/api/sync-configs/${id}/import-stream`);
  es.addEventListener("start", (e) => onEvent("start", JSON.parse(e.data)));
  es.addEventListener("progress", (e) => onEvent("progress", JSON.parse(e.data)));
  es.addEventListener("done", (e) => { onEvent("done", JSON.parse(e.data)); es.close(); });
  es.addEventListener("error", (e) => { onEvent("error", (e as any).data ? JSON.parse((e as any).data) : { message: "连接失败" }); es.close(); });
  es.addEventListener("cancelled", (e) => { onEvent("cancelled", JSON.parse(e.data)); es.close(); });
  return () => es.close();
}

// PG 表/列工具
export async function listPgTablesInSource(src: {
  host: string; port: string; user: string; password: string; database: string;
}) {
  const res = await api.post('/pg/tables', src);
  return res.data;
}

export async function listPgColumnsInSource(src: {
  host: string; port: string; user: string; password: string; database: string; table: string;
}) {
  const res = await api.post('/pg/columns', src);
  return res.data;
}

// ========== PG 多数据源 ==========

export async function listPgSources(): Promise<{ success: boolean; data: PgDatasource[] }> {
  const res = await api.get('/config/pg-sources');
  return res.data;
}

export async function createPgSource(ds: {
  name: string; host: string; port: string; user: string; password: string; database: string; schema: string;
}) {
  const res = await api.post('/config/pg-sources', ds);
  return res.data;
}

export async function updatePgSource(id: number, ds: {
  name: string; host: string; port: string; user: string; password: string; database: string; schema: string;
}) {
  const res = await api.put('/config/pg-sources/' + id, ds);
  return res.data;
}

export async function deletePgSource(id: number) {
  const res = await api.delete('/config/pg-sources/' + id);
  return res.data;
}

export async function testPgSourceConnection(ds: {
  host: string; port: string; user: string; password: string; database: string;
}) {
  const res = await api.post('/config/pg-sources/test', ds);
  return res.data;
}
export async function importCancelStream(id: number) {
  const res = await api.post('/sync-configs/' + id + '/import-cancel');
  return res.data;
}

// ========== 定时任务管理 ==========

export interface SyncTask {
  id: number;
  name: string;
  sync_config_id: number;
  sync_config_ids: string;
  type: string;           // interval / once / daily / weekly
  interval_value: number;
  interval_unit: string;  // minutes / hours / days
  cron_expr: string;
  scheduled_time: string; // HH:mm
  scheduled_days: string; // 1,2,3,4,5,6,7
  enabled: number;
  last_run_at: string;
  next_run_at: string;
  created_at: string;
  updated_at: string;
  task_type: string;      // sync / backup
  backup_config_id: number;
  backup_dir: string;
  keep_days: number;
}

export async function listSyncTasks(): Promise<{ success: boolean; data: SyncTask[] }> {
  const res = await api.get('/sync-tasks');
  return res.data;
}

export async function getSyncTask(id: number) {
  const res = await api.get('/sync-tasks/' + id);
  return res.data;
}

export async function createSyncTask(task: {
  name: string; sync_config_id: number; sync_config_ids?: string; type: string;
  interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string; enabled: number;
  task_type?: string; backup_config_id?: number; backup_dir?: string; keep_days?: number;
}) {
  const res = await api.post('/sync-tasks', task);
  return res.data;
}

export async function updateSyncTask(id: number, task: {
  name: string; sync_config_id: number; sync_config_ids?: string; type: string;
  interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string; enabled: number;
  task_type?: string; backup_config_id?: number; backup_dir?: string; keep_days?: number;
}) {
  const res = await api.put('/sync-tasks/' + id, task);
  return res.data;
}

export async function deleteSyncTask(id: number) {
  const res = await api.delete('/sync-tasks/' + id);
  return res.data;
}

export async function runSyncTask(id: number) {
  const res = await api.post('/sync-tasks/' + id + '/run');
  return res.data;
}


export interface TaskExecutionLog {
  id: number;
  task_id: number;
  task_name: string;
  sync_config_id: number;
  sync_config_name: string;
  target_table: string;
  task_type: string;
  status: string;
  total_records: number;
  success_count: number;
  error_count: number;
  log_filename: string;
  error_message: string;
  backup_file: string;
  file_size?: number;
  started_at: string;
  finished_at: string;
  created_at: string;
}

export async function listTaskExecutions(taskId: number): Promise<{ success: boolean; data: TaskExecutionLog[] }> {
  const res = await api.get('/sync-tasks/' + taskId + '/executions');
  return res.data;
}

// ========== 配置导入/导出 ==========

export async function exportConfig(categories: string[] = []): Promise<{ success: boolean; data: Record<string, any>; message: string }> {
  const res = await api.post('/config/export', { categories });
  return res.data;
}

export async function importConfig(data: Record<string, any>, categories: string[] = []): Promise<{ success: boolean; data?: { imported: string[]; errors: string[] }; message: string }> {
  const res = await api.post('/config/import', { data, categories });
  return res.data;
}

export async function clearConfig(categories: string[] = []): Promise<{ success: boolean; message: string }> {
  const res = await api.post('/config/clear', { categories });
  return res.data;
}

// ========== 备份配置管理 ==========

export interface BackupConfig {
  id: number;
  name: string;
  pg_source_id: number;
  database_name: string;
  backup_dir: string;
  keep_days: number;
  backup_format: string;
  enabled: number;
  type: string;
  interval_value: number;
  interval_unit: string;
  scheduled_time: string;
  next_run_at: string;
  last_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface BackupLog {
  id: number; config_id: number; config_name: string; database_name: string;
  backup_file: string; file_size: number; status: string; error_message: string;
  started_at: string; finished_at: string; created_at: string;
}

export async function listBackupConfigs(): Promise<{ success: boolean; data: BackupConfig[] }> {
  const res = await api.get('/backup-configs');
  return res.data;
}

export async function createBackupConfig(cfg: any) {
  const res = await api.post('/backup-configs', cfg);
  return res.data;
}

export async function updateBackupConfig(id: number, cfg: any) {
  const res = await api.put('/backup-configs/' + id, cfg);
  return res.data;
}

export async function deleteBackupConfig(id: number) {
  const res = await api.delete('/backup-configs/' + id);
  return res.data;
}

export async function listBackupConfigsNames(): Promise<{ success: boolean; data: { id: number; name: string }[] }> {
  const res = await api.get('/config/backup-configs-names');
  return res.data;
}

export async function runBackupNow(id: number) {
  const res = await api.post('/backup-configs/' + id + '/run');
  return res.data;
}

export async function getBackupProgress(id: number): Promise<{ success: boolean; data: any }> {
  const res = await api.get('/backup-configs/' + id + '/progress');
  return res.data;
}

export async function stopBackup(id: number): Promise<{ success: boolean; message: string }> {
  const res = await api.post('/backup-configs/' + id + '/stop');
  return res.data;
}

export async function checkPgDump(): Promise<{ success: boolean; data: { installed: boolean; pgDump: boolean; pgRestore: boolean; path: string; version: string; compatible: boolean } }> {
  const res = await api.get('/backup/check-pgdump');
  return res.data;
}

export async function getInstallProgress(): Promise<{ status: string; message: string; stage: string }> {
  const res = await api.get('/backup/install-progress');
  return res.data;
}

export async function installPgTools(): Promise<{ success: boolean; message: string }> {
  const res = await api.post('/backup/install-pgtools');
  return res.data;
}

export async function listBackupLogs(configId: number): Promise<{ success: boolean; data: BackupLog[] }> {
  const res = await api.get('/backup-configs/' + configId + '/logs');
  return res.data;
}

export async function deleteBackupLogs(ids: number[]): Promise<{ success: boolean; message: string }> {
  const res = await api.delete('/backup-logs', { data: { ids } });
  return res.data;
}

export async function deleteTaskExecutionLogs(ids: number[]): Promise<{ success: boolean; message: string }> {
  const res = await api.post('/task-logs/delete', { ids });
  return res.data;
}

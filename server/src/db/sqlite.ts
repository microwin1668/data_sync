import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'config.db');

let db: SqlJsDatabase;

export async function initDb(): Promise<SqlJsDatabase> {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 旧表迁移
  tryMigrateTable('configs', [
    { name: 'auth_password', def: "TEXT DEFAULT ''" },
    { name: 'pg_host', def: "TEXT DEFAULT ''" },
    { name: 'pg_port', def: "TEXT DEFAULT '5432'" },
    { name: 'pg_user', def: "TEXT DEFAULT ''" },
    { name: 'pg_password', def: "TEXT DEFAULT ''" },
    { name: 'pg_database', def: "TEXT DEFAULT ''" },
    { name: 'pg_schema', def: "TEXT DEFAULT 'public'" },
  ]);

  db.run(
    "CREATE TABLE IF NOT EXISTS configs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "key TEXT DEFAULT ''," +
    "secret TEXT DEFAULT ''," +
    "token_url TEXT DEFAULT ''," +
    "access_token TEXT DEFAULT ''," +
    "data_api_url TEXT DEFAULT ''," +
    "table_name TEXT DEFAULT ''," +
    "pg_host TEXT DEFAULT ''," +
    "pg_port TEXT DEFAULT '5432'," +
    "pg_user TEXT DEFAULT ''," +
    "pg_password TEXT DEFAULT ''," +
    "pg_database TEXT DEFAULT ''," +
    "pg_schema TEXT DEFAULT 'public'," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // remote_tables 表
  db.run(
    "CREATE TABLE IF NOT EXISTS remote_tables (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "data_api_url TEXT NOT NULL DEFAULT ''," +
    "conditions TEXT DEFAULT '[]'," +
    "logic TEXT DEFAULT 'and'," +
    "page INTEGER DEFAULT 1," +
    "per_page INTEGER DEFAULT 20," +
    "order_field TEXT DEFAULT ''," +
    "order_dir TEXT DEFAULT 'asc'," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // sync_configs 表（导入配置）
  db.run(
    "CREATE TABLE IF NOT EXISTS sync_configs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "remote_table_id INTEGER DEFAULT 0," +
    "pg_source_id INTEGER DEFAULT 0," +
    "target_table TEXT DEFAULT ''," +
    "target_pk TEXT DEFAULT ''," +
    "import_settings TEXT DEFAULT '[]'," +
    "page INTEGER DEFAULT 1," +
    "per_page INTEGER DEFAULT 200," +
    "all_import INTEGER DEFAULT 0," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // 迁移：sync_configs 新增条件等字段
  tryMigrateTable("sync_configs", [
    { name: "conditions", def: "TEXT DEFAULT '[]'" },
    { name: "logic", def: "TEXT DEFAULT 'and'" },
    { name: "order_field", def: "TEXT DEFAULT ''" },
    { name: "order_dir", def: "TEXT DEFAULT 'asc'" },
  ]);

  // pg_datasources 表
  db.run(
    "CREATE TABLE IF NOT EXISTS pg_datasources (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "host TEXT NOT NULL DEFAULT ''," +
    "port TEXT NOT NULL DEFAULT '5432'," +
    "user TEXT NOT NULL DEFAULT ''," +
    "password TEXT DEFAULT ''," +
    "database TEXT NOT NULL DEFAULT ''," +
    "schema TEXT DEFAULT 'public'," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // sync_tasks 表（定时任务）
  db.run(
    "CREATE TABLE IF NOT EXISTS sync_tasks (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "sync_config_id INTEGER DEFAULT 0," +
    "sync_config_ids TEXT DEFAULT '[]'," +       // 多选同步配置 IDs JSON 数组
    "type TEXT NOT NULL DEFAULT 'interval'," +  // interval / once / daily / weekly
    "interval_value INTEGER DEFAULT 0," +
    "interval_unit TEXT DEFAULT 'minutes'," +   // minutes / hours / days
    "cron_expr TEXT DEFAULT ''," +               // cron 表达式（可选）
    "scheduled_time TEXT DEFAULT ''," +          // 指定的时间 HH:mm
    "scheduled_days TEXT DEFAULT ''," +           // 指定的星期几（逗号分隔）
    "enabled INTEGER DEFAULT 1," +
    "last_run_at TEXT DEFAULT ''," +
    "next_run_at TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );
  // task_execution_logs 迁移: 添加 task_type
  tryMigrateTable("task_execution_logs", [
    { name: "task_type", def: "TEXT DEFAULT 'sync'" },
    { name: "backup_file", def: "TEXT DEFAULT ''" },
    { name: "file_size", def: "INTEGER DEFAULT 0" },
  ]);

  tryMigrateTable("sync_tasks", [
    { name: "sync_config_ids", def: "TEXT DEFAULT '[]'" },
    { name: "task_type", def: "TEXT DEFAULT 'sync'" },
    { name: "backup_config_id", def: "INTEGER DEFAULT 0" },
    { name: "backup_dir", def: "TEXT DEFAULT ''" },
    { name: "keep_days", def: "INTEGER DEFAULT 7" },
  ]);

  // task_execution_logs 表
  db.run(
    "CREATE TABLE IF NOT EXISTS task_execution_logs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "task_id INTEGER DEFAULT 0," +
    "task_name TEXT DEFAULT ''," +
    "sync_config_id INTEGER DEFAULT 0," +
    "sync_config_name TEXT DEFAULT ''," +
    "target_table TEXT DEFAULT ''," +
    "task_type TEXT DEFAULT 'sync'," +
    "status TEXT DEFAULT 'pending'," +
    "total_records INTEGER DEFAULT 0," +
    "success_count INTEGER DEFAULT 0," +
    "error_count INTEGER DEFAULT 0," +
    "log_filename TEXT DEFAULT ''," +
    "error_message TEXT DEFAULT ''," +
    "backup_file TEXT DEFAULT ''," +
    "file_size INTEGER DEFAULT 0," +
    "started_at TEXT DEFAULT ''," +
    "finished_at TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // backup_configs 表
  db.run(
    "CREATE TABLE IF NOT EXISTS backup_configs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "pg_source_id INTEGER DEFAULT 0," +
    "database_name TEXT DEFAULT ''," +
    "backup_dir TEXT DEFAULT ''," +
    "keep_days INTEGER DEFAULT 7," +
    "backup_format TEXT DEFAULT 'sql'," +
    "enabled INTEGER DEFAULT 1," +
    "type TEXT DEFAULT 'interval'," +
    "interval_value INTEGER DEFAULT 0," +
    "interval_unit TEXT DEFAULT 'hours'," +
    "scheduled_time TEXT DEFAULT ''," +
    "next_run_at TEXT DEFAULT ''," +
    "last_run_at TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );
  tryMigrateTable("backup_configs", [
    { name: "backup_format", def: "TEXT DEFAULT 'sql'" },
  ]);

  // backup_logs 表
  db.run(
    "CREATE TABLE IF NOT EXISTS backup_logs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "config_id INTEGER DEFAULT 0," +
    "config_name TEXT DEFAULT ''," +
    "database_name TEXT DEFAULT ''," +
    "backup_file TEXT DEFAULT ''," +
    "file_size INTEGER DEFAULT 0," +
    "status TEXT DEFAULT 'pending'," +
    "error_message TEXT DEFAULT ''," +
    "started_at TEXT DEFAULT ''," +
    "finished_at TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // 确保 configs 有一行
  const result = db.exec('SELECT COUNT(*) as cnt FROM configs');
  const count = Number(result[0]?.values[0]?.[0]) || 0;
  if (count === 0) {
    db.run('INSERT INTO configs (key, secret, token_url) VALUES (?, ?, ?)', ['', '', '']);
  }

  saveDb();
  return db;
}

function tryMigrateTable(table: string, columns: { name: string; def: string }[]) {
  try {
    const exists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='" + table + "'");
    if (exists.length === 0) return;
    const info = db.exec('PRAGMA table_info(' + table + ')');
    if (!info[0]) return;
    const existingCols = info[0].values.map((r: any) => String(r[1]));
    for (const col of columns) {
      if (!existingCols.includes(col.name)) {
        db.run('ALTER TABLE ' + table + ' ADD COLUMN ' + col.name + ' ' + col.def);
      }
    }
  } catch {}
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ========== Configs (token / data-api) ==========

export interface ConfigRow {
  id: number;
  key: string;
  secret: string;
  token_url: string;
  access_token: string;
  data_api_url: string;
  table_name: string;
  pg_host: string;
  pg_port: string;
  pg_user: string;
  pg_password: string;
  pg_database: string;
  pg_schema: string;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: any[], columns: string[]): ConfigRow {
  const map: Record<string, number> = {};
  columns.forEach((name, i) => { map[name.toLowerCase()] = i; });
  const get = (name: string): any => {
    const idx = map[name];
    return idx !== undefined ? row[idx] : '';
  };
  return {
    id: Number(get('id')) || 0,
    key: String(get('key')),
    secret: String(get('secret')),
    token_url: String(get('token_url')),
    access_token: String(get('access_token')),
    data_api_url: String(get('data_api_url')),
    table_name: String(get('table_name')),
    pg_host: String(get('pg_host')),
    pg_port: String(get('pg_port')),
    pg_user: String(get('pg_user')),
    pg_password: String(get('pg_password')),
    pg_database: String(get('pg_database')),
    pg_schema: String(get('pg_schema')),
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
  };
}

export async function upsertTokenConfig(key: string, secret: string, tokenUrl: string) {
  await initDb();
  const result = db.exec('SELECT id FROM configs LIMIT 1');
  if (result[0]?.values.length) {
    const id = result[0].values[0][0];
    db.run("UPDATE configs SET key=?, secret=?, token_url=?, updated_at=datetime('now','localtime') WHERE id=?", [key, secret, tokenUrl, id]);
  } else {
    db.run('INSERT INTO configs (key, secret, token_url) VALUES (?, ?, ?)', [key, secret, tokenUrl]);
  }
  saveDb();
}

export async function updateAccessToken(token: string) {
  await initDb();
  const result = db.exec('SELECT id FROM configs LIMIT 1');
  if (result[0]?.values.length) {
    const id = result[0].values[0][0];
    db.run("UPDATE configs SET access_token=?, updated_at=datetime('now','localtime') WHERE id=?", [token, id]);
  }
  saveDb();
}

export async function upsertDataApiUrl(url: string) {
  await initDb();
  const result = db.exec('SELECT id FROM configs LIMIT 1');
  if (result[0]?.values.length) {
    const id = result[0].values[0][0];
    db.run("UPDATE configs SET data_api_url=?, updated_at=datetime('now','localtime') WHERE id=?", [url, id]);
  }
  saveDb();
}

export async function getConfig(): Promise<ConfigRow | undefined> {
  await initDb();
  const result = db.exec('SELECT * FROM configs LIMIT 1');
  if (result[0]?.values.length) {
    return rowToConfig(result[0].values[0], result[0].columns);
  }
  return undefined;
}

// ========== PG Datasources ==========

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

export async function listPgDatasources(): Promise<PgDatasource[]> {
  await initDb();
  const result = db.exec('SELECT * FROM pg_datasources ORDER BY id ASC');
  if (!result[0]) return [];
  const cols = result[0].columns;
  return result[0].values.map((row: any[]) => {
    const map: Record<string, number> = {};
    cols.forEach((name, i) => { map[name.toLowerCase()] = i; });
    const get = (name: string): any => {
      const idx = map[name];
      return idx !== undefined ? row[idx] : '';
    };
    return {
      id: Number(get('id')) || 0,
      name: String(get('name')),
      host: String(get('host')),
      port: String(get('port')),
      user: String(get('user')),
      password: String(get('password')),
      database: String(get('database')),
      schema: String(get('schema')),
      created_at: String(get('created_at')),
      updated_at: String(get('updated_at')),
    };
  });
}

export async function createPgDatasource(ds: {
  name: string; host: string; port: string; user: string; password: string; database: string; schema: string;
}): Promise<number> {
  await initDb();
  db.run(
    'INSERT INTO pg_datasources (name, host, port, user, password, database, schema) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ds.name, ds.host, ds.port, ds.user, ds.password, ds.database, ds.schema || 'public']
  );
  saveDb();
  const r = db.exec('SELECT MAX(id) as id FROM pg_datasources');
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

export async function updatePgDatasource(id: number, ds: {
  name: string; host: string; port: string; user: string; password: string; database: string; schema: string;
}) {
  await initDb();
  db.run(
    "UPDATE pg_datasources SET name=?, host=?, port=?, user=?, password=?, database=?, schema=?, updated_at=datetime('now','localtime') WHERE id=?",
    [ds.name, ds.host, ds.port, ds.user, ds.password, ds.database, ds.schema || 'public', id]
  );
  saveDb();
}

// ========== Remote Tables ==========

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

function rowToRemoteTable(row: any[], columns: string[]): RemoteTable {
  const map: Record<string, number> = {};
  columns.forEach((n, i) => { map[n.toLowerCase()] = i; });
  const get = (name: string): any => {
    const idx = map[name];
    return idx !== undefined ? row[idx] : '';
  };
  return {
    id: Number(get('id')) || 0,
    name: String(get('name')),
    data_api_url: String(get('data_api_url')),
    conditions: String(get('conditions')),
    logic: String(get('logic')),
    page: Number(get('page')) || 1,
    per_page: Number(get('per_page')) || 20,
    order_field: String(get('order_field')),
    order_dir: String(get('order_dir')) || 'asc',
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
  };
}

export async function listRemoteTables(): Promise<RemoteTable[]> {
  await initDb();
  const result = db.exec('SELECT * FROM remote_tables ORDER BY id ASC');
  if (!result[0]) return [];
  return result[0].values.map((row: any[]) => rowToRemoteTable(row, result[0].columns));
}

export async function getRemoteTable(id: number): Promise<RemoteTable | undefined> {
  await initDb();
  const result = db.exec('SELECT * FROM remote_tables WHERE id=?', [id]);
  if (result[0]?.values.length) return rowToRemoteTable(result[0].values[0], result[0].columns);
  return undefined;
}

export async function createRemoteTable(t: {
  name: string; data_api_url: string; conditions: string; logic: string;
  page: number; per_page: number; order_field: string; order_dir: string;
}): Promise<number> {
  await initDb();
  db.run(
    'INSERT INTO remote_tables (name, data_api_url, conditions, logic, page, per_page, order_field, order_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [t.name, t.data_api_url, t.conditions, t.logic, t.page, t.per_page, t.order_field, t.order_dir]
  );
  saveDb();
  const r = db.exec('SELECT MAX(id) as id FROM remote_tables');
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

export async function updateRemoteTable(id: number, t: {
  name: string; data_api_url: string; conditions: string; logic: string;
  page: number; per_page: number; order_field: string; order_dir: string;
}) {
  await initDb();
  db.run(
    "UPDATE remote_tables SET name=?, data_api_url=?, conditions=?, logic=?, page=?, per_page=?, order_field=?, order_dir=?, updated_at=datetime('now','localtime') WHERE id=?",
    [t.name, t.data_api_url, t.conditions, t.logic, t.page, t.per_page, t.order_field, t.order_dir, id]
  );
  saveDb();
}

// ========== Sync Configs ==========

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

function rowToSyncConfig(row: any[], columns: string[]): SyncConfig {
  const map: Record<string, number> = {};
  columns.forEach((n, i) => { map[n.toLowerCase()] = i; });
  const get = (name: string): any => {
    const idx = map[name];
    return idx !== undefined ? row[idx] : '';
  };
  return {
    id: Number(get('id')) || 0,
    name: String(get('name')),
    remote_table_id: Number(get('remote_table_id')) || 0,
    pg_source_id: Number(get('pg_source_id')) || 0,
    target_table: String(get('target_table')),
    target_pk: String(get('target_pk')),
    import_settings: String(get('import_settings')),
    conditions: String(get("conditions")) || "[]",
    logic: String(get("logic")) || "and",
    order_field: String(get("order_field")) || "",
    order_dir: String(get("order_dir")) || "asc",    page: Number(get('page')) || 1,
    per_page: Number(get('per_page')) || 200,
    all_import: Number(get('all_import')) || 0,
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
  };
}

export async function listSyncConfigs(): Promise<SyncConfig[]> {
  await initDb();
  const result = db.exec('SELECT * FROM sync_configs ORDER BY id ASC');
  if (!result[0]) return [];
  return result[0].values.map((row: any[]) => rowToSyncConfig(row, result[0].columns));
}

export async function getSyncConfig(id: number): Promise<SyncConfig | undefined> {
  await initDb();
  const result = db.exec('SELECT * FROM sync_configs WHERE id=?', [id]);
  if (result[0]?.values.length) return rowToSyncConfig(result[0].values[0], result[0].columns);
  return undefined;
}

export async function createSyncConfig(cfg: {
  name: string; remote_table_id: number; pg_source_id: number; target_table: string;
  target_pk: string; import_settings: string; page: number; per_page: number; all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;}): Promise<number> {
  await initDb();
  db.run(
    'INSERT INTO sync_configs (name, remote_table_id, pg_source_id, target_table, target_pk, import_settings, page, per_page, all_import, conditions, logic, order_field, order_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [cfg.name, cfg.remote_table_id, cfg.pg_source_id, cfg.target_table, cfg.target_pk, cfg.import_settings, cfg.page, cfg.per_page, cfg.all_import, cfg.conditions, cfg.logic, cfg.order_field, cfg.order_dir]
  );
  saveDb();
  const r = db.exec('SELECT MAX(id) as id FROM sync_configs');
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

export async function updateSyncConfig(id: number, cfg: {
  name: string; remote_table_id: number; pg_source_id: number; target_table: string;
  target_pk: string; import_settings: string; page: number; per_page: number; all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;}) {
  await initDb();
  db.run(
    "UPDATE sync_configs SET name=?, remote_table_id=?, pg_source_id=?, target_table=?, target_pk=?, import_settings=?, page=?, per_page=?, all_import=?, conditions=?, logic=?, order_field=?, order_dir=?, updated_at=datetime('now','localtime') WHERE id=?",
    [cfg.name, cfg.remote_table_id, cfg.pg_source_id, cfg.target_table, cfg.target_pk, cfg.import_settings, cfg.page, cfg.per_page, cfg.all_import, cfg.conditions, cfg.logic, cfg.order_field, cfg.order_dir, id]
  );
  saveDb();
}

export async function deleteSyncConfig(id: number) {
  await initDb();
  db.run('DELETE FROM sync_configs WHERE id=?', [id]);
  saveDb();
}

export async function deleteRemoteTable(id: number) {
  await initDb();
  db.run('DELETE FROM remote_tables WHERE id=?', [id]);
  saveDb();
}

export async function deletePgDatasource(id: number) {
  await initDb();
  db.run('DELETE FROM pg_datasources WHERE id=?', [id]);
  saveDb();
}

// ========== 定时任务 CRUD ==========

export interface SyncTask {
  id: number;
  name: string;
  sync_config_id: number;
  sync_config_ids: string;
  type: string;
  interval_value: number;
  interval_unit: string;
  cron_expr: string;
  scheduled_time: string;
  scheduled_days: string;
  enabled: number;
  last_run_at: string;
  next_run_at: string;
  created_at: string;
  updated_at: string;
  task_type: string;
  backup_config_id: number;
  backup_dir: string;
  keep_days: number;
}

function rowToSyncTask(row: any[], columns: string[]): SyncTask {
  const map: Record<string, number> = {};
  columns.forEach((n, i) => { map[n.toLowerCase()] = i; });
  const get = (name: string): any => {
    const idx = map[name];
    return idx !== undefined ? row[idx] : '';
  };
  return {
    id: Number(get('id')) || 0,
    name: String(get('name')),
    sync_config_id: Number(get('sync_config_id')) || 0,
    sync_config_ids: String(get('sync_config_ids')) || '[]',
    type: String(get('type')) || 'interval',
    interval_value: Number(get('interval_value')) || 0,
    interval_unit: String(get('interval_unit')) || 'minutes',
    cron_expr: String(get('cron_expr')) || '',
    scheduled_time: String(get('scheduled_time')) || '',
    scheduled_days: String(get('scheduled_days')) || '',
    enabled: get('enabled') !== '' && get('enabled') !== null && get('enabled') !== undefined ? Number(get('enabled')) : 1,
    last_run_at: String(get('last_run_at')) || '',
    next_run_at: String(get('next_run_at')) || '',
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
    task_type: String(get('task_type')) || 'sync',
    backup_config_id: Number(get('backup_config_id')) || 0,
    backup_dir: String(get('backup_dir')) || '',
    keep_days: Number(get('keep_days')) || 7,
  };
}

export async function listSyncTasks(): Promise<SyncTask[]> {
  await initDb();
  const result = db.exec('SELECT * FROM sync_tasks ORDER BY id ASC');
  if (!result[0]) return [];
  return result[0].values.map((row: any[]) => rowToSyncTask(row, result[0].columns));
}

export async function getSyncTask(id: number): Promise<SyncTask | undefined> {
  await initDb();
  const result = db.exec('SELECT * FROM sync_tasks WHERE id=?', [id]);
  if (result[0]?.values.length) return rowToSyncTask(result[0].values[0], result[0].columns);
  return undefined;
}

export async function createSyncTask(task: {
  name: string; sync_config_id: number; sync_config_ids?: string; type: string;
  interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string; enabled: number;
  task_type?: string; backup_config_id?: number; backup_dir?: string; keep_days?: number;
}): Promise<number> {
  await initDb();
  const ids = task.sync_config_ids || (task.sync_config_id ? JSON.stringify([task.sync_config_id]) : '[]');
  db.run(
    "INSERT INTO sync_tasks (name, sync_config_id, sync_config_ids, type, interval_value, interval_unit, cron_expr, scheduled_time, scheduled_days, enabled, task_type, backup_config_id, backup_dir, keep_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [task.name, task.sync_config_id, ids, task.type, task.interval_value, task.interval_unit, task.cron_expr, task.scheduled_time, task.scheduled_days, task.enabled, task.task_type || 'sync', task.backup_config_id || 0, task.backup_dir || '', task.keep_days || 7]
  );
  saveDb();
  const nextRun = calcNextRun(task);
  const idRes = db.exec('SELECT MAX(id) as id FROM sync_tasks');
  const id = Number(idRes[0]?.values[0]?.[0]) || 0;
  if (nextRun && task.enabled) {
    db.run("UPDATE sync_tasks SET next_run_at=? WHERE id=?", [nextRun, id]);
    saveDb();
  }
  return id;
}

export async function updateSyncTask(id: number, task: {
  name: string; sync_config_id: number; sync_config_ids?: string; type: string;
  interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string; enabled: number;
  task_type?: string; backup_config_id?: number; backup_dir?: string; keep_days?: number;
}): Promise<void> {
  await initDb();
  const nextRun = calcNextRun(task);
  const ids = task.sync_config_ids !== undefined ? task.sync_config_ids : (task.sync_config_id ? JSON.stringify([task.sync_config_id]) : undefined);
  let sql = "UPDATE sync_tasks SET name=?, type=?, interval_value=?, interval_unit=?, cron_expr=?, scheduled_time=?, scheduled_days=?, enabled=?, next_run_at=?, updated_at=datetime('now','localtime'), task_type=?, backup_config_id=?, backup_dir=?, keep_days=? WHERE id=?";
  let params: any[] = [task.name, task.type, task.interval_value, task.interval_unit, task.cron_expr, task.scheduled_time, task.scheduled_days, task.enabled, nextRun || '', task.task_type || 'sync', task.backup_config_id || 0, task.backup_dir || '', task.keep_days || 7, id];
  if (ids !== undefined) {
    sql = "UPDATE sync_tasks SET name=?, sync_config_id=?, sync_config_ids=?, type=?, interval_value=?, interval_unit=?, cron_expr=?, scheduled_time=?, scheduled_days=?, enabled=?, next_run_at=?, updated_at=datetime('now','localtime'), task_type=?, backup_config_id=?, backup_dir=?, keep_days=? WHERE id=?";
    params = [task.name, task.sync_config_id, ids, task.type, task.interval_value, task.interval_unit, task.cron_expr, task.scheduled_time, task.scheduled_days, task.enabled, nextRun || '', task.task_type || 'sync', task.backup_config_id || 0, task.backup_dir || '', task.keep_days || 7, id];
  }
  db.run(sql, params);
  saveDb();
}

export async function deleteSyncTask(id: number): Promise<void> {
  await initDb();
  db.run('DELETE FROM sync_tasks WHERE id=?', [id]);
  saveDb();
}

export async function updateTaskRunTime(id: number, nextRunAt: string): Promise<void> {
  await initDb();
  db.run("UPDATE sync_tasks SET last_run_at=datetime('now','localtime'), next_run_at=?, updated_at=datetime('now','localtime') WHERE id=?", [nextRunAt, id]);
  saveDb();
}

function calcNextRun(task: { type: string; interval_value: number; interval_unit: string; cron_expr: string; scheduled_time: string; scheduled_days: string }): string {
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
    case 'once':
    case 'daily': {
      if (!task.scheduled_time) return '';
      const [h, m] = task.scheduled_time.split(':').map(Number);
      const next = new Date(now);
      next.setHours(h || 0, m || 0, 0, 0);
      if (next <= now && task.type === 'daily') next.setDate(next.getDate() + 1);
      if (next <= now && task.type === 'once') return '';
      
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
        if (days.includes(dayOfWeek) && candidate > now) return candidate.toISOString().slice(0, 19).replace('T', ' ');
      }
      const nextWeek = new Date(next);
      nextWeek.setDate(nextWeek.getDate() + 7);
      return nextWeek.toISOString().slice(0, 19).replace('T', ' ');
    }
    default:
      return '';
  }
}

// ========== 任务执行日志 CRUD ==========

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
  file_size: number;
  started_at: string;
  finished_at: string;
  created_at: string;
}

function rowToExecLog(row: any[], columns: string[]): TaskExecutionLog {
  const map: Record<string, number> = {};
  columns.forEach((n, i) => { map[n.toLowerCase()] = i; });
  const get = (name: string): any => {
    const idx = map[name];
    return idx !== undefined ? row[idx] : '';
  };
  return {
    id: Number(get('id')) || 0,
    task_id: Number(get('task_id')) || 0,
    task_name: String(get('task_name')),
    sync_config_id: Number(get('sync_config_id')) || 0,
    sync_config_name: String(get('sync_config_name')),
    target_table: String(get('target_table')),
    task_type: String(get('task_type')) || 'sync',
    status: String(get('status')) || 'pending',
    total_records: Number(get('total_records')) || 0,
    success_count: Number(get('success_count')) || 0,
    error_count: Number(get('error_count')) || 0,
    log_filename: String(get('log_filename')),
    error_message: String(get('error_message')),
    backup_file: String(get('backup_file')),
    file_size: Number(get('file_size')) || 0,
    started_at: String(get('started_at')),
    finished_at: String(get('finished_at')),
    created_at: String(get('created_at')),
  };
}

export async function listTaskExecutionLogs(taskId?: number): Promise<TaskExecutionLog[]> {
  await initDb();
  let sql = 'SELECT * FROM task_execution_logs';
  let params: any[] = [];
  if (taskId) { sql += ' WHERE task_id=?'; params.push(taskId); }
  sql += ' ORDER BY id DESC';
  const result = db.exec(sql, params);
  if (!result[0]) return [];
  return result[0].values.map((row: any[]) => rowToExecLog(row, result[0].columns));
}

export async function createTaskExecutionLog(log: {
  task_id: number; task_name: string; sync_config_id: number; sync_config_name: string;
  target_table: string; task_type?: string; status: string;
}): Promise<number> {
  await initDb();
  db.run(
    "INSERT INTO task_execution_logs (task_id, task_name, sync_config_id, sync_config_name, target_table, task_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
    [log.task_id, log.task_name, log.sync_config_id, log.sync_config_name, log.target_table, log.task_type || 'sync', log.status]
  );
  saveDb();
  const result = db.exec('SELECT MAX(id) as id FROM task_execution_logs');
  return Number(result[0]?.values[0]?.[0]) || 0;
}

export async function updateTaskExecutionLog(id: number, updates: {
  status?: string; total_records?: number; success_count?: number; error_count?: number;
  log_filename?: string; error_message?: string; backup_file?: string; file_size?: number;
}): Promise<void> {
  await initDb();
  const sets: string[] = ["finished_at=datetime('now','localtime')"];
  const params: any[] = [];
  if (updates.status !== undefined) { sets.push('status=?'); params.push(updates.status); }
  if (updates.total_records !== undefined) { sets.push('total_records=?'); params.push(updates.total_records); }
  if (updates.success_count !== undefined) { sets.push('success_count=?'); params.push(updates.success_count); }
  if (updates.error_count !== undefined) { sets.push('error_count=?'); params.push(updates.error_count); }
  if (updates.log_filename !== undefined) { sets.push('log_filename=?'); params.push(updates.log_filename); }
  if (updates.backup_file !== undefined) { sets.push('backup_file=?'); params.push(updates.backup_file); }
  if (updates.error_message !== undefined) { sets.push('error_message=?'); params.push(updates.error_message); }
  if (updates.file_size !== undefined) { sets.push('file_size=?'); params.push(updates.file_size); }
  params.push(id);
  db.run("UPDATE task_execution_logs SET " + sets.join(',') + " WHERE id=?", params);
  saveDb();
}
export async function deleteTaskExecutionLog(id: number): Promise<void> {
  db.run('DELETE FROM task_execution_logs WHERE id=?', [id]);
  saveDb();
}


// ========== 配置导入/导出 ==========

/**
 * 导出配置数据（按分类）
 */
export async function exportConfig(categories: string[] = []): Promise<Record<string, any>> {
  await initDb();
  const result: Record<string, any> = {};
  const all = categories.length === 0;

  if (all || categories.includes('token')) {
    const config = await getConfig();
    result.token = config ? { key: config.key, secret: config.secret, token_url: config.token_url, data_api_url: config.data_api_url } : {};
  }
  if (all || categories.includes('pg_sources')) {
    result.pg_sources = await listPgDatasources();
  }
  if (all || categories.includes('remote_tables')) {
    result.remote_tables = await listRemoteTables();
  }
  if (all || categories.includes('sync_configs')) {
    result.sync_configs = await listSyncConfigs();
  }
  if (all || categories.includes('sync_tasks')) {
    result.sync_tasks = await listSyncTasks();
  }
  if (all || categories.includes('backup_configs')) {
    result.backup_configs = await listBackupConfigs();
  }

  return result;
}

/**
 * 清空指定分类的配置
 */
export async function clearConfig(categories: string[] = []): Promise<void> {
  await initDb();
  const all = categories.length === 0;
  const tables: string[] = [];

  if (all || categories.includes('sync_tasks')) tables.push('sync_tasks');
  if (all || categories.includes('sync_configs')) tables.push('sync_configs');
  if (all || categories.includes('remote_tables')) tables.push('remote_tables');
  if (all || categories.includes('pg_sources')) tables.push('pg_datasources');
  if (all || categories.includes('backup_configs')) tables.push('backup_configs');
  if (all || categories.includes('backup_logs')) tables.push('backup_logs');
  if (all || categories.includes('task_logs')) tables.push('task_execution_logs');

  for (const t of tables) {
    db.run('DELETE FROM ' + t);
  }

  // 清空 token 配置（重置为空）
  if (all || categories.includes('token')) {
    const result = db.exec('SELECT id FROM configs LIMIT 1');
    if (result[0]?.values.length) {
      const id = result[0].values[0][0];
      db.run("UPDATE configs SET key='', secret='', token_url='', data_api_url='', access_token='', updated_at=datetime('now','localtime') WHERE id=?", [id]);
    }
  }

  saveDb();
}

/**
 * 导入配置数据
 */
export async function importConfig(data: Record<string, any>, categories: string[] = []): Promise<{ imported: string[]; errors: string[] }> {
  await initDb();
  const imported: string[] = [];
  const errors: string[] = [];
  const all = categories.length === 0;

  // 导入 token 配置
  if ((all || categories.includes('token')) && data.token) {
    try {
      const cfg = await getConfig();
      if (cfg) {
        db.run("UPDATE configs SET key=?, secret=?, token_url=?, data_api_url=?, updated_at=datetime('now','localtime') WHERE id=?",
          [data.token.key || '', data.token.secret || '', data.token.token_url || '', data.token.data_api_url || '', cfg.id]);
        saveDb();
        imported.push('token');
      }
    } catch (e: any) { errors.push('token: ' + e.message); }
  }

  // 导入 PG 数据源
  if ((all || categories.includes('pg_sources')) && Array.isArray(data.pg_sources)) {
    for (const ds of data.pg_sources) {
      try {
        if (ds.id) db.run('DELETE FROM pg_datasources WHERE id=?', [ds.id]);
        db.run('INSERT INTO pg_datasources (id, name, host, port, user, password, database, schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [ds.id, ds.name || '', ds.host || '', ds.port || '5432', ds.user || '', ds.password || '', ds.database || '', ds.schema || 'public', ds.created_at || '', ds.updated_at || '']);
        saveDb();
      } catch (e: any) { errors.push('pg_sources:' + (ds.name || ds.id) + ' - ' + e.message); }
    }
    imported.push('pg_sources');
  }

  // 导入远程表配置
  if ((all || categories.includes('remote_tables')) && Array.isArray(data.remote_tables)) {
    for (const t of data.remote_tables) {
      try {
        if (t.id) db.run('DELETE FROM remote_tables WHERE id=?', [t.id]);
        db.run('INSERT INTO remote_tables (id, name, data_api_url, conditions, logic, page, per_page, order_field, order_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t.id, t.name || '', t.data_api_url || '', t.conditions || '[]', t.logic || 'and', t.page || 1, t.per_page || 20, t.order_field || '', t.order_dir || 'asc', t.created_at || '', t.updated_at || '']);
        saveDb();
      } catch (e: any) { errors.push('remote_tables:' + (t.name || t.id) + ' - ' + e.message); }
    }
    imported.push('remote_tables');
  }

  // 导入同步配置
  if ((all || categories.includes('sync_configs')) && Array.isArray(data.sync_configs)) {
    for (const cfg of data.sync_configs) {
      try {
        if (cfg.id) db.run('DELETE FROM sync_configs WHERE id=?', [cfg.id]);
        db.run('INSERT INTO sync_configs (id, name, remote_table_id, pg_source_id, target_table, target_pk, import_settings, page, per_page, all_import, conditions, logic, order_field, order_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [cfg.id, cfg.name || '', cfg.remote_table_id || 0, cfg.pg_source_id || 0, cfg.target_table || '', cfg.target_pk || '', cfg.import_settings || '[]', cfg.page || 1, cfg.per_page || 200, cfg.all_import || 0, cfg.conditions || '[]', cfg.logic || 'and', cfg.order_field || '', cfg.order_dir || 'asc', cfg.created_at || '', cfg.updated_at || '']);
        saveDb();
      } catch (e: any) { errors.push('sync_configs:' + (cfg.name || cfg.id) + ' - ' + e.message); }
    }
    imported.push('sync_configs');
  }

  // 导入定时任务
  if ((all || categories.includes('sync_tasks')) && Array.isArray(data.sync_tasks)) {
    for (const task of data.sync_tasks) {
      try {
        if (task.id) db.run('DELETE FROM sync_tasks WHERE id=?', [task.id]);
        db.run("INSERT INTO sync_tasks (id, name, sync_config_id, sync_config_ids, type, interval_value, interval_unit, cron_expr, scheduled_time, scheduled_days, enabled, last_run_at, next_run_at, created_at, updated_at, task_type, backup_config_id, backup_dir, keep_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [task.id, task.name || '', task.sync_config_id || 0, task.sync_config_ids || '[]', task.type || 'interval', task.interval_value || 0, task.interval_unit || 'minutes', task.cron_expr || '', task.scheduled_time || '', task.scheduled_days || '', task.enabled !== undefined ? task.enabled : 1, task.last_run_at || '', task.next_run_at || '', task.created_at || '', task.updated_at || '', task.task_type || 'sync', task.backup_config_id || 0, task.backup_dir || '', task.keep_days || 7]);
        saveDb();
      } catch (e: any) { errors.push('sync_tasks:' + (task.name || task.id) + ' - ' + e.message); }
    }
    imported.push('sync_tasks');
  }

  // 导入备份配置
  if ((all || categories.includes('backup_configs')) && Array.isArray(data.backup_configs)) {
    for (const cfg of data.backup_configs) {
      try {
        if (cfg.id) db.run('DELETE FROM backup_configs WHERE id=?', [cfg.id]);
        db.run("INSERT INTO backup_configs (id, name, pg_source_id, database_name, backup_dir, keep_days, backup_format, enabled, type, interval_value, interval_unit, scheduled_time, next_run_at, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [cfg.id, cfg.name || '', cfg.pg_source_id || 0, cfg.database_name || '', cfg.backup_dir || '', cfg.keep_days || 180, cfg.backup_format || 'sql', cfg.enabled !== undefined ? cfg.enabled : 1, cfg.type || 'interval', cfg.interval_value || 0, cfg.interval_unit || 'hours', cfg.scheduled_time || '', cfg.next_run_at || '', cfg.last_run_at || '', cfg.created_at || '', cfg.updated_at || '']);
        saveDb();
      } catch (e: any) { errors.push('backup_configs:' + (cfg.name || cfg.id) + ' - ' + e.message); }
    }
    imported.push('backup_configs');
  }

  return { imported, errors };
}

// ========== 备份配置 CRUD ==========

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

function rowToBackupConfig(row: any[], columns: string[]): BackupConfig {
  const map: Record<string, number> = {};
  columns.forEach((n, i) => { map[n.toLowerCase()] = i; });
  const get = (name: string): any => { const idx = map[name]; return idx !== undefined ? row[idx] : ''; };
  return {
    id: Number(get('id')) || 0, name: String(get('name')),
    pg_source_id: Number(get('pg_source_id')) || 0, database_name: String(get('database_name')),
    backup_dir: String(get('backup_dir')), keep_days: Number(get('keep_days')) || 7,
    backup_format: String(get('backup_format')) || 'sql',
    enabled: (() => { const v = get('enabled'); return v !== '' && v !== null && v !== undefined ? Number(v) : 1; })(),
    type: String(get('type')) || 'interval', interval_value: Number(get('interval_value')) || 0,
    interval_unit: String(get('interval_unit')) || 'hours', scheduled_time: String(get('scheduled_time')),
    next_run_at: String(get('next_run_at')), last_run_at: String(get('last_run_at')),
    created_at: String(get('created_at')), updated_at: String(get('updated_at')),
  };
}

export async function listBackupConfigs(): Promise<BackupConfig[]> {
  await initDb();
  const r = db.exec('SELECT * FROM backup_configs ORDER BY id ASC');
  if (!r[0]) return [];
  return r[0].values.map(row => rowToBackupConfig(row, r[0].columns));
}

export async function listBackupConfigsNames(): Promise<{ id: number; name: string }[]> {
  await initDb();
  const r = db.exec('SELECT id, name FROM backup_configs ORDER BY id ASC');
  if (!r[0]) return [];
  const nameIdx = r[0].columns.indexOf('name');
  const idIdx = r[0].columns.indexOf('id');
  return r[0].values.map(row => ({ id: Number(row[idIdx]), name: String(row[nameIdx]) }));
}

export async function getBackupConfig(id: number): Promise<BackupConfig | undefined> {
  await initDb();
  const r = db.exec('SELECT * FROM backup_configs WHERE id=?', [id]);
  if (r[0]?.values.length) return rowToBackupConfig(r[0].values[0], r[0].columns);
}

export async function createBackupConfig(cfg: {
  name: string; pg_source_id: number; database_name: string; backup_dir: string;
  keep_days: number; backup_format?: string; enabled: number; type: string; interval_value: number;
  interval_unit: string; scheduled_time: string;
}): Promise<number> {
  await initDb();
  db.run(
    "INSERT INTO backup_configs (name, pg_source_id, database_name, backup_dir, keep_days, backup_format, enabled, type, interval_value, interval_unit, scheduled_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [cfg.name, cfg.pg_source_id, cfg.database_name, cfg.backup_dir, cfg.keep_days, cfg.backup_format || 'sql', cfg.enabled, cfg.type, cfg.interval_value, cfg.interval_unit, cfg.scheduled_time]
  );
  saveDb();
  // 计算下次执行时间
  const next = calcBackupNextRun(cfg);
  if (next) { db.run("UPDATE backup_configs SET next_run_at=? WHERE id=(SELECT MAX(id) FROM backup_configs)", [next]); saveDb(); }
  const r = db.exec('SELECT MAX(id) FROM backup_configs');
  return Number(r[0]?.values[0]?.[0]) || 0;
}

export async function updateBackupConfig(id: number, cfg: {
  name: string; pg_source_id: number; database_name: string; backup_dir: string;
  keep_days: number; backup_format?: string; enabled: number; type: string; interval_value: number;
  interval_unit: string; scheduled_time: string;
}): Promise<void> {
  await initDb();
  const next = calcBackupNextRun(cfg);
  db.run(
    "UPDATE backup_configs SET name=?, pg_source_id=?, database_name=?, backup_dir=?, keep_days=?, backup_format=?, enabled=?, type=?, interval_value=?, interval_unit=?, scheduled_time=?, next_run_at=?, updated_at=datetime('now','localtime') WHERE id=?",
    [cfg.name, cfg.pg_source_id, cfg.database_name, cfg.backup_dir, cfg.keep_days, cfg.backup_format || 'sql', cfg.enabled, cfg.type, cfg.interval_value, cfg.interval_unit, cfg.scheduled_time, next || '', id]
  );
  saveDb();
}

export async function deleteBackupConfig(id: number): Promise<void> {
  await initDb();
  db.run('DELETE FROM backup_configs WHERE id=?', [id]);
  saveDb();
}

export async function updateBackupRunTime(id: number, nextRunAt: string): Promise<void> {
  await initDb();
  db.run("UPDATE backup_configs SET last_run_at=datetime('now','localtime'), next_run_at=?, updated_at=datetime('now','localtime') WHERE id=?", [nextRunAt, id]);
  saveDb();
}

function calcBackupNextRun(cfg: { type: string; interval_value: number; interval_unit: string; scheduled_time: string }): string {
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

// ========== 备份日志 CRUD ==========

export interface BackupLog {
  id: number; config_id: number; config_name: string; database_name: string;
  backup_file: string; file_size: number; status: string; error_message: string;
  started_at: string; finished_at: string; created_at: string;
}

function rowToBackupLog(row: any[], columns: string[]): BackupLog {
  const map: Record<string, number> = {};
  columns.forEach((n, i) => { map[n.toLowerCase()] = i; });
  const get = (name: string): any => { const idx = map[name]; return idx !== undefined ? row[idx] : ''; };
  return {
    id: Number(get('id')) || 0, config_id: Number(get('config_id')) || 0,
    config_name: String(get('config_name')), database_name: String(get('database_name')),
    backup_file: String(get('backup_file')), file_size: Number(get('file_size')) || 0,
    status: String(get('status')) || 'pending', error_message: String(get('error_message')),
    started_at: String(get('started_at')), finished_at: String(get('finished_at')),
    created_at: String(get('created_at')),
  };
}

export async function listBackupLogs(configId?: number): Promise<BackupLog[]> {
  await initDb();
  let sql = 'SELECT * FROM backup_logs'; const params: any[] = [];
  if (configId) { sql += ' WHERE config_id=?'; params.push(configId); }
  sql += ' ORDER BY id DESC LIMIT 50';
  const r = db.exec(sql, params);
  if (!r[0]) return [];
  return r[0].values.map(row => rowToBackupLog(row, r[0].columns));
}

export async function getBackupLog(id: number): Promise<BackupLog | undefined> {
  await initDb();
  const r = db.exec('SELECT * FROM backup_logs WHERE id=?', [id]);
  if (!r[0]?.values?.length) return undefined;
  return rowToBackupLog(r[0].values[0], r[0].columns);
}

export async function createBackupLog(log: { config_id: number; config_name: string; database_name: string; status: string }): Promise<number> {
  await initDb();
  db.run("INSERT INTO backup_logs (config_id, config_name, database_name, status, started_at) VALUES (?,?,?,?,datetime('now','localtime'))",
    [log.config_id, log.config_name, log.database_name, log.status]);
  saveDb();
  const r = db.exec('SELECT MAX(id) FROM backup_logs');
  return Number(r[0]?.values[0]?.[0]) || 0;
}

export async function deleteBackupLogs(ids: number[]): Promise<void> {
  await initDb();
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM backup_logs WHERE id IN (${placeholders})`, ids);
  saveDb();
}

export async function updateBackupLog(id: number, data: { status?: string; backup_file?: string; file_size?: number; error_message?: string }): Promise<void> {
  await initDb();
  const sets: string[] = ["finished_at=datetime('now','localtime')"];
  const params: any[] = [];
  if (data.status !== undefined) { sets.push('status=?'); params.push(data.status); }
  if (data.backup_file !== undefined) { sets.push('backup_file=?'); params.push(data.backup_file); }
  if (data.file_size !== undefined) { sets.push('file_size=?'); params.push(data.file_size); }
  if (data.error_message !== undefined) { sets.push('error_message=?'); params.push(data.error_message); }
  params.push(id);
  db.run("UPDATE backup_logs SET " + sets.join(',') + " WHERE id=?", params);
  saveDb();
}

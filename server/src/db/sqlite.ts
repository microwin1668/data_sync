import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'config.db');

// 日志保留策略:任务执行日志保留 30 天,备份日志保留 90 天,文件备份日志保留 90 天
const TASK_LOG_RETENTION_DAYS = 30;
const BACKUP_LOG_RETENTION_DAYS = 90;
const FILE_BACKUP_LOG_RETENTION_DAYS = 90;

let db: Database.Database;

export async function initDb(): Promise<Database.Database> {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

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

  db.exec(
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
  db.exec(
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS sync_configs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "remote_table_id INTEGER DEFAULT 0," +
    "pg_source_id INTEGER DEFAULT 0," +
    "target_database TEXT DEFAULT ''," +
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
    { name: "target_database", def: "TEXT DEFAULT ''" },
  ]);

  // pg_datasources 表
  db.exec(
    "CREATE TABLE IF NOT EXISTS pg_datasources (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "host TEXT NOT NULL DEFAULT ''," +
    "port TEXT NOT NULL DEFAULT '5432'," +
    "user TEXT NOT NULL DEFAULT ''," +
    "password TEXT DEFAULT ''," +
    "database TEXT NOT NULL DEFAULT ''," +
    "schema TEXT DEFAULT 'public'," +
    "disable_import INTEGER DEFAULT 0," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  tryMigrateTable("pg_datasources", [
    { name: "disable_import", def: "INTEGER DEFAULT 0" },
  ]);

  // sync_tasks 表（定时任务）
  db.exec(
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
    "sort_order INTEGER DEFAULT 0," +             // 执行顺序，数字小的先执行
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
    { name: "file_backup_config_id", def: "INTEGER DEFAULT 0" },
    { name: "backup_dir", def: "TEXT DEFAULT ''" },
    { name: "keep_days", def: "INTEGER DEFAULT 7" },
    { name: "sort_order", def: "INTEGER DEFAULT 0" },
  ]);

  // task_execution_logs 表
  db.exec(
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
  db.exec(
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
  db.exec(
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

  // file_backup_configs 表(远程目录每日快照备份配置)
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_backup_configs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "name TEXT NOT NULL DEFAULT ''," +
    "ssh_host TEXT DEFAULT ''," +
    "ssh_port TEXT DEFAULT '22'," +
    "ssh_user TEXT DEFAULT ''," +
    "auth_type TEXT DEFAULT 'key'," +           // key: SSH 密钥 / password: 密码(sshpass)
    "ssh_key_path TEXT DEFAULT ''," +
    "ssh_password TEXT DEFAULT ''," +
    "remote_dir TEXT DEFAULT ''," +
    "local_dir TEXT DEFAULT ''," +
    "exclude_patterns TEXT DEFAULT '[]'," +     // 排除规则 JSON 数组
    "keep_days INTEGER DEFAULT 30," +
    "enabled INTEGER DEFAULT 1," +
    "last_run_at TEXT DEFAULT ''," +
    "last_snapshot_dir TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // file_backup_logs 表(远程目录快照备份日志)
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_backup_logs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "config_id INTEGER DEFAULT 0," +
    "config_name TEXT DEFAULT ''," +
    "remote_dir TEXT DEFAULT ''," +
    "local_dir TEXT DEFAULT ''," +
    "snapshot_dir TEXT DEFAULT ''," +
    "status TEXT DEFAULT 'pending'," +
    "total_files INTEGER DEFAULT 0," +
    "transferred_files INTEGER DEFAULT 0," +
    "transferred_bytes INTEGER DEFAULT 0," +
    "error_message TEXT DEFAULT ''," +
    "started_at TEXT DEFAULT ''," +
    "finished_at TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );

  // email_notify_config 表(邮件告警配置)
  db.exec(
    "CREATE TABLE IF NOT EXISTS email_notify_config (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "smtp_host TEXT DEFAULT ''," +
    "smtp_port TEXT DEFAULT '465'," +
    "smtp_secure INTEGER DEFAULT 1," +
    "smtp_user TEXT DEFAULT ''," +
    "smtp_password TEXT DEFAULT ''," +
    "from_email TEXT DEFAULT ''," +
    "recipients TEXT DEFAULT ''," +
    "notify_backup_fail INTEGER DEFAULT 1," +
    "notify_sync_fail INTEGER DEFAULT 1," +
    "notify_crash INTEGER DEFAULT 1," +
    "throttle_minutes INTEGER DEFAULT 30," +
    "crash_throttle_minutes INTEGER DEFAULT 10," +
    "last_crash_notify_at TEXT DEFAULT ''," +
    "created_at TEXT DEFAULT (datetime('now','localtime'))," +
    "updated_at TEXT DEFAULT (datetime('now','localtime'))" +
    ")"
  );
  tryMigrateTable("email_notify_config", [
    { name: "notify_file_backup_fail", def: "INTEGER DEFAULT 1" },
    { name: "throttle_minutes", def: "INTEGER DEFAULT 30" },
    { name: "crash_throttle_minutes", def: "INTEGER DEFAULT 10" },
    { name: "last_crash_notify_at", def: "TEXT DEFAULT ''" },
  ]);

  // 确保 configs 有一行
  const row = db.prepare('SELECT COUNT(*) as cnt FROM configs').get() as any;
  const count = Number(row?.cnt) || 0;
  if (count === 0) {
    db.prepare('INSERT INTO configs (key, secret, token_url) VALUES (?, ?, ?)').run('', '', '');
  }

  // 确保 email_notify_config 有一行
  const notifyRow = db.prepare('SELECT COUNT(*) as cnt FROM email_notify_config').get() as any;
  if (Number(notifyRow?.cnt) === 0) {
    db.prepare("INSERT INTO email_notify_config (smtp_host) VALUES ('')").run();
  }

  cleanupOldLogs();
  return db;
}

function tryMigrateTable(table: string, columns: { name: string; def: string }[]) {
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) return;
    const info = db.prepare('PRAGMA table_info(' + table + ')').all() as any[];
    if (!info.length) return;
    const existingCols = info.map(r => String(r.name));
    for (const col of columns) {
      if (!existingCols.includes(col.name)) {
        db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col.name + ' ' + col.def);
      }
    }
  } catch {}
}

/**
 * 清理过期日志(启动时与每日定时执行)
 */
export function cleanupOldLogs(): void {
  if (!db) return;
  try {
    db.prepare("DELETE FROM task_execution_logs WHERE created_at < datetime('now', 'localtime', ?)")
      .run('-' + TASK_LOG_RETENTION_DAYS + ' days');
    db.prepare("DELETE FROM backup_logs WHERE created_at < datetime('now', 'localtime', ?)")
      .run('-' + BACKUP_LOG_RETENTION_DAYS + ' days');
    db.prepare("DELETE FROM file_backup_logs WHERE created_at < datetime('now', 'localtime', ?)")
      .run('-' + FILE_BACKUP_LOG_RETENTION_DAYS + ' days');
  } catch (err: any) {
    console.error('[DB] 清理过期日志失败:', err.message);
  }
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
  auth_password: string;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: Record<string, any>): ConfigRow {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
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
    auth_password: String(get('auth_password')),
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
  };
}

export async function upsertTokenConfig(key: string, secret: string, tokenUrl: string) {
  await initDb();
  const row = db.prepare('SELECT id FROM configs LIMIT 1').get() as any;
  if (row) {
    db.prepare("UPDATE configs SET key=?, secret=?, token_url=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(key, secret, tokenUrl, row.id);
  } else {
    db.prepare('INSERT INTO configs (key, secret, token_url) VALUES (?, ?, ?)').run(key, secret, tokenUrl);
  }
}

export async function updateAuthPassword(password: string) {
  await initDb();
  const row = db.prepare('SELECT id FROM configs LIMIT 1').get() as any;
  if (row) {
    db.prepare("UPDATE configs SET auth_password=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(password, row.id);
  }
}

export async function updateAccessToken(token: string) {
  await initDb();
  const row = db.prepare('SELECT id FROM configs LIMIT 1').get() as any;
  if (row) {
    db.prepare("UPDATE configs SET access_token=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(token, row.id);
  }
}

export async function upsertDataApiUrl(url: string) {
  await initDb();
  const row = db.prepare('SELECT id FROM configs LIMIT 1').get() as any;
  if (row) {
    db.prepare("UPDATE configs SET data_api_url=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(url, row.id);
  }
}

export async function getConfig(): Promise<ConfigRow | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM configs LIMIT 1').get() as any;
  return row ? rowToConfig(row) : undefined;
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
  disable_import: number;
  created_at: string;
  updated_at: string;
}

function rowToPgDatasource(row: Record<string, any>): PgDatasource {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
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
    disable_import: Number(get('disable_import')) || 0,
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
  };
}

export async function listPgDatasources(): Promise<PgDatasource[]> {
  await initDb();
  const rows = db.prepare('SELECT * FROM pg_datasources ORDER BY id ASC').all() as any[];
  return rows.map(rowToPgDatasource);
}

export async function createPgDatasource(ds: {
  name: string; host: string; port: string; user: string; password: string; database: string; schema: string;
  disable_import?: number;
}): Promise<number> {
  await initDb();
  const info = db.prepare(
    'INSERT INTO pg_datasources (name, host, port, user, password, database, schema, disable_import) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(ds.name, ds.host, ds.port, ds.user, ds.password, ds.database, ds.schema || 'public', ds.disable_import || 0);
  return Number(info.lastInsertRowid);
}

export async function updatePgDatasource(id: number, ds: {
  name: string; host: string; port: string; user: string; password: string; database: string; schema: string;
  disable_import?: number;
}) {
  await initDb();
  db.prepare(
    "UPDATE pg_datasources SET name=?, host=?, port=?, user=?, password=?, database=?, schema=?, disable_import=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(ds.name, ds.host, ds.port, ds.user, ds.password, ds.database, ds.schema || 'public', ds.disable_import || 0, id);
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

function rowToRemoteTable(row: Record<string, any>): RemoteTable {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
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
  const rows = db.prepare('SELECT * FROM remote_tables ORDER BY id ASC').all() as any[];
  return rows.map(rowToRemoteTable);
}

export async function getRemoteTable(id: number): Promise<RemoteTable | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM remote_tables WHERE id=?').get(id) as any;
  return row ? rowToRemoteTable(row) : undefined;
}

export async function createRemoteTable(t: {
  name: string; data_api_url: string; conditions: string; logic: string;
  page: number; per_page: number; order_field: string; order_dir: string;
}): Promise<number> {
  await initDb();
  const info = db.prepare(
    'INSERT INTO remote_tables (name, data_api_url, conditions, logic, page, per_page, order_field, order_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(t.name, t.data_api_url, t.conditions, t.logic, t.page, t.per_page, t.order_field, t.order_dir);
  return Number(info.lastInsertRowid);
}

export async function updateRemoteTable(id: number, t: {
  name: string; data_api_url: string; conditions: string; logic: string;
  page: number; per_page: number; order_field: string; order_dir: string;
}) {
  await initDb();
  db.prepare(
    "UPDATE remote_tables SET name=?, data_api_url=?, conditions=?, logic=?, page=?, per_page=?, order_field=?, order_dir=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(t.name, t.data_api_url, t.conditions, t.logic, t.page, t.per_page, t.order_field, t.order_dir, id);
}

// ========== Sync Configs ==========

export interface SyncConfig {
  id: number;
  name: string;
  remote_table_id: number;
  pg_source_id: number;
  target_database: string;
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

function rowToSyncConfig(row: Record<string, any>): SyncConfig {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
  };
  return {
    id: Number(get('id')) || 0,
    name: String(get('name')),
    remote_table_id: Number(get('remote_table_id')) || 0,
    pg_source_id: Number(get('pg_source_id')) || 0,
    target_database: String(get('target_database')),
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
  const rows = db.prepare('SELECT * FROM sync_configs ORDER BY id ASC').all() as any[];
  return rows.map(rowToSyncConfig);
}

export async function getSyncConfig(id: number): Promise<SyncConfig | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM sync_configs WHERE id=?').get(id) as any;
  return row ? rowToSyncConfig(row) : undefined;
}

export async function createSyncConfig(cfg: {
  name: string; remote_table_id: number; pg_source_id: number; target_database?: string; target_table: string;
  target_pk: string; import_settings: string; page: number; per_page: number; all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;}): Promise<number> {
  await initDb();
  const info = db.prepare(
    'INSERT INTO sync_configs (name, remote_table_id, pg_source_id, target_database, target_table, target_pk, import_settings, page, per_page, all_import, conditions, logic, order_field, order_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(cfg.name, cfg.remote_table_id, cfg.pg_source_id, cfg.target_database || '', cfg.target_table, cfg.target_pk, cfg.import_settings, cfg.page, cfg.per_page, cfg.all_import, cfg.conditions, cfg.logic, cfg.order_field, cfg.order_dir);
  return Number(info.lastInsertRowid);
}

export async function updateSyncConfig(id: number, cfg: {
  name: string; remote_table_id: number; pg_source_id: number; target_database?: string; target_table: string;
  target_pk: string; import_settings: string; page: number; per_page: number; all_import: number;
  conditions: string;
  logic: string;
  order_field: string;
  order_dir: string;}) {
  await initDb();
  db.prepare(
    "UPDATE sync_configs SET name=?, remote_table_id=?, pg_source_id=?, target_database=?, target_table=?, target_pk=?, import_settings=?, page=?, per_page=?, all_import=?, conditions=?, logic=?, order_field=?, order_dir=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(cfg.name, cfg.remote_table_id, cfg.pg_source_id, cfg.target_database || '', cfg.target_table, cfg.target_pk, cfg.import_settings, cfg.page, cfg.per_page, cfg.all_import, cfg.conditions, cfg.logic, cfg.order_field, cfg.order_dir, id);
}

export async function deleteSyncConfig(id: number) {
  await initDb();
  db.prepare('DELETE FROM sync_configs WHERE id=?').run(id);
}

export async function deleteRemoteTable(id: number) {
  await initDb();
  db.prepare('DELETE FROM remote_tables WHERE id=?').run(id);
}

export async function deletePgDatasource(id: number) {
  await initDb();
  db.prepare('DELETE FROM pg_datasources WHERE id=?').run(id);
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
  sort_order: number;
  last_run_at: string;
  next_run_at: string;
  created_at: string;
  updated_at: string;
  task_type: string;
  backup_config_id: number;
  file_backup_config_id: number;
  backup_dir: string;
  keep_days: number;
}

function rowToSyncTask(row: Record<string, any>): SyncTask {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
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
    sort_order: Number(get('sort_order')) || 0,
    last_run_at: String(get('last_run_at')) || '',
    next_run_at: String(get('next_run_at')) || '',
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
    task_type: String(get('task_type')) || 'sync',
    backup_config_id: Number(get('backup_config_id')) || 0,
    file_backup_config_id: Number(get('file_backup_config_id')) || 0,
    backup_dir: String(get('backup_dir')) || '',
    keep_days: Number(get('keep_days')) || 7,
  };
}

export async function listSyncTasks(): Promise<SyncTask[]> {
  await initDb();
  const rows = db.prepare('SELECT * FROM sync_tasks ORDER BY sort_order ASC, id ASC').all() as any[];
  return rows.map(rowToSyncTask);
}

export async function getSyncTask(id: number): Promise<SyncTask | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM sync_tasks WHERE id=?').get(id) as any;
  return row ? rowToSyncTask(row) : undefined;
}

export async function createSyncTask(task: {
  name: string; sync_config_id: number; sync_config_ids?: string; type: string;
  interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string; enabled: number;
  sort_order?: number;
  task_type?: string; backup_config_id?: number; file_backup_config_id?: number; backup_dir?: string; keep_days?: number;
}): Promise<number> {
  await initDb();
  const ids = task.sync_config_ids || (task.sync_config_id ? JSON.stringify([task.sync_config_id]) : '[]');
  const info = db.prepare(
    "INSERT INTO sync_tasks (name, sync_config_id, sync_config_ids, type, interval_value, interval_unit, cron_expr, scheduled_time, scheduled_days, enabled, sort_order, task_type, backup_config_id, file_backup_config_id, backup_dir, keep_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(task.name, task.sync_config_id, ids, task.type, task.interval_value, task.interval_unit, task.cron_expr, task.scheduled_time, task.scheduled_days, task.enabled, task.sort_order || 0, task.task_type || 'sync', task.backup_config_id || 0, task.file_backup_config_id || 0, task.backup_dir || '', task.keep_days || 7);
  const id = Number(info.lastInsertRowid);
  // 计算下次执行时间
  const nextRun = calcNextRun(task);
  if (nextRun && task.enabled) {
    db.prepare("UPDATE sync_tasks SET next_run_at=? WHERE id=?").run(nextRun, id);
  }
  return id;
}

export async function updateSyncTask(id: number, task: {
  name: string; sync_config_id: number; sync_config_ids?: string; type: string;
  interval_value: number; interval_unit: string;
  cron_expr: string; scheduled_time: string; scheduled_days: string; enabled: number;
  sort_order?: number;
  task_type?: string; backup_config_id?: number; file_backup_config_id?: number; backup_dir?: string; keep_days?: number;
}): Promise<void> {
  await initDb();
  const nextRun = calcNextRun(task);
  const ids = task.sync_config_ids !== undefined ? task.sync_config_ids : (task.sync_config_id ? JSON.stringify([task.sync_config_id]) : undefined);
  let sql = "UPDATE sync_tasks SET name=?, type=?, interval_value=?, interval_unit=?, cron_expr=?, scheduled_time=?, scheduled_days=?, enabled=?, sort_order=?, next_run_at=?, updated_at=datetime('now','localtime'), task_type=?, backup_config_id=?, file_backup_config_id=?, backup_dir=?, keep_days=? WHERE id=?";
  let params: any[] = [task.name, task.type, task.interval_value, task.interval_unit, task.cron_expr, task.scheduled_time, task.scheduled_days, task.enabled, task.sort_order || 0, nextRun || '', task.task_type || 'sync', task.backup_config_id || 0, task.file_backup_config_id || 0, task.backup_dir || '', task.keep_days || 7, id];
  if (ids !== undefined) {
    sql = "UPDATE sync_tasks SET name=?, sync_config_id=?, sync_config_ids=?, type=?, interval_value=?, interval_unit=?, cron_expr=?, scheduled_time=?, scheduled_days=?, enabled=?, sort_order=?, next_run_at=?, updated_at=datetime('now','localtime'), task_type=?, backup_config_id=?, file_backup_config_id=?, backup_dir=?, keep_days=? WHERE id=?";
    params = [task.name, task.sync_config_id, ids, task.type, task.interval_value, task.interval_unit, task.cron_expr, task.scheduled_time, task.scheduled_days, task.enabled, task.sort_order || 0, nextRun || '', task.task_type || 'sync', task.backup_config_id || 0, task.file_backup_config_id || 0, task.backup_dir || '', task.keep_days || 7, id];
  }
  db.prepare(sql).run(...params);
}

export async function deleteSyncTask(id: number): Promise<void> {
  await initDb();
  db.prepare('DELETE FROM sync_tasks WHERE id=?').run(id);
}

export async function updateTaskRunTime(id: number, nextRunAt: string): Promise<void> {
  await initDb();
  db.prepare("UPDATE sync_tasks SET last_run_at=datetime('now','localtime'), next_run_at=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(nextRunAt, id);
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

function rowToExecLog(row: Record<string, any>): TaskExecutionLog {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
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
  const params: any[] = [];
  if (taskId) { sql += ' WHERE task_id=?'; params.push(taskId); }
  sql += ' ORDER BY id DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToExecLog);
}

export async function createTaskExecutionLog(log: {
  task_id: number; task_name: string; sync_config_id: number; sync_config_name: string;
  target_table: string; task_type?: string; status: string;
}): Promise<number> {
  await initDb();
  const info = db.prepare(
    "INSERT INTO task_execution_logs (task_id, task_name, sync_config_id, sync_config_name, target_table, task_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))"
  ).run(log.task_id, log.task_name, log.sync_config_id, log.sync_config_name, log.target_table, log.task_type || 'sync', log.status);
  return Number(info.lastInsertRowid);
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
  db.prepare("UPDATE task_execution_logs SET " + sets.join(',') + " WHERE id=?").run(...params);
}
export async function deleteTaskExecutionLog(id: number): Promise<void> {
  await initDb();
  db.prepare('DELETE FROM task_execution_logs WHERE id=?').run(id);
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
  if (all || categories.includes('file_backup_configs')) {
    result.file_backup_configs = await listFileBackupConfigs();
  }
  if (all || categories.includes('notify')) {
    const notify = await getEmailNotifyConfig();
    result.notify = notify ? {
      smtp_host: notify.smtp_host, smtp_port: notify.smtp_port, smtp_secure: notify.smtp_secure,
      smtp_user: notify.smtp_user, smtp_password: notify.smtp_password, from_email: notify.from_email,
      recipients: notify.recipients, notify_backup_fail: notify.notify_backup_fail,
      notify_sync_fail: notify.notify_sync_fail, notify_crash: notify.notify_crash,
      notify_file_backup_fail: notify.notify_file_backup_fail,
      throttle_minutes: notify.throttle_minutes, crash_throttle_minutes: notify.crash_throttle_minutes,
    } : {};
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
  if (all || categories.includes('file_backup_configs')) tables.push('file_backup_configs');
  if (all || categories.includes('file_backup_logs')) tables.push('file_backup_logs');
  if (all || categories.includes('task_logs')) tables.push('task_execution_logs');

  for (const t of tables) {
    db.prepare('DELETE FROM ' + t).run();
  }

  // 清空 token 配置（重置为空）
  if (all || categories.includes('token')) {
    const row = db.prepare('SELECT id FROM configs LIMIT 1').get() as any;
    if (row) {
      db.prepare("UPDATE configs SET key='', secret='', token_url='', data_api_url='', access_token='', updated_at=datetime('now','localtime') WHERE id=?").run(row.id);
    }
  }
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
        db.prepare("UPDATE configs SET key=?, secret=?, token_url=?, data_api_url=?, updated_at=datetime('now','localtime') WHERE id=?")
          .run(data.token.key || '', data.token.secret || '', data.token.token_url || '', data.token.data_api_url || '', cfg.id);
        imported.push('token');
      }
    } catch (e: any) { errors.push('token: ' + e.message); }
  }

  // 导入 PG 数据源
  if ((all || categories.includes('pg_sources')) && Array.isArray(data.pg_sources)) {
    for (const ds of data.pg_sources) {
      try {
        if (ds.id) db.prepare('DELETE FROM pg_datasources WHERE id=?').run(ds.id);
        db.prepare('INSERT INTO pg_datasources (id, name, host, port, user, password, database, schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ds.id ?? null, ds.name || '', ds.host || '', ds.port || '5432', ds.user || '', ds.password || '', ds.database || '', ds.schema || 'public', ds.created_at || '', ds.updated_at || '');
      } catch (e: any) { errors.push('pg_sources:' + (ds.name || ds.id) + ' - ' + e.message); }
    }
    imported.push('pg_sources');
  }

  // 导入远程表配置
  if ((all || categories.includes('remote_tables')) && Array.isArray(data.remote_tables)) {
    for (const t of data.remote_tables) {
      try {
        if (t.id) db.prepare('DELETE FROM remote_tables WHERE id=?').run(t.id);
        db.prepare('INSERT INTO remote_tables (id, name, data_api_url, conditions, logic, page, per_page, order_field, order_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(t.id ?? null, t.name || '', t.data_api_url || '', t.conditions || '[]', t.logic || 'and', t.page || 1, t.per_page || 20, t.order_field || '', t.order_dir || 'asc', t.created_at || '', t.updated_at || '');
      } catch (e: any) { errors.push('remote_tables:' + (t.name || t.id) + ' - ' + e.message); }
    }
    imported.push('remote_tables');
  }

  // 导入同步配置
  if ((all || categories.includes('sync_configs')) && Array.isArray(data.sync_configs)) {
    for (const cfg of data.sync_configs) {
      try {
        if (cfg.id) db.prepare('DELETE FROM sync_configs WHERE id=?').run(cfg.id);
        db.prepare('INSERT INTO sync_configs (id, name, remote_table_id, pg_source_id, target_database, target_table, target_pk, import_settings, page, per_page, all_import, conditions, logic, order_field, order_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(cfg.id ?? null, cfg.name || '', cfg.remote_table_id || 0, cfg.pg_source_id || 0, cfg.target_database || '', cfg.target_table || '', cfg.target_pk || '', cfg.import_settings || '[]', cfg.page || 1, cfg.per_page || 200, cfg.all_import || 0, cfg.conditions || '[]', cfg.logic || 'and', cfg.order_field || '', cfg.order_dir || 'asc', cfg.created_at || '', cfg.updated_at || '');
      } catch (e: any) { errors.push('sync_configs:' + (cfg.name || cfg.id) + ' - ' + e.message); }
    }
    imported.push('sync_configs');
  }

  // 导入定时任务
  if ((all || categories.includes('sync_tasks')) && Array.isArray(data.sync_tasks)) {
    for (const task of data.sync_tasks) {
      try {
        if (task.id) db.prepare('DELETE FROM sync_tasks WHERE id=?').run(task.id);
        db.prepare("INSERT INTO sync_tasks (id, name, sync_config_id, sync_config_ids, type, interval_value, interval_unit, cron_expr, scheduled_time, scheduled_days, enabled, sort_order, last_run_at, next_run_at, created_at, updated_at, task_type, backup_config_id, backup_dir, keep_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(task.id ?? null, task.name || '', task.sync_config_id || 0, task.sync_config_ids || '[]', task.type || 'interval', task.interval_value || 0, task.interval_unit || 'minutes', task.cron_expr || '', task.scheduled_time || '', task.scheduled_days || '', task.enabled !== undefined ? task.enabled : 1, task.sort_order || 0, task.last_run_at || '', task.next_run_at || '', task.created_at || '', task.updated_at || '', task.task_type || 'sync', task.backup_config_id || 0, task.backup_dir || '', task.keep_days || 7);
      } catch (e: any) { errors.push('sync_tasks:' + (task.name || task.id) + ' - ' + e.message); }
    }
    imported.push('sync_tasks');
  }

  // 导入备份配置
  if ((all || categories.includes('backup_configs')) && Array.isArray(data.backup_configs)) {
    for (const cfg of data.backup_configs) {
      try {
        if (cfg.id) db.prepare('DELETE FROM backup_configs WHERE id=?').run(cfg.id);
        db.prepare("INSERT INTO backup_configs (id, name, pg_source_id, database_name, backup_dir, keep_days, backup_format, enabled, type, interval_value, interval_unit, scheduled_time, next_run_at, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(cfg.id ?? null, cfg.name || '', cfg.pg_source_id || 0, cfg.database_name || '', cfg.backup_dir || '', cfg.keep_days || 180, cfg.backup_format || 'sql', cfg.enabled !== undefined ? cfg.enabled : 1, cfg.type || 'interval', cfg.interval_value || 0, cfg.interval_unit || 'hours', cfg.scheduled_time || '', cfg.next_run_at || '', cfg.last_run_at || '', cfg.created_at || '', cfg.updated_at || '');
      } catch (e: any) { errors.push('backup_configs:' + (cfg.name || cfg.id) + ' - ' + e.message); }
    }
    imported.push('backup_configs');
  }

  // 导入文件备份配置
  if ((all || categories.includes('file_backup_configs')) && Array.isArray(data.file_backup_configs)) {
    for (const cfg of data.file_backup_configs) {
      try {
        if (cfg.id) db.prepare('DELETE FROM file_backup_configs WHERE id=?').run(cfg.id);
        db.prepare("INSERT INTO file_backup_configs (id, name, ssh_host, ssh_port, ssh_user, auth_type, ssh_key_path, ssh_password, remote_dir, local_dir, exclude_patterns, keep_days, enabled, last_run_at, last_snapshot_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(cfg.id ?? null, cfg.name || '', cfg.ssh_host || '', cfg.ssh_port || '22', cfg.ssh_user || '', cfg.auth_type || 'key', cfg.ssh_key_path || '', cfg.ssh_password || '', cfg.remote_dir || '', cfg.local_dir || '', cfg.exclude_patterns || '[]', cfg.keep_days || 30, cfg.enabled !== undefined ? cfg.enabled : 1, cfg.last_run_at || '', cfg.last_snapshot_dir || '', cfg.created_at || '', cfg.updated_at || '');
      } catch (e: any) { errors.push('file_backup_configs:' + (cfg.name || cfg.id) + ' - ' + e.message); }
    }
    imported.push('file_backup_configs');
  }

  // 导入邮件告警配置
  if ((all || categories.includes('notify')) && data.notify) {
    try {
      await upsertEmailNotifyConfig(data.notify);
      imported.push('notify');
    } catch (e: any) { errors.push('notify: ' + e.message); }
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

function rowToBackupConfig(row: Record<string, any>): BackupConfig {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
  };
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
  const rows = db.prepare('SELECT * FROM backup_configs ORDER BY id ASC').all() as any[];
  return rows.map(rowToBackupConfig);
}

export async function listBackupConfigsNames(): Promise<{ id: number; name: string }[]> {
  await initDb();
  const rows = db.prepare('SELECT id, name FROM backup_configs ORDER BY id ASC').all() as any[];
  return rows.map(r => ({ id: Number(r.id), name: String(r.name) }));
}

export async function getBackupConfig(id: number): Promise<BackupConfig | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM backup_configs WHERE id=?').get(id) as any;
  return row ? rowToBackupConfig(row) : undefined;
}

export async function createBackupConfig(cfg: {
  name: string; pg_source_id: number; database_name: string; backup_dir: string;
  keep_days: number; backup_format?: string; enabled: number; type: string; interval_value: number;
  interval_unit: string; scheduled_time: string;
}): Promise<number> {
  await initDb();
  const info = db.prepare(
    "INSERT INTO backup_configs (name, pg_source_id, database_name, backup_dir, keep_days, backup_format, enabled, type, interval_value, interval_unit, scheduled_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(cfg.name, cfg.pg_source_id, cfg.database_name, cfg.backup_dir, cfg.keep_days, cfg.backup_format || 'sql', cfg.enabled, cfg.type, cfg.interval_value, cfg.interval_unit, cfg.scheduled_time);
  const id = Number(info.lastInsertRowid);
  // 计算下次执行时间
  const next = calcBackupNextRun(cfg);
  if (next) { db.prepare("UPDATE backup_configs SET next_run_at=? WHERE id=?").run(next, id); }
  return id;
}

export async function updateBackupConfig(id: number, cfg: {
  name: string; pg_source_id: number; database_name: string; backup_dir: string;
  keep_days: number; backup_format?: string; enabled: number; type: string; interval_value: number;
  interval_unit: string; scheduled_time: string;
}): Promise<void> {
  await initDb();
  const next = calcBackupNextRun(cfg);
  db.prepare(
    "UPDATE backup_configs SET name=?, pg_source_id=?, database_name=?, backup_dir=?, keep_days=?, backup_format=?, enabled=?, type=?, interval_value=?, interval_unit=?, scheduled_time=?, next_run_at=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(cfg.name, cfg.pg_source_id, cfg.database_name, cfg.backup_dir, cfg.keep_days, cfg.backup_format || 'sql', cfg.enabled, cfg.type, cfg.interval_value, cfg.interval_unit, cfg.scheduled_time, next || '', id);
}

export async function deleteBackupConfig(id: number): Promise<void> {
  await initDb();
  db.prepare('DELETE FROM backup_configs WHERE id=?').run(id);
}

export async function updateBackupRunTime(id: number, nextRunAt: string): Promise<void> {
  await initDb();
  db.prepare("UPDATE backup_configs SET last_run_at=datetime('now','localtime'), next_run_at=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(nextRunAt, id);
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

function rowToBackupLog(row: Record<string, any>): BackupLog {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
  };
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
  let sql = 'SELECT * FROM backup_logs';
  const params: any[] = [];
  if (configId) { sql += ' WHERE config_id=?'; params.push(configId); }
  sql += ' ORDER BY id DESC LIMIT 50';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToBackupLog);
}

export async function getBackupLog(id: number): Promise<BackupLog | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM backup_logs WHERE id=?').get(id) as any;
  return row ? rowToBackupLog(row) : undefined;
}

export async function createBackupLog(log: { config_id: number; config_name: string; database_name: string; status: string }): Promise<number> {
  await initDb();
  const info = db.prepare(
    "INSERT INTO backup_logs (config_id, config_name, database_name, status, started_at) VALUES (?,?,?,?,datetime('now','localtime'))"
  ).run(log.config_id, log.config_name, log.database_name, log.status);
  return Number(info.lastInsertRowid);
}

export async function deleteBackupLogs(ids: number[]): Promise<void> {
  await initDb();
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM backup_logs WHERE id IN (${placeholders})`).run(...ids);
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
  db.prepare("UPDATE backup_logs SET " + sets.join(',') + " WHERE id=?").run(...params);
}

// ========== 文件备份配置 CRUD(远程目录每日快照) ==========

export interface FileBackupConfig {
  id: number;
  name: string;
  ssh_host: string;
  ssh_port: string;
  ssh_user: string;
  auth_type: string;
  ssh_key_path: string;
  ssh_password: string;
  remote_dir: string;
  local_dir: string;
  exclude_patterns: string;
  keep_days: number;
  enabled: number;
  last_run_at: string;
  last_snapshot_dir: string;
  created_at: string;
  updated_at: string;
}

function rowToFileBackupConfig(row: Record<string, any>): FileBackupConfig {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
  };
  return {
    id: Number(get('id')) || 0, name: String(get('name')),
    ssh_host: String(get('ssh_host')), ssh_port: String(get('ssh_port')) || '22',
    ssh_user: String(get('ssh_user')), auth_type: String(get('auth_type')) || 'key',
    ssh_key_path: String(get('ssh_key_path')), ssh_password: String(get('ssh_password')),
    remote_dir: String(get('remote_dir')), local_dir: String(get('local_dir')),
    exclude_patterns: String(get('exclude_patterns')) || '[]',
    keep_days: Number(get('keep_days')) || 30,
    enabled: (() => { const v = get('enabled'); return v !== '' && v !== null && v !== undefined ? Number(v) : 1; })(),
    last_run_at: String(get('last_run_at')), last_snapshot_dir: String(get('last_snapshot_dir')),
    created_at: String(get('created_at')), updated_at: String(get('updated_at')),
  };
}

export async function listFileBackupConfigs(): Promise<FileBackupConfig[]> {
  await initDb();
  const rows = db.prepare('SELECT * FROM file_backup_configs ORDER BY id ASC').all() as any[];
  return rows.map(rowToFileBackupConfig);
}

export async function listFileBackupConfigsNames(): Promise<{ id: number; name: string }[]> {
  await initDb();
  const rows = db.prepare('SELECT id, name FROM file_backup_configs ORDER BY id ASC').all() as any[];
  return rows.map(r => ({ id: Number(r.id), name: String(r.name) }));
}

export async function getFileBackupConfig(id: number): Promise<FileBackupConfig | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM file_backup_configs WHERE id=?').get(id) as any;
  return row ? rowToFileBackupConfig(row) : undefined;
}

export async function createFileBackupConfig(cfg: {
  name: string; ssh_host: string; ssh_port: string; ssh_user: string; auth_type: string;
  ssh_key_path: string; ssh_password: string; remote_dir: string; local_dir: string;
  exclude_patterns: string; keep_days: number; enabled: number;
}): Promise<number> {
  await initDb();
  const info = db.prepare(
    "INSERT INTO file_backup_configs (name, ssh_host, ssh_port, ssh_user, auth_type, ssh_key_path, ssh_password, remote_dir, local_dir, exclude_patterns, keep_days, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(cfg.name, cfg.ssh_host, cfg.ssh_port || '22', cfg.ssh_user, cfg.auth_type || 'key', cfg.ssh_key_path, cfg.ssh_password, cfg.remote_dir, cfg.local_dir, cfg.exclude_patterns || '[]', cfg.keep_days, cfg.enabled);
  return Number(info.lastInsertRowid);
}

export async function updateFileBackupConfig(id: number, cfg: {
  name: string; ssh_host: string; ssh_port: string; ssh_user: string; auth_type: string;
  ssh_key_path: string; ssh_password: string; remote_dir: string; local_dir: string;
  exclude_patterns: string; keep_days: number; enabled: number;
}): Promise<void> {
  await initDb();
  db.prepare(
    "UPDATE file_backup_configs SET name=?, ssh_host=?, ssh_port=?, ssh_user=?, auth_type=?, ssh_key_path=?, ssh_password=?, remote_dir=?, local_dir=?, exclude_patterns=?, keep_days=?, enabled=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(cfg.name, cfg.ssh_host, cfg.ssh_port || '22', cfg.ssh_user, cfg.auth_type || 'key', cfg.ssh_key_path, cfg.ssh_password, cfg.remote_dir, cfg.local_dir, cfg.exclude_patterns || '[]', cfg.keep_days, cfg.enabled, id);
}

export async function deleteFileBackupConfig(id: number): Promise<void> {
  await initDb();
  db.prepare('DELETE FROM file_backup_configs WHERE id=?').run(id);
}

export async function updateFileBackupRunTime(id: number, snapshotDir: string): Promise<void> {
  await initDb();
  db.prepare("UPDATE file_backup_configs SET last_run_at=datetime('now','localtime'), last_snapshot_dir=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(snapshotDir, id);
}

// ========== 文件备份日志 CRUD ==========

export interface FileBackupLog {
  id: number; config_id: number; config_name: string;
  remote_dir: string; local_dir: string; snapshot_dir: string;
  status: string; total_files: number; transferred_files: number; transferred_bytes: number;
  error_message: string; started_at: string; finished_at: string; created_at: string;
}

function rowToFileBackupLog(row: Record<string, any>): FileBackupLog {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
  };
  return {
    id: Number(get('id')) || 0, config_id: Number(get('config_id')) || 0,
    config_name: String(get('config_name')),
    remote_dir: String(get('remote_dir')), local_dir: String(get('local_dir')),
    snapshot_dir: String(get('snapshot_dir')),
    status: String(get('status')) || 'pending',
    total_files: Number(get('total_files')) || 0,
    transferred_files: Number(get('transferred_files')) || 0,
    transferred_bytes: Number(get('transferred_bytes')) || 0,
    error_message: String(get('error_message')),
    started_at: String(get('started_at')), finished_at: String(get('finished_at')),
    created_at: String(get('created_at')),
  };
}

export async function listFileBackupLogs(configId?: number): Promise<FileBackupLog[]> {
  await initDb();
  let sql = 'SELECT * FROM file_backup_logs';
  const params: any[] = [];
  if (configId) { sql += ' WHERE config_id=?'; params.push(configId); }
  sql += ' ORDER BY id DESC LIMIT 50';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToFileBackupLog);
}

export async function createFileBackupLog(log: {
  config_id: number; config_name: string; remote_dir: string; local_dir: string; status: string;
}): Promise<number> {
  await initDb();
  const info = db.prepare(
    "INSERT INTO file_backup_logs (config_id, config_name, remote_dir, local_dir, status, started_at) VALUES (?,?,?,?,?,datetime('now','localtime'))"
  ).run(log.config_id, log.config_name, log.remote_dir, log.local_dir, log.status);
  return Number(info.lastInsertRowid);
}

export async function updateFileBackupLog(id: number, data: {
  status?: string; snapshot_dir?: string; total_files?: number;
  transferred_files?: number; transferred_bytes?: number; error_message?: string;
}): Promise<void> {
  await initDb();
  const sets: string[] = ["finished_at=datetime('now','localtime')"];
  const params: any[] = [];
  if (data.status !== undefined) { sets.push('status=?'); params.push(data.status); }
  if (data.snapshot_dir !== undefined) { sets.push('snapshot_dir=?'); params.push(data.snapshot_dir); }
  if (data.total_files !== undefined) { sets.push('total_files=?'); params.push(data.total_files); }
  if (data.transferred_files !== undefined) { sets.push('transferred_files=?'); params.push(data.transferred_files); }
  if (data.transferred_bytes !== undefined) { sets.push('transferred_bytes=?'); params.push(data.transferred_bytes); }
  if (data.error_message !== undefined) { sets.push('error_message=?'); params.push(data.error_message); }
  params.push(id);
  db.prepare("UPDATE file_backup_logs SET " + sets.join(',') + " WHERE id=?").run(...params);
}

export async function deleteFileBackupLogs(ids: number[]): Promise<void> {
  await initDb();
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM file_backup_logs WHERE id IN (${placeholders})`).run(...ids);
}

// ========== 邮件告警配置 ==========

export interface EmailNotifyConfig {
  id: number;
  smtp_host: string;
  smtp_port: string;
  smtp_secure: number;
  smtp_user: string;
  smtp_password: string;
  from_email: string;
  recipients: string;
  notify_backup_fail: number;
  notify_sync_fail: number;
  notify_crash: number;
  notify_file_backup_fail: number;
  throttle_minutes: number;
  crash_throttle_minutes: number;
  last_crash_notify_at: string;
  created_at: string;
  updated_at: string;
}

function rowToEmailNotifyConfig(row: Record<string, any>): EmailNotifyConfig {
  const get = (name: string): any => {
    const v = row[name];
    return v === undefined || v === null ? '' : v;
  };
  return {
    id: Number(get('id')) || 0,
    smtp_host: String(get('smtp_host')),
    smtp_port: String(get('smtp_port')) || '465',
    smtp_secure: get('smtp_secure') !== '' ? (Number(get('smtp_secure')) ? 1 : 0) : 1,
    smtp_user: String(get('smtp_user')),
    smtp_password: String(get('smtp_password')),
    from_email: String(get('from_email')),
    recipients: String(get('recipients')),
    notify_backup_fail: (() => { const v = get('notify_backup_fail'); return v === '' ? 1 : (Number(v) ? 1 : 0); })(),
    notify_sync_fail: (() => { const v = get('notify_sync_fail'); return v === '' ? 1 : (Number(v) ? 1 : 0); })(),
    notify_crash: (() => { const v = get('notify_crash'); return v === '' ? 1 : (Number(v) ? 1 : 0); })(),
    notify_file_backup_fail: (() => { const v = get('notify_file_backup_fail'); return v === '' ? 1 : (Number(v) ? 1 : 0); })(),
    throttle_minutes: Number(get('throttle_minutes')) || 30,
    crash_throttle_minutes: Number(get('crash_throttle_minutes')) || 10,
    last_crash_notify_at: String(get('last_crash_notify_at')),
    created_at: String(get('created_at')),
    updated_at: String(get('updated_at')),
  };
}

export async function getEmailNotifyConfig(): Promise<EmailNotifyConfig | undefined> {
  await initDb();
  const row = db.prepare('SELECT * FROM email_notify_config LIMIT 1').get() as any;
  return row ? rowToEmailNotifyConfig(row) : undefined;
}

export async function upsertEmailNotifyConfig(cfg: {
  smtp_host?: string; smtp_port?: string | number; smtp_secure?: number | boolean;
  smtp_user?: string; smtp_password?: string; from_email?: string; recipients?: string;
  notify_backup_fail?: number | boolean; notify_sync_fail?: number | boolean; notify_crash?: number | boolean;
  notify_file_backup_fail?: number | boolean;
  throttle_minutes?: number; crash_throttle_minutes?: number;
}): Promise<void> {
  await initDb();
  const row = db.prepare('SELECT id FROM email_notify_config LIMIT 1').get() as any;
  const clampMinutes = (v: any, def: number) => {
    const n = Math.floor(Number(v));
    if (!n || n < 1) return def;
    return Math.min(n, 1440);
  };
  const values = {
    smtp_host: cfg.smtp_host || '',
    smtp_port: String(cfg.smtp_port ?? 465) || '465',
    smtp_secure: cfg.smtp_secure !== undefined ? (cfg.smtp_secure ? 1 : 0) : 1,
    smtp_user: cfg.smtp_user || '',
    smtp_password: cfg.smtp_password || '',
    from_email: cfg.from_email || '',
    recipients: cfg.recipients || '',
    notify_backup_fail: cfg.notify_backup_fail !== undefined ? (cfg.notify_backup_fail ? 1 : 0) : 1,
    notify_sync_fail: cfg.notify_sync_fail !== undefined ? (cfg.notify_sync_fail ? 1 : 0) : 1,
    notify_crash: cfg.notify_crash !== undefined ? (cfg.notify_crash ? 1 : 0) : 1,
    notify_file_backup_fail: cfg.notify_file_backup_fail !== undefined ? (cfg.notify_file_backup_fail ? 1 : 0) : 1,
    throttle_minutes: clampMinutes(cfg.throttle_minutes, 30),
    crash_throttle_minutes: clampMinutes(cfg.crash_throttle_minutes, 10),
  };
  if (row) {
    db.prepare(
      "UPDATE email_notify_config SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_password=?, from_email=?, recipients=?, notify_backup_fail=?, notify_sync_fail=?, notify_crash=?, notify_file_backup_fail=?, throttle_minutes=?, crash_throttle_minutes=?, updated_at=datetime('now','localtime') WHERE id=?"
    ).run(values.smtp_host, values.smtp_port, values.smtp_secure, values.smtp_user, values.smtp_password,
      values.from_email, values.recipients, values.notify_backup_fail, values.notify_sync_fail, values.notify_crash,
      values.notify_file_backup_fail, values.throttle_minutes, values.crash_throttle_minutes, row.id);
  } else {
    db.prepare(
      'INSERT INTO email_notify_config (smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_email, recipients, notify_backup_fail, notify_sync_fail, notify_crash, notify_file_backup_fail, throttle_minutes, crash_throttle_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(values.smtp_host, values.smtp_port, values.smtp_secure, values.smtp_user, values.smtp_password,
      values.from_email, values.recipients, values.notify_backup_fail, values.notify_sync_fail, values.notify_crash,
      values.notify_file_backup_fail, values.throttle_minutes, values.crash_throttle_minutes);
  }
}

export async function updateLastCrashNotifyAt(): Promise<void> {
  await initDb();
  db.prepare("UPDATE email_notify_config SET last_crash_notify_at=datetime('now','localtime')").run();
}

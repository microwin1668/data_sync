import { Pool } from 'pg';
import { listPgDatasources } from '../db/sqlite';
import { saveFailedRecords } from '../utils/logUtils';

export interface ExcelImportMapping {
  sourceField: string;
  targetField: string;
  isPk?: boolean;
}

export interface ExcelImportRequest {
  pg_source_id: number;
  target_table: string;
  rows: Record<string, any>[];
  mappings: ExcelImportMapping[];
  batch_size?: number;
}

interface TargetColumn {
  name: string;
  type: string;
  comment: string;
  isNullable: boolean;
  defaultValue: string | null;
}

function quoteIdent(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function cleanIdentifier(value: string): string {
  return String(value || '').trim();
}

async function getPgSource(id: number) {
  const sources = await listPgDatasources();
  return sources.find(s => s.id === id);
}

async function listTargetColumns(pool: Pool, schema: string, tableName: string): Promise<TargetColumn[]> {
  const result = await pool.query(
    'SELECT c.column_name as name, c.udt_name as type, c.is_nullable, c.column_default, ' +
    'col_description(cls.oid, c.ordinal_position) as comment ' +
    'FROM information_schema.columns c ' +
    'JOIN pg_namespace n ON n.nspname=c.table_schema ' +
    'JOIN pg_class cls ON cls.relname=c.table_name AND cls.relnamespace=n.oid ' +
    'WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position',
    [schema, tableName]
  );
  return result.rows.map((row: any) => ({
    name: row.name,
    type: row.type,
    comment: row.comment || '',
    isNullable: row.is_nullable === 'YES',
    defaultValue: row.column_default || null,
  }));
}

function coerceValue(value: any): any {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

function buildRecord(row: Record<string, any>, mappings: ExcelImportMapping[]): Record<string, any> {
  const record: Record<string, any> = {};
  for (const mapping of mappings) {
    record[mapping.targetField] = coerceValue(row[mapping.sourceField]);
  }
  return record;
}

export async function executeExcelImport(payload: ExcelImportRequest) {
  const pgSource = await getPgSource(Number(payload.pg_source_id));
  if (!pgSource) return { success: false, message: '未找到 PG 数据源' };

  const tableName = cleanIdentifier(payload.target_table);
  const schema = cleanIdentifier(pgSource.schema || 'public') || 'public';
  if (!tableName) return { success: false, message: '请选择目标表' };

  const mappings = (payload.mappings || [])
    .map(m => ({
      sourceField: cleanIdentifier(m.sourceField),
      targetField: cleanIdentifier(m.targetField),
      isPk: !!m.isPk,
    }))
    .filter(m => m.sourceField && m.targetField);

  if (mappings.length === 0) return { success: false, message: '请至少配置一个字段映射' };
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return { success: false, message: 'Excel 中没有可导入的数据' };
  }

  const pool = new Pool({
    host: pgSource.host,
    port: parseInt(pgSource.port || '5432'),
    user: pgSource.user,
    password: pgSource.password,
    database: pgSource.database,
    connectionTimeoutMillis: 5000,
  });

  const failedRecords: { data: Record<string, any>; reason: string }[] = [];
  const errors: string[] = [];
  let successCount = 0;
  let errorCount = 0;

  try {
    const columns = await listTargetColumns(pool, schema, tableName);
    if (columns.length === 0) return { success: false, message: `目标表不存在或没有字段: ${schema}.${tableName}` };

    const targetColumnSet = new Set(columns.map(c => c.name));
    const invalidTargets = mappings.map(m => m.targetField).filter(field => !targetColumnSet.has(field));
    if (invalidTargets.length > 0) {
      return { success: false, message: '目标字段不存在: ' + Array.from(new Set(invalidTargets)).join(', ') };
    }

    const colNames = mappings.map(m => m.targetField);
    const pkFields = mappings.filter(m => m.isPk).map(m => m.targetField);
    const conflictClause = pkFields.length > 0 ? pkFields.map(quoteIdent).join(',') : '';
    const updateFields = colNames.filter(c => !pkFields.includes(c));
    const tableRef = `${quoteIdent(schema)}.${quoteIdent(tableName)}`;
    const batchSize = Math.min(Math.max(Number(payload.batch_size) || 200, 1), 1000);

    for (let start = 0; start < payload.rows.length; start += batchSize) {
      const batch = payload.rows.slice(start, start + batchSize);
      for (let i = 0; i < batch.length; i++) {
        const sourceRow = batch[i] || {};
        const record = buildRecord(sourceRow, mappings);
        try {
          const values = colNames.map(name => record[name]);
          const placeholders = values.map((_, idx) => '$' + (idx + 1));
          let sql = `INSERT INTO ${tableRef} (${colNames.map(quoteIdent).join(',')}) VALUES (${placeholders.join(',')})`;

          if (conflictClause) {
            if (updateFields.length > 0) {
              sql += ` ON CONFLICT (${conflictClause}) DO UPDATE SET ` +
                updateFields.map(field => `${quoteIdent(field)} = EXCLUDED.${quoteIdent(field)}`).join(',');
            } else {
              sql += ` ON CONFLICT (${conflictClause}) DO NOTHING`;
            }
          }

          await pool.query(sql, values);
          successCount++;
        } catch (err: any) {
          errorCount++;
          const reason = err.message || String(err);
          if (failedRecords.length < 200) failedRecords.push({ data: record, reason });
          if (errors.length < 5) errors.push(`第 ${start + i + 1} 行: ${reason}`);
        }
      }
    }

    const logFilename = failedRecords.length > 0 ? saveFailedRecords(tableName, failedRecords) : '';
    return {
      success: true,
      message: `导入完成: ${successCount} 成功, ${errorCount} 失败`,
      data: {
        total: payload.rows.length,
        success: successCount,
        error: errorCount,
        failedRecords,
        logFilename,
        errors,
      },
    };
  } catch (err: any) {
    return { success: false, message: err.message || String(err) };
  } finally {
    await pool.end();
  }
}

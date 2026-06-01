import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(__dirname, '../../logs');

// 确保日志目录存在
export function ensureLogDir(): string {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  return LOG_DIR;
}

/**
 * 保存导入失败的记录到 CSV 文件
 * @param tableName 目标表名
 * @param failedRecords 失败记录列表 [{data: {...}, reason: string}]
 * @returns 日志文件名（相对路径）
 */
export function saveFailedRecords(
  tableName: string,
  failedRecords: { data: Record<string, any>; reason: string }[]
): string {
  if (failedRecords.length === 0) return '';

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const safeTable = tableName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
  const filename = `${dateStr}_${timeStr}_${safeTable}_failed.csv`;
  const filepath = path.join(ensureLogDir(), filename);

  // 收集所有字段名
  const fieldSet = new Set<string>();
  for (const r of failedRecords) {
    if (r.data) {
      Object.keys(r.data).forEach(k => fieldSet.add(k));
    }
  }
  const fields = Array.from(fieldSet);

  // 生成 CSV（UTF-8 BOM）
  let csv = '\ufeff';
  csv += [...fields, '失败原因'].join(',') + '\n';
  for (const r of failedRecords) {
    const vals = fields.map(f => {
      const v = r.data ? r.data[f] : undefined;
      const s = v === null || v === undefined ? '' : String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    });
    const reason = (r.reason || '').replace(/"/g, '""');
    csv += vals.join(',') + ',"' + reason + '"\n';
  }

  fs.writeFileSync(filepath, csv, 'utf-8');
  return filename;
}

/**
 * 获取日志文件的完整路径
 */
export function getLogFilePath(filename: string): string {
  const safe = path.basename(filename); // 防止路径穿越
  return path.join(LOG_DIR, safe);
}

/**
 * 检查日志文件是否存在
 */
export function logFileExists(filename: string): boolean {
  const fp = getLogFilePath(filename);
  return fs.existsSync(fp);
}

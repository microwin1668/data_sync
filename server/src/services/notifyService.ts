import nodemailer from 'nodemailer';
import { getEmailNotifyConfig, updateLastCrashNotifyAt } from '../db/sqlite';

// 任务失败告警的内存节流:key(type:taskKey) → 上次发送时间戳
const failureThrottleMap = new Map<string, number>();

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function splitRecipients(recipients: string): string[] {
  return String(recipients || '')
    .split(/[,;，；\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('发送超时(' + ms + 'ms)')), ms)),
  ]);
}

function buildHtml(title: string, fields: [string, string][], footer?: string): string {
  const rows = fields
    .map(([k, v]) => (
      '<tr>' +
      '<td style="padding:6px 12px;border:1px solid #e8e8e8;background:#fafafa;font-weight:bold;white-space:nowrap;">' + escapeHtml(k) + '</td>' +
      '<td style="padding:6px 12px;border:1px solid #e8e8e8;word-break:break-all;">' + escapeHtml(v || '-') + '</td>' +
      '</tr>'
    ))
    .join('');
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;max-width:640px;">' +
    '<h2 style="margin:0 0 16px;color:#cf1322;">' + escapeHtml(title) + '</h2>' +
    '<table style="border-collapse:collapse;font-size:14px;color:#333;">' + rows + '</table>' +
    (footer ? '<p style="margin:16px 0 0;color:#888;font-size:12px;">' + escapeHtml(footer) + '</p>' : '') +
    '</div>'
  );
}

/**
 * 用已保存的配置发送邮件(不检查开关、不节流,由调用方决定)
 * 配置不完整时抛错,由调用方捕获记录
 */
export async function sendNotifyMail(subject: string, html: string): Promise<void> {
  const cfg = await getEmailNotifyConfig();
  if (!cfg || !cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_password) {
    throw new Error('邮件告警未配置或 SMTP 信息不完整');
  }
  const to = splitRecipients(cfg.recipients);
  if (to.length === 0) {
    throw new Error('未设置收件人邮箱');
  }
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: Number(cfg.smtp_port) || 465,
    secure: !!cfg.smtp_secure,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_password },
  });
  try {
    await transporter.sendMail({
      from: cfg.from_email || cfg.smtp_user,
      to: to.join(', '),
      subject,
      html,
    });
  } finally {
    transporter.close();
  }
}

/**
 * 任务失败告警(备份/同步/文件备份),带可配置的节流(默认 30 分钟内同一 key 只发一封)
 * 内部捕获所有异常,不会向调用方抛错
 */
export async function notifyTaskFailure(
  type: 'backup' | 'sync' | 'file_backup',
  key: string,
  title: string,
  fields: [string, string][]
): Promise<void> {
  const typeLabel = type === 'backup' ? '备份' : type === 'file_backup' ? '文件备份' : '同步';
  try {
    const cfg = await getEmailNotifyConfig();
    if (!cfg) return;
    if (type === 'backup' && !cfg.notify_backup_fail) return;
    if (type === 'sync' && !cfg.notify_sync_fail) return;
    if (type === 'file_backup' && !cfg.notify_file_backup_fail) return;

    const throttleMs = (cfg.throttle_minutes || 30) * 60 * 1000;
    const throttleKey = type + ':' + key;
    const now = Date.now();
    const last = failureThrottleMap.get(throttleKey) || 0;
    if (now - last < throttleMs) {
      console.log(`[Notify] ${title} 处于告警节流期内(${cfg.throttle_minutes} 分钟),跳过`);
      return;
    }
    failureThrottleMap.set(throttleKey, now);

    await sendNotifyMail(
      `【数据同步告警】${title}`,
      buildHtml(title, [...fields, ['服务器时间', formatNow()]], '来自 data-sync 数据同步系统自动告警,同类告警在 ' + cfg.throttle_minutes + ' 分钟内不会重复发送。')
    );
    console.log(`[Notify] 已发送${typeLabel}失败告警邮件: ${title}`);
  } catch (err: any) {
    console.error('[Notify] 告警邮件发送失败:', err.message);
  }
}

/**
 * 进程崩溃告警,节流时间戳持久化到数据库(防止 pm2 重启风暴导致邮件刷屏)
 * 内部捕获所有异常,不会向调用方抛错
 */
export async function notifyCrash(err: any): Promise<void> {
  try {
    const cfg = await getEmailNotifyConfig();
    if (!cfg || !cfg.notify_crash) return;

    const throttleMs = (cfg.crash_throttle_minutes || 10) * 60 * 1000;
    if (cfg.last_crash_notify_at) {
      const last = new Date(cfg.last_crash_notify_at.replace(' ', 'T')).getTime();
      if (Date.now() - last < throttleMs) {
        console.log(`[Notify] 崩溃告警处于节流期内(${cfg.crash_throttle_minutes} 分钟),跳过`);
        return;
      }
    }
    // 先记录时间戳再发送:即使发送失败也不在窗口内重试,避免风暴
    await updateLastCrashNotifyAt();

    const message = err instanceof Error ? `${err.message}` : String(err);
    const stack = err instanceof Error ? (err.stack || '') : '';
    const detail = (message + '\n' + stack).slice(0, 2000);

    await withTimeout(
      sendNotifyMail(
        '【数据同步告警】服务进程崩溃',
        buildHtml('服务进程崩溃(未捕获异常)', [
          ['错误信息', detail],
          ['服务器时间', formatNow()],
        ], '进程即将退出,pm2 会自动重启;若持续收到此邮件请检查服务日志。崩溃告警在 ' + cfg.crash_throttle_minutes + ' 分钟内不会重复发送。')
      ),
      8000
    );
    console.log('[Notify] 已发送进程崩溃告警邮件');
  } catch (err2: any) {
    console.error('[Notify] 崩溃告警邮件发送失败:', err2.message);
  }
}

function formatNow(): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' ' +
    pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
}

import React, { useState, useEffect, useRef } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm,
  Tag, Typography, Badge, InputNumber, Alert, Progress, Spin, Tooltip,
} from 'antd';
import {
  LoadingOutlined, PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined,
  CloudServerOutlined, HistoryOutlined, DownloadOutlined, StopOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import {
  listBackupConfigs, createBackupConfig, updateBackupConfig, deleteBackupConfig,
  runBackupNow, listBackupLogs, deleteBackupLogs, listPgSources, checkPgDump, installPgTools,
  stopBackup, getBackupProgress, getInstallProgress,
} from '../api';
import type { BackupConfig, BackupLog, PgDatasource } from '../api';

const { Text } = Typography;

const BackupPage: React.FC = () => {
  const [configs, setConfigs] = useState<BackupConfig[]>([]);
  const [pgSources, setPgSources] = useState<PgDatasource[]>([]);
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [stoppingId, setStoppingId] = useState<number | null>(null);

  // 日志弹窗
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<BackupLog[]>([]);
  const [logConfigId, setLogConfigId] = useState<number | null>(null);
  const [isBackupRunning, setIsBackupRunning] = useState(false);
  const [logSelectedKeys, setLogSelectedKeys] = useState<number[]>([]);
  const [deletingLogs, setDeletingLogs] = useState(false);
  const logTimer = useRef<any>(null);
  const progressTimer = useRef<any>(null);

  // pg_dump 状态
  const [pgDumpStatus, setPgDumpStatus] = useState<{ installed: boolean; pgDump: boolean; pgRestore: boolean; path: string; version: string; compatible: boolean } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [installStatus, setInstallStatus] = useState('');
  const [manualInstallModal, setManualInstallModal] = useState(false);
  const [lastInstallError, setLastInstallError] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [keepDays, setKeepDays] = useState<number | null>(180);


  useEffect(() => {
    loadAll();
    checkPgDumpStatus();
    return () => {
      if (logTimer.current) clearInterval(logTimer.current);
      if (progressTimer.current) clearInterval(progressTimer.current);
    };
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfgRes, pgRes] = await Promise.all([listBackupConfigs(), listPgSources()]);
      if (cfgRes.success) setConfigs(cfgRes.data);
      if (pgRes.success) setPgSources(pgRes.data);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const checkPgDumpStatus = async () => {
    try {
      const res = await checkPgDump();
      if (res.success) setPgDumpStatus(res.data);
    } catch {}
  };

  const handleInstallPgTools = async () => {
    setInstalling(true);
    setInstallModalOpen(true);
    setInstallStatus('正在启动安装...');
    try {
      // 启动安装
      const startRes = await installPgTools();
      if (!startRes.success) {
        setLastInstallError(startRes.message || '安装失败');
        setInstallModalOpen(false);
        setManualInstallModal(true);
        return;
      }
      
      // 轮询进度
      let done = false;
      while (!done) {
        await new Promise(r => setTimeout(r, 1500));
        const progRes = await getInstallProgress();
        if (progRes.status === 'running') {
          setInstallStatus(progRes.message || '安装中...');
        } else if (progRes.status === 'success') {
          setInstallStatus('安装完成，正在刷新状态...');
          await checkPgDumpStatus();
          message.success('PostgreSQL 16 客户端安装成功');
          done = true;
        } else if (progRes.status === 'error') {
          setLastInstallError(progRes.message || '安装失败');
          setInstallModalOpen(false);
          setManualInstallModal(true);
          done = true;
        }
      }
    } catch (err: any) { 
      setLastInstallError(err.message || '');
      setManualInstallModal(true);
    }
    finally { setInstalling(false); setInstallModalOpen(false); }
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({ backup_format: 'sql', enabled: 1 });
    setKeepDays(180);
    setEditOpen(true);
  };

  const openEdit = (cfg: BackupConfig) => {
    setEditingId(cfg.id);
    form.setFieldsValue({
      name: cfg.name,
      pg_source_id: cfg.pg_source_id,
      database_name: cfg.database_name || '',
      backup_dir: cfg.backup_dir || '',
      backup_format: cfg.backup_format || 'sql',
      enabled: cfg.enabled === 1 || cfg.enabled === true,
    });
    setKeepDays(Number(cfg.keep_days));
    setEditOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload = {
        name: values.name, pg_source_id: values.pg_source_id,
        database_name: values.database_name || '', backup_dir: values.backup_dir || '',
        keep_days: keepDays || 7, backup_format: values.backup_format || 'sql',
        enabled: values.enabled !== undefined ? (values.enabled ? 1 : 0) : 1, type: 'daily', interval_value: 0,
        interval_unit: 'hours', scheduled_time: '02:00',
      };
      if (editingId) { await updateBackupConfig(editingId, payload); message.success('更新成功'); }
      else { await createBackupConfig(payload); message.success('创建成功'); }
      setEditOpen(false);
      loadAll();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + (err.message || ''));
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => { await deleteBackupConfig(id); message.success('已删除'); loadAll(); };

  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return;
    Modal.confirm({
      title: `确定删除选中的 ${selectedKeys.length} 条备份配置？`,
      content: '删除后无法恢复',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        let errCount = 0;
        for (const id of selectedKeys) {
          try { await deleteBackupConfig(id); } catch { errCount++; }
        }
        if (errCount > 0) message.warning(`已删除 ${selectedKeys.length - errCount} 条，${errCount} 条失败`);
        else message.success(`成功删除 ${selectedKeys.length} 条备份配置`);
        setSelectedKeys([]);
        loadAll();
      },
    });
  };

  const handleRun = async (id: number) => {
    setRunningId(id);
    try {
      const res = await runBackupNow(id);
      if (res.success) message.success(res.message);
      else message.error(res.message);
      setRunningId(null);
      loadAll();
    } catch (err: any) { message.error('执行失败: ' + err.message); setRunningId(null); }
  };

  const handleStop = async (configId: number) => {
    setStoppingId(configId);
    try {
      const res = await stopBackup(configId);
      if (res.success) message.success(res.message);
      else message.error(res.message);
      closeLogs();
      loadAll();
    } catch (err: any) { message.error('停止失败: ' + err.message); }
    finally { setStoppingId(null); }
  };

  const checkRunningBackup = async (configId: number) => {
    try {
      const res = await getBackupProgress(configId);
      if (res.success && res.data?.status === 'running') {
        setIsBackupRunning(true);
        return true;
      }
    } catch {}
    setIsBackupRunning(false);
    return false;
  };

  const showLogs = async (configId: number) => {
    setLogConfigId(configId);
    setLogOpen(true);
    setIsBackupRunning(false);

    // 立即检查是否有正在运行的备份
    await checkRunningBackup(configId);

    // 加载日志（无 loading 状态）
    loadLogs(configId).catch(() => {});

    // 轮询日志
    if (logTimer.current) clearInterval(logTimer.current);
    logTimer.current = setInterval(async () => {
      await loadLogs(configId);
    }, 3000);

    // 轮询运行状态
    if (progressTimer.current) clearInterval(progressTimer.current);
    progressTimer.current = setInterval(async () => {
      await checkRunningBackup(configId);
    }, 2000);
  };

  const loadLogs = async (configId: number) => {
    try {
      const res = await listBackupLogs(configId);
      if (res.success) setLogs(res.data);
    } catch {}
  };

  const closeLogs = () => {
    setLogOpen(false);
    setLogSelectedKeys([]);
    if (logTimer.current) { clearInterval(logTimer.current); logTimer.current = null; }
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
    setIsBackupRunning(false);
  };

  const handleBatchDeleteLogs = () => {
    Modal.confirm({
      title: `确定删除选中的 ${logSelectedKeys.length} 条日志记录？`,
      content: '删除后无法恢复',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDeletingLogs(true);
        try {
          const res = await deleteBackupLogs(logSelectedKeys);
          if (res.success) message.success(res.message);
          else message.error(res.message);
          setLogSelectedKeys([]);
          if (logConfigId) loadLogs(logConfigId);
        } catch { message.error('删除失败'); }
        finally { setDeletingLogs(false); }
      },
    });
  };

  const sourceMap = Object.fromEntries(pgSources.map(s => [s.id, s]));
  const formatLabels: Record<string, string> = { sql: 'SQL 文件', dump: 'DUMP 文件', both: 'SQL + DUMP 双格式' };
  const formatColors: Record<string, string> = { sql: 'blue', dump: 'purple', both: 'green' };

  const parseLogProgress = (log: BackupLog) => {
    if (log.status === 'running' && log.error_message) {
      try {
        const parsed = JSON.parse(log.error_message);
        if (parsed && typeof parsed.progress === 'number') return parsed;
      } catch {}
    }
    return null;
  };

  // 检查是否有 running 状态的日志
  const hasRunningLog = logs.some(l => l.status === 'running');

  const logColumns = [
    { title: '状态', dataIndex: 'status', key: 'status', width: 80,
      render: (v: string, r: BackupLog) => {
        const progInfo = parseLogProgress(r);
        if (v === 'running') return progInfo ? <Badge status="processing" text={`${progInfo.progress}%`} /> : <Badge status="processing" text="执行中" />;
        if (v === 'success') return <Badge status="success" text="成功" />;
        if (v === 'error') return <Badge status="error" text="失败" />;
        return <Badge status="default" text={v} />;
      } },
    {
      title: '进度', key: 'progress', width: 220,
      render: (_: any, r: BackupLog) => {
        const progInfo = parseLogProgress(r);
        if (progInfo) {
          return (
            <div>
              <Progress percent={progInfo.progress} size="small" status="active"
                format={() => `${progInfo.progress}%`} />
              <Text type="secondary" style={{ fontSize: 11 }}>{progInfo.message}</Text>
            </div>
          );
        }
        if (r.status === 'success') return <Text type="success">完成</Text>;
        if (r.status === 'error') {
          const errMsg = r.error_message?.substring(0, 100) || '';
          return <Text type="danger" style={{ fontSize: 11 }}>{errMsg}</Text>;
        }
        return '-';
      },
    },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: any, r: BackupLog) => r.status === 'running' ? (
        <Button size="small" danger icon={<StopOutlined />}
          loading={stoppingId === logConfigId}
          onClick={() => logConfigId && handleStop(logConfigId)}>
          停止
        </Button>
      ) : '-',
    },
    { title: '文件', key: 'file', width: 100,
      render: (_: any, r: BackupLog) => {
        if (!r.backup_file) return '-';
        const files = r.backup_file.split(',').map(f => f.trim()).filter(Boolean);
        return (
          <Space size="small">
            {files.map((f, i) => (
              <Tooltip key={i} title={f} placement="top">
                <Button type="link" size="small" icon={<DownloadOutlined />}
                  href={'/api/backup-logs/' + r.id + '/download'}
                  target="_blank" />
              </Tooltip>
            ))}
          </Space>
        );
      } },
    { title: '大小', dataIndex: 'file_size', key: 'size', width: 80,
      render: (v: number) => v ? (v / 1024).toFixed(1) + ' KB' : '-' },
    { title: '开始时间', dataIndex: 'started_at', key: 'start', width: 150 },
    { title: '结束时间', dataIndex: 'finished_at', key: 'end', width: 150 },
  ];

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
    { title: '数据源', dataIndex: 'pg_source_id', key: 'source', width: 120,
      render: (v: number) => <Tag color="blue">{sourceMap[v]?.name || '#' + v}</Tag> },
    { title: '数据库', dataIndex: 'database_name', key: 'db', width: 120,
      render: (v: string, r: BackupConfig) => v || sourceMap[r.pg_source_id]?.database || '-' },
    { title: '备份格式', dataIndex: 'backup_format', key: 'format', width: 130,
      render: (v: string) => <Tag color={formatColors[v] || 'blue'}>{formatLabels[v] || v}</Tag> },
    { title: '备份目录', dataIndex: 'backup_dir', key: 'dir', width: 180, ellipsis: true,
      render: (v: string) => v || <Text type="secondary">默认 backups/</Text> },
    { title: '保留天数', dataIndex: 'keep_days', key: 'keep', width: 70, render: (v: number) => v + ' 天' },
    { title: '上次执行', dataIndex: 'last_run_at', key: 'last', width: 140, render: (v: string) => v || '-' },
    { title: '状态', dataIndex: 'enabled', key: 'enabled', width: 60,
      render: (v: number) => <Badge status={v ? 'success' : 'default'} text={v ? '启用' : '禁用'} /> },
    {
      title: '操作', key: 'action', width: 260,
      render: (_: any, r: BackupConfig) => (
        <Space>
          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
            onClick={() => handleRun(r.id)} loading={runningId === r.id}>执行</Button>
          <Button size="small" icon={<HistoryOutlined />} onClick={() => showLogs(r.id)}>日志</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ margin: 24 }}>
      {/* pg_dump 状态 - 紧凑提示条 */}
      {pgDumpStatus && (
        <div style={{
          marginBottom: 16, padding: '8px 16px', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: pgDumpStatus.installed && pgDumpStatus.compatible
            ? '#f6ffed' : '#fffbe6',
          border: '1px solid',
          borderColor: pgDumpStatus.installed && pgDumpStatus.compatible
            ? '#b7eb8f' : '#ffe58f',
        }}>
          <Tag color={pgDumpStatus.installed && pgDumpStatus.compatible ? 'success' : 'warning'} style={{ margin: 0, flexShrink: 0 }}>
            {pgDumpStatus.installed && pgDumpStatus.compatible ? '已就绪' : '需处理'}
          </Tag>
          <Text style={{ flexShrink: 0, fontWeight: 500, fontSize: 13 }}>
            {pgDumpStatus.installed ? 'pg_dump v' + pgDumpStatus.version : 'pg_dump 未安装'}
          </Text>
          {pgDumpStatus.installed && (
            <Text type="secondary" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 400, flexShrink: 1 }}>
              {pgDumpStatus.path}
            </Text>
          )}
          {!pgDumpStatus.installed && (
            <Text type="danger" style={{ fontSize: 12 }}>无法执行数据库备份</Text>
          )}
          {pgDumpStatus.installed && !pgDumpStatus.compatible && (
            <Text type="danger" style={{ fontSize: 12 }}>版本过低，不兼容 PostgreSQL 15+</Text>
          )}
          <Space size="small" style={{ marginLeft: 'auto', flexShrink: 0 }}>
            <Button size="small" icon={<DownloadOutlined />} type="primary" loading={installing} onClick={handleInstallPgTools}>
              安装 {pgDumpStatus.installed ? '16' : '客户端'}
            </Button>
            <Button size="small" onClick={checkPgDumpStatus}>刷新</Button>
          </Space>
        </div>
      )}

      <Card title={<><CloudServerOutlined /> 数据库备份配置</>}>
        <div style={{ marginBottom: 16, padding: '6px 12px', borderRadius: 4, background: '#e6f7ff', border: '1px solid #91d5ff', fontSize: 12, color: '#1890ff', display: 'flex', alignItems: 'center', gap: 6 }}>
          <InfoCircleOutlined />
          <span>定时调度请到「<a href="/?page=taskManager" target="_blank">任务管理</a>」创建「数据库备份」类型任务</span>
        </div>
        <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd} style={{ marginBottom: 16 }}>新增备份配置</Button>
          {selectedKeys.length > 0 && (
            <Button danger icon={<DeleteOutlined />} onClick={handleBatchDelete}>
              批量删除 ({selectedKeys.length})
            </Button>
          )}
        </div>
        <Table dataSource={configs} columns={columns} rowKey="id" loading={loading} pagination={false} size="small"
          scroll={{ x: 'max-content' }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys: React.Key[]) => setSelectedKeys(keys as number[]),
          }} />
      </Card>

      <Modal title={editingId ? '编辑备份' : '新增备份'}
        open={editOpen} onOk={handleSave} onCancel={() => setEditOpen(false)}
        okText="保存" cancelText="取消" confirmLoading={saving} width={560} maskClosable={false}>
        <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 4, background: '#e6f7ff', border: '1px solid #91d5ff', fontSize: 12, color: '#1890ff' }}>
          ⓘ 定时调度请到「任务管理」配置备份任务
        </div>
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input placeholder="例如：每日备份" /></Form.Item>
          <Form.Item label="PG 数据源" name="pg_source_id" rules={[{ required: true }]}>
            <Select placeholder="选择数据库" options={pgSources.map(s => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item label="数据库名" name="database_name" extra="留空则使用数据源中的数据库名"><Input placeholder="自动从数据源获取" /></Form.Item>
          <Form.Item label="备份格式" name="backup_format" extra="SQL 文件可用 psql 恢复；DUMP 文件可用 pg_restore 恢复（支持选择性恢复）">
            <Select options={[{ value: 'sql', label: 'SQL 文件 (.sql)' }, { value: 'dump', label: 'DUMP 文件 (.dump)' }, { value: 'both', label: 'SQL + DUMP 两种格式' }]} />
          </Form.Item>
          <Form.Item label="备份目录" name="backup_dir" extra="留空则保存到 server/backups/"><Input placeholder="/data/backups" /></Form.Item>
          <Form.Item label="保留天数"><InputNumber min={1} max={365} value={keepDays} onChange={(v) => setKeepDays(v ?? 1)} style={{ width: 120 }} /> 天后自动删除</Form.Item>
        </Form>
      </Modal>

      {/* 日志弹窗 - 无 loading，立即显示数据 */}
      <Modal title={<>备份日志 {logConfigId && <Text type="secondary">(配置 #{logConfigId})</Text>}</>}
        open={logOpen} onCancel={closeLogs} footer={null} width="90%">
        {/* 运行中的备份 - 顶部停止按钮 */}
        {isBackupRunning && hasRunningLog && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="备份正在执行中"
            description={
              <Space>
                <Text>有备份正在运行，您可以在下方查看实时进度</Text>
                <Button danger icon={<StopOutlined />} size="small"
                  loading={stoppingId === logConfigId}
                  onClick={() => logConfigId && handleStop(logConfigId)}>
                  停止备份
                </Button>
              </Space>
            }
          />
        )}
        {logSelectedKeys.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <Button danger size="small" icon={<DeleteOutlined />}
              loading={deletingLogs}
              onClick={handleBatchDeleteLogs}>
              批量删除 ({logSelectedKeys.length})
            </Button>
          </div>
        )}
        <Table dataSource={logs} columns={logColumns} rowKey="id"
          pagination={false} size="small"
          scroll={{ x: 'max-content' }}
          rowSelection={{
            selectedRowKeys: logSelectedKeys,
            onChange: (keys: React.Key[]) => setLogSelectedKeys(keys as number[]),
          }} />
      </Modal>
      <Modal title="正在安装 PostgreSQL 16 客户端工具"
        open={installModalOpen}
        closable={false}
        footer={null}
        width={500}
        maskClosable={false}
      >
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 36 }} spin />} />
          <div style={{ marginTop: 16, fontSize: 14, color: '#666' }}>{installStatus || '正在安装，这可能需要几分钟...'}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>请勿关闭此窗口，安装完成后会自动关闭</div>
        </div>
      </Modal>

      {/* 手动安装指引 Modal */}
      <Modal title="手动安装 PostgreSQL 16 客户端"
        open={manualInstallModal}
        onCancel={() => setManualInstallModal(false)}
        width={680}
        footer={
          <Space>
            <Button icon={<DownloadOutlined />} onClick={() => {
              navigator.clipboard.writeText(`sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt-get update
sudo apt-get install -y postgresql-client-16
/usr/lib/postgresql/16/bin/pg_dump --version`);
              message.success('已复制到剪贴板');
            }}>
              复制全部命令
            </Button>
            <Button type="primary" onClick={() => { setManualInstallModal(false); checkPgDumpStatus(); }}>
              安装完成，重新检测
            </Button>
          </Space>
        }
      >
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          message="自动安装失败"
          description={lastInstallError || '请按以下步骤在服务器终端手动执行'} />
        <Card size="small" title="Ubuntu 22.04 / Debian" style={{ marginBottom: 12 }}
          extra={<Button size="small" icon={<DownloadOutlined />} onClick={() => {
            navigator.clipboard.writeText(`sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt-get update
sudo apt-get install -y postgresql-client-16
/usr/lib/postgresql/16/bin/pg_dump --version`);
            message.success('已复制');
          }}>复制</Button>}>
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{`sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt-get update
sudo apt-get install -y postgresql-client-16
/usr/lib/postgresql/16/bin/pg_dump --version`}</pre>
        </Card>
        <Text type="secondary">安装完成后，点击上方「安装完成，重新检测」按钮确认版本。</Text>
      </Modal>
    </div>
  );
};

export default BackupPage;

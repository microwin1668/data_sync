import React, { useState, useEffect, useRef } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm,
  Tag, Typography, Badge, InputNumber, Alert, Progress, Spin, Tooltip, Checkbox, Radio,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined,
  FolderOpenOutlined, HistoryOutlined, StopOutlined, InfoCircleOutlined,
  ApiOutlined, LinkOutlined,
} from '@ant-design/icons';
import {
  listFileBackupConfigs, createFileBackupConfig, updateFileBackupConfig, deleteFileBackupConfig,
  runFileBackupNow, listFileBackupLogs, deleteFileBackupLogs, checkRsync,
  stopFileBackup, getFileBackupProgress, testFileBackupConnection,
} from '../api';
import type { FileBackupConfig, FileBackupLog } from '../api';

const { Text } = Typography;

interface RsyncStatus {
  installed: boolean;
  rsync: boolean;
  path: string;
  version: string;
  isOpenRsync: boolean;
  sshpass: boolean;
  sshpassHint: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const FileBackupPage: React.FC = () => {
  const [configs, setConfigs] = useState<FileBackupConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testingConn, setTestingConn] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [keepDays, setKeepDays] = useState<number | null>(30);

  // 日志弹窗
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<FileBackupLog[]>([]);
  const [logConfigId, setLogConfigId] = useState<number | null>(null);
  const [logSelectedKeys, setLogSelectedKeys] = useState<number[]>([]);
  const [deletingLogs, setDeletingLogs] = useState(false);
  const [liveProgress, setLiveProgress] = useState<{ status: string; progress: number; message: string } | null>(null);
  const logTimer = useRef<any>(null);
  const progressTimer = useRef<any>(null);

  // rsync 状态
  const [rsyncStatus, setRsyncStatus] = useState<RsyncStatus | null>(null);

  useEffect(() => {
    loadAll();
    checkRsyncStatus();
    return () => {
      if (logTimer.current) clearInterval(logTimer.current);
      if (progressTimer.current) clearInterval(progressTimer.current);
    };
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const res = await listFileBackupConfigs();
      if (res.success) setConfigs(res.data);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const checkRsyncStatus = async () => {
    try {
      const res = await checkRsync();
      if (res.success) setRsyncStatus(res.data);
    } catch { }
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      auth_type: 'key', ssh_port: '22',
      ssh_key_path: '~/.ssh/id_rsa', enabled: true, exclude_list: [],
    });
    setKeepDays(30);
    setEditOpen(true);
  };

  const openEdit = (cfg: FileBackupConfig) => {
    setEditingId(cfg.id);
    let excludeList: string[] = [];
    try {
      const arr = JSON.parse(cfg.exclude_patterns || '[]');
      if (Array.isArray(arr)) excludeList = arr;
    } catch { }
    form.setFieldsValue({
      name: cfg.name,
      ssh_host: cfg.ssh_host,
      ssh_port: cfg.ssh_port || '22',
      ssh_user: cfg.ssh_user,
      auth_type: cfg.auth_type || 'key',
      ssh_key_path: cfg.ssh_key_path || '',
      ssh_password: cfg.ssh_password || '',
      remote_dir: cfg.remote_dir,
      local_dir: cfg.local_dir,
      exclude_list: excludeList,
      enabled: !!cfg.enabled,
    });
    setKeepDays(Number(cfg.keep_days));
    setEditOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload = {
        name: values.name,
        ssh_host: values.ssh_host,
        ssh_port: values.ssh_port || '22',
        ssh_user: values.ssh_user,
        auth_type: values.auth_type || 'key',
        ssh_key_path: values.ssh_key_path || '',
        ssh_password: values.ssh_password || '',
        remote_dir: values.remote_dir,
        local_dir: values.local_dir,
        exclude_patterns: JSON.stringify(values.exclude_list || []),
        keep_days: keepDays || 30,
        enabled: values.enabled ? 1 : 0,
      };
      if (editingId) { await updateFileBackupConfig(editingId, payload); message.success('更新成功'); }
      else { await createFileBackupConfig(payload); message.success('创建成功'); }
      setEditOpen(false);
      loadAll();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + (err.message || ''));
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => { await deleteFileBackupConfig(id); message.success('已删除'); loadAll(); };

  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return;
    Modal.confirm({
      title: `确定删除选中的 ${selectedKeys.length} 条文件备份配置？`,
      content: '删除后无法恢复,已生成的本地快照文件不会被删除',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        let errCount = 0;
        for (const id of selectedKeys) {
          try { await deleteFileBackupConfig(id); } catch { errCount++; }
        }
        if (errCount > 0) message.warning(`已删除 ${selectedKeys.length - errCount} 条，${errCount} 条失败`);
        else message.success(`成功删除 ${selectedKeys.length} 条配置`);
        setSelectedKeys([]);
        loadAll();
      },
    });
  };

  const handleRun = async (id: number) => {
    setRunningId(id);
    try {
      const res = await runFileBackupNow(id);
      if (res.success) message.success(res.message);
      else message.error(res.message);
      setRunningId(null);
      loadAll();
    } catch (err: any) { message.error('执行失败: ' + err.message); setRunningId(null); }
  };

  const handleTestConn = async (cfg?: Partial<FileBackupConfig>) => {
    const source = cfg || form.getFieldsValue();
    setTestingConn(true);
    if (cfg) setTestingId(cfg.id || null);
    try {
      const res = await testFileBackupConnection({
        ssh_host: source.ssh_host || '',
        ssh_port: source.ssh_port || '22',
        ssh_user: source.ssh_user || '',
        auth_type: source.auth_type || 'key',
        ssh_key_path: source.ssh_key_path || '',
        ssh_password: source.ssh_password || '',
      });
      if (res.success) message.success(res.message);
      else message.error(res.message);
    } catch (err: any) {
      message.error('测试失败: ' + err.message);
    } finally {
      setTestingConn(false);
      setTestingId(null);
    }
  };

  const handleStop = async (configId: number) => {
    try {
      const res = await stopFileBackup(configId);
      if (res.success) message.success(res.message);
      else message.error(res.message);
      loadLogs(configId);
    } catch (err: any) { message.error('停止失败: ' + err.message); }
  };

  const checkRunningBackup = async (configId: number) => {
    try {
      const res = await getFileBackupProgress(configId);
      if (res.success && res.data?.status === 'running') {
        setLiveProgress(res.data);
        return;
      }
    } catch { }
    setLiveProgress(null);
  };

  const showLogs = async (configId: number) => {
    setLogConfigId(configId);
    setLogOpen(true);
    setLiveProgress(null);

    // 立即检查是否有正在运行的备份
    checkRunningBackup(configId);

    // 加载日志（无 loading 状态）
    loadLogs(configId).catch(() => { });

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
      const res = await listFileBackupLogs(configId);
      if (res.success) setLogs(res.data);
    } catch { }
  };

  const closeLogs = () => {
    setLogOpen(false);
    setLogSelectedKeys([]);
    if (logTimer.current) { clearInterval(logTimer.current); logTimer.current = null; }
    if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
    setLiveProgress(null);
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
          const res = await deleteFileBackupLogs(logSelectedKeys);
          if (res.success) message.success(res.message);
          else message.error(res.message);
          setLogSelectedKeys([]);
          if (logConfigId) loadLogs(logConfigId);
        } catch { message.error('删除失败'); }
        finally { setDeletingLogs(false); }
      },
    });
  };

  const rsyncReady = !!(rsyncStatus?.installed);

  const logColumns = [
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 80,
      render: (v: string) => {
        if (v === 'running') return <Badge status="processing" text="执行中" />;
        if (v === 'success') return <Badge status="success" text="成功" />;
        if (v === 'error') return <Badge status="error" text="失败" />;
        return <Badge status="default" text={v} />;
      }
    },
    {
      title: '快照目录', dataIndex: 'snapshot_dir', key: 'snapshot', width: 220, ellipsis: true,
      render: (v: string) => v ? <Tooltip title={v}><Text code style={{ fontSize: 12 }}>{v}</Text></Tooltip> : '-'
    },
    {
      title: '本次传输', key: 'transfer', width: 130,
      render: (_: any, r: FileBackupLog) => {
        if (r.status === 'running') return '-';
        if (r.transferred_files || r.transferred_bytes) {
          return <Text>{r.transferred_files} 个文件{r.transferred_bytes ? ` / ${formatBytes(r.transferred_bytes)}` : ''}</Text>;
        }
        return '-';
      },
    },
    {
      title: '快照文件总数', dataIndex: 'total_files', key: 'total', width: 100, responsive: ['sm'] as any,
      render: (v: number) => v ? v + ' 个' : '-'
    },
    {
      title: '信息', dataIndex: 'error_message', key: 'info', ellipsis: true, responsive: ['md'] as any,
      render: (v: string, r: FileBackupLog) => {
        if (r.status === 'error') return <Tooltip title={v}><Text type="danger" style={{ fontSize: 11 }}>{(v || '').substring(0, 80)}</Text></Tooltip>;
        return v ? <Tooltip title={v}><Text type="secondary" style={{ fontSize: 11 }}>{v.substring(0, 60)}</Text></Tooltip> : '-';
      }
    },
    { title: '开始时间', dataIndex: 'started_at', key: 'start', width: 150, responsive: ['sm'] as any },
    { title: '结束时间', dataIndex: 'finished_at', key: 'end', width: 150, responsive: ['md'] as any },
  ];

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
    {
      title: '远端服务器', key: 'remote', width: 200,
      render: (_: any, r: FileBackupConfig) => (
        <Tooltip title={`${r.ssh_user}@${r.ssh_host}:${r.ssh_port || 22}`}>
          <Tag color="geekblue" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <LinkOutlined /> {r.ssh_user}@{r.ssh_host}
          </Tag>
        </Tooltip>
      )
    },
    {
      title: '远端目录', dataIndex: 'remote_dir', key: 'remote_dir', width: 170, ellipsis: true, responsive: ['sm'] as any,
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>
    },
    {
      title: '本地目录', dataIndex: 'local_dir', key: 'local_dir', width: 180, ellipsis: true, responsive: ['sm'] as any,
      render: (v: string) => <Tooltip title={v}><Text code style={{ fontSize: 12 }}>{v}</Text></Tooltip>
    },
    { title: '保留天数', dataIndex: 'keep_days', key: 'keep', width: 70, responsive: ['md'] as any, render: (v: number) => v + ' 天' },
    {
      title: '上次快照', dataIndex: 'last_snapshot_dir', key: 'last_snapshot', width: 100, responsive: ['md'] as any,
      render: (v: string) => v ? v.split('/').pop() : '-'
    },
    { title: '上次执行', dataIndex: 'last_run_at', key: 'last', width: 140, responsive: ['lg'] as any, render: (v: string) => v || '-' },
    {
      title: '状态', dataIndex: 'enabled', key: 'enabled', width: 60,
      render: (v: number) => <Badge status={v ? 'success' : 'default'} text={v ? '启用' : '禁用'} />
    },
    {
      title: '操作', key: 'action', width: 300, className: 'table-action-column',
      render: (_: any, r: FileBackupConfig) => (
        <Space>
          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
            onClick={() => handleRun(r.id)} loading={runningId === r.id}>执行</Button>
          <Button size="small" icon={<HistoryOutlined />} onClick={() => showLogs(r.id)}>日志</Button>
          <Button size="small" icon={<ApiOutlined />}
            onClick={() => handleTestConn(r)} loading={testingId === r.id}>测试</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="responsive-page-container">
      {/* rsync 状态 - 紧凑提示条 */}
      {rsyncStatus && (
        <div style={{
          marginBottom: 16, padding: '8px 16px', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: rsyncReady ? '#f6ffed' : '#fffbe6',
          border: '1px solid',
          borderColor: rsyncReady ? '#b7eb8f' : '#ffe58f',
        }}>
          <Tag color={rsyncReady ? 'success' : 'warning'} style={{ margin: 0, flexShrink: 0 }}>
            {rsyncReady ? '已就绪' : '需处理'}
          </Tag>
          <Text style={{ flexShrink: 0, fontWeight: 500, fontSize: 13 }}>
            {rsyncStatus.installed ? 'rsync' + (rsyncStatus.version ? ` (${rsyncStatus.version.split(' ').slice(0, 2).join(' ')})` : '') : 'rsync 未安装'}
          </Text>
          {rsyncStatus.installed && (
            <Text type="secondary" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360, flexShrink: 1 }}>
              {rsyncStatus.path}
            </Text>
          )}
          {!rsyncStatus.installed && (
            <Text type="danger" style={{ fontSize: 12 }}>
              无法执行文件备份(macOS 系统自带,Linux 执行 yum/apt install rsync)
            </Text>
          )}
          {!rsyncStatus.sshpass && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              密码认证需安装 sshpass:{rsyncStatus.sshpassHint}
            </Text>
          )}
          <Button size="small" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={checkRsyncStatus}>刷新</Button>
        </div>
      )}

      <Card title={<><FolderOpenOutlined /> 文件备份配置(远程目录每日快照)</>}>
        <div style={{ marginBottom: 16, padding: '6px 12px', borderRadius: 4, background: '#e6f7ff', border: '1px solid #91d5ff', fontSize: 12, color: '#1890ff', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <InfoCircleOutlined />
          <span>每日快照:每天在本地目录生成 <Text code style={{ fontSize: 11 }}>YYYY-MM-DD</Text> 快照 + <Text code style={{ fontSize: 11 }}>latest</Text> 软链接,未变化文件用硬链接共享,不占额外空间;远端已删除的文件仍保留在历史快照中,保留期内可随时找回。定时调度请到「<a href="/?page=taskManager" target="_blank">任务管理</a>」创建任务</span>
        </div>
        {isMobile ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Button type="primary" block icon={<PlusOutlined />} onClick={openAdd}>新增文件备份配置</Button>
            </div>
            {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
            {!loading && configs.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无配置</div>}
            {!loading && configs.map(r => (
              <Card
                key={r.id}
                size="small"
                style={{ marginBottom: 12, borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                title={<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontWeight: 500 }}>{r.name}</span></div>}
                extra={<Badge status={r.enabled ? 'success' : 'default'} text={r.enabled ? '启用' : '禁用'} />}
              >
                <div style={{ padding: '4px 0', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><Text type="secondary">远端:</Text> <Tag color="geekblue">{r.ssh_user}@{r.ssh_host}:{r.ssh_port || 22}</Tag></div>
                  <div><Text type="secondary">远端目录:</Text> <Text code style={{ fontSize: 12 }}>{r.remote_dir}</Text></div>
                  <div><Text type="secondary">本地目录:</Text> <Text code style={{ fontSize: 12 }}>{r.local_dir}</Text></div>
                  <div><Text type="secondary">保留天数:</Text> {r.keep_days} 天</div>
                  <div><Text type="secondary">上次快照:</Text> {r.last_snapshot_dir ? r.last_snapshot_dir.split('/').pop() : '-'}</div>
                  <div><Text type="secondary">上次执行:</Text> {r.last_run_at || '-'}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8, flexWrap: 'wrap' }}>
                  <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => handleRun(r.id)} loading={runningId === r.id}>执行</Button>
                  <Button size="small" icon={<HistoryOutlined />} onClick={() => showLogs(r.id)}>日志</Button>
                  <Button size="small" icon={<ApiOutlined />} onClick={() => handleTestConn(r)} loading={testingId === r.id}>测试</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                  <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={openAdd} style={{ marginBottom: 16 }}>新增文件备份配置</Button>
              {selectedKeys.length > 0 && (
                <Button danger icon={<DeleteOutlined />} onClick={handleBatchDelete} style={{ marginBottom: 16 }}>
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
          </>
        )}
      </Card>

      <Modal title={editingId ? '编辑文件备份' : '新增文件备份'}
        open={editOpen} onOk={handleSave} onCancel={() => setEditOpen(false)}
        okText="保存" cancelText="取消" confirmLoading={saving} width={560} maskClosable={false}>
        <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 4, background: '#e6f7ff', border: '1px solid #91d5ff', fontSize: 12, color: '#1890ff' }}>
          ⓘ 每天执行时只传输有变化的文件;定时调度请到「任务管理」配置文件备份任务
        </div>
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input placeholder="例如：业务服务器文档备份" /></Form.Item>
          <Space size="small" style={{ display: 'flex' }}>
            <Form.Item label="主机地址" name="ssh_host" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="例如：192.168.1.100" />
            </Form.Item>
            <Form.Item label="SSH 端口" name="ssh_port" style={{ width: 100 }}>
              <Input placeholder="22" />
            </Form.Item>
          </Space>
          <Form.Item label="SSH 用户名" name="ssh_user" rules={[{ required: true }]}>
            <Input placeholder="例如：root" />
          </Form.Item>
          <Form.Item label="认证方式" name="auth_type">
            <Radio.Group>
              <Radio value="key">SSH 密钥</Radio>
              <Radio value="password">密码(需本机安装 sshpass)</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.auth_type !== cur.auth_type}>
            {({ getFieldValue }) => {
              const authType = getFieldValue('auth_type');
              if (authType === 'password') {
                return (
                  <Form.Item label="SSH 密码" name="ssh_password" rules={[{ required: true, message: '密码认证需要填写密码' }]}>
                    <Input.Password placeholder="远端服务器密码" autoComplete="new-password" />
                  </Form.Item>
                );
              }
              return (
                <Form.Item label="私钥路径" name="ssh_key_path" extra="留空则使用 SSH 默认行为(~/.ssh 下的密钥或 agent);需先将公钥添加到远端服务器的 authorized_keys">
                  <Input placeholder="~/.ssh/id_rsa" />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item label="远端目录" name="remote_dir" rules={[{ required: true }]}
            extra="要备份的服务器目录,以 / 结尾表示同步目录内容">
            <Input placeholder="/data/app/files/" />
          </Form.Item>
          <Form.Item label="本地目录" name="local_dir" rules={[{ required: true }]}
            extra="快照保存到 本地目录/YYYY-MM-DD/,并维护 latest 软链接指向最新快照">
            <Input placeholder="/Users/backup/remote-files" />
          </Form.Item>
          <Form.Item label="排除规则" name="exclude_list"
            extra="不备份的文件,每条一个通配符,回车添加,例如 *.log、tmp/、*.tmp">
            <Select mode="tags" tokenSeparators={[',']} placeholder="输入后回车添加,可留空" open={false} />
          </Form.Item>
          <Form.Item label="保留天数">
            <InputNumber min={1} max={3650} value={keepDays} onChange={(v) => setKeepDays(v ?? 30)} style={{ width: 120 }} /> 天前的快照自动删除
          </Form.Item>
          <Form.Item name="enabled" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>启用(禁用后定时任务不会执行此配置)</Checkbox>
          </Form.Item>
        </Form>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <Button icon={<ApiOutlined />} loading={testingConn} onClick={() => handleTestConn()}>
            测试连接
          </Button>
        </div>
      </Modal>

      {/* 日志弹窗 - 无 loading，立即显示数据 */}
      <Modal title={<>文件备份日志 {logConfigId && <Text type="secondary">(配置 #{logConfigId})</Text>}</>}
        open={logOpen} onCancel={closeLogs} footer={null} width="90%">
        {/* 运行中的备份 - 顶部进度与停止按钮 */}
        {liveProgress?.status === 'running' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`备份正在执行中(${liveProgress.progress}%)`}
            description={
              <Space direction="vertical" style={{ width: '100%' }}>
                <Progress percent={liveProgress.progress} size="small" status="active" />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{liveProgress.message}</Text>
                  <Button danger icon={<StopOutlined />} size="small"
                    onClick={() => logConfigId && handleStop(logConfigId)}>
                    停止备份
                  </Button>
                </div>
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
        <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
          ⓘ 远端已删除的文件仍保留在删除前的快照中,保留期内可直接从对应日期目录拷回
        </div>
      </Modal>
    </div>
  );
};

export default FileBackupPage;

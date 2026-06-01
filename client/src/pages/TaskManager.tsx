import React, { useState, useEffect, useRef } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Tag, Typography, InputNumber,
  Switch, Badge, Progress, Tooltip, Row, Col, Spin, Checkbox,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined, ClockCircleOutlined,
  HistoryOutlined, DownloadOutlined, CloseCircleOutlined,
  DatabaseOutlined, SyncOutlined,
} from '@ant-design/icons';
import {
  listSyncTasks, createSyncTask, updateSyncTask, deleteSyncTask, runSyncTask,
  listSyncConfigs, listTaskExecutions, listBackupConfigsNames, stopBackup, deleteTaskExecutionLogs,
} from '../api';
import type { SyncTask, SyncConfig, TaskExecutionLog } from '../api';

const { Text } = Typography;

const TaskManager: React.FC = () => {
  const [tasks, setTasks] = useState<SyncTask[]>([]);
  const [configs, setConfigs] = useState<SyncConfig[]>([]);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [backupConfigs, setBackupConfigs] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<number | null>(null);
  const [execLogs, setExecLogs] = useState<TaskExecutionLog[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [logTaskId, setLogTaskId] = useState<number | null>(null);
  const [logTaskType, setLogTaskType] = useState<string>('');
  const [logLoading, setLogLoading] = useState(false);
  const [stoppingId, setStoppingId] = useState<number | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [logSelectedKeys, setLogSelectedKeys] = useState<number[]>([]);
  const logTimer = useRef<any>(null);

  const runningTimer = useRef<any>(null);

  useEffect(() => {
    loadAll();
    return () => {
      if (logTimer.current) clearInterval(logTimer.current);
      if (runningTimer.current) clearInterval(runningTimer.current);
    };
  }, []);

  // 轮询检查备份任务是否完成
  useEffect(() => {
    if (running !== null) {
      runningTimer.current = setInterval(async () => {
        try {
          const logRes = await listTaskExecutions(running);
          if (logRes.success) {
            const hasRunning = logRes.data.some((l: any) => l.status === 'running');
            if (!hasRunning) {
              setRunning(null);
              loadAll();
            }
          }
        } catch {}
      }, 2000);
    } else {
      if (runningTimer.current) {
        clearInterval(runningTimer.current);
        runningTimer.current = null;
      }
    }
    return () => {
      if (runningTimer.current) clearInterval(runningTimer.current);
    };
  }, [running]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [taskRes, cfgRes, backupRes] = await Promise.all([
        listSyncTasks(), listSyncConfigs(), listBackupConfigsNames(),
      ]);
      if (taskRes.success) setTasks(taskRes.data);
      if (cfgRes.success) setConfigs(cfgRes.data);
      if (backupRes.success) setBackupConfigs(backupRes.data);

      // 如果有正在执行的任务，检查执行日志看是否已完成
      if (running !== null) {
        try {
          const logRes = await listTaskExecutions(running);
          if (logRes.success) {
            const hasRunning = logRes.data.some((l: any) => l.status === 'running');
            if (!hasRunning) setRunning(null);
          }
        } catch {}
      }
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({ task_type: 'sync', type: 'interval', interval_unit: 'minutes', interval_value: 30, enabled: 1, sync_config_ids: [] });
    setEditOpen(true);
  };

  const openEdit = (task: SyncTask) => {
    setEditingId(task.id);
    form.resetFields();
    // 所有字段始终渲染（用 display 控制显隐），直接设置值即可
    if (task.task_type === 'sync' || !task.task_type) {
      let syncConfigIds: number[] = [];
      try { syncConfigIds = JSON.parse(task.sync_config_ids || '[]'); } catch {}
      if (syncConfigIds.length === 0 && task.sync_config_id) syncConfigIds = [task.sync_config_id];
      form.setFieldsValue({
        ...task,
        task_type: 'sync',
        sync_config_ids: syncConfigIds,
        scheduled_days: task.scheduled_days ? task.scheduled_days.split(',').filter(Boolean).map(Number) : [],
      });
    } else {
      form.setFieldsValue({
        ...task,
        task_type: 'backup',
        scheduled_days: task.scheduled_days ? task.scheduled_days.split(',').filter(Boolean).map(Number) : [],
      });
    }
    setEditOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const taskType = values.task_type || 'sync';
      let payload: any = {
        name: values.name,
        task_type: taskType,
        type: values.type,
        interval_value: values.interval_value || 0,
        interval_unit: values.interval_unit || 'minutes',
        cron_expr: values.cron_expr || '',
        scheduled_time: values.scheduled_time || '',
        scheduled_days: Array.isArray(values.scheduled_days) ? values.scheduled_days.map(Number).join(',') : (values.scheduled_days || ''),
        enabled: values.enabled !== undefined ? values.enabled : 1,
      };
      if (taskType === 'backup') {
        payload.backup_config_id = values.backup_config_id || 0;
        payload.backup_dir = '';
        payload.keep_days = 0;
        payload.sync_config_id = 0;
        payload.sync_config_ids = '[]';
      } else {
        const syncConfigIds = Array.isArray(values.sync_config_ids) ? values.sync_config_ids : [];
        payload.sync_config_id = syncConfigIds[0] || 0;
        payload.sync_config_ids = JSON.stringify(syncConfigIds);
        payload.backup_config_id = 0;
        payload.backup_dir = '';
        payload.keep_days = 0;
      }
      if (editingId) {
        await updateSyncTask(editingId, payload);
        message.success('更新成功');
      } else {
        await createSyncTask(payload);
        message.success('创建成功');
      }
      setEditOpen(false);
      loadAll();
    } catch (err: any) {
      if (err.errorFields) { message.warning('请检查表单填写是否完整'); return; }
      message.error('保存失败: ' + (err.message || ''));
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    await deleteSyncTask(id);
    message.success('已删除');
    loadAll();
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return;
    Modal.confirm({
      title: `确定删除选中的 ${selectedKeys.length} 条定时任务？`,
      content: '删除后无法恢复',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        let errCount = 0;
        for (const id of selectedKeys) {
          try { await deleteSyncTask(id); } catch { errCount++; }
        }
        if (errCount > 0) message.warning(`已删除 ${selectedKeys.length - errCount} 条，${errCount} 条失败`);
        else message.success(`成功删除 ${selectedKeys.length} 条定时任务`);
        setSelectedKeys([]);
        loadAll();
      },
    });
  };

  const handleBatchDeleteLog = async () => {
    if (logSelectedKeys.length === 0) return;
    Modal.confirm({
      title: `确定删除选中的 ${logSelectedKeys.length} 条执行日志？`,
      content: '删除后无法恢复',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await deleteTaskExecutionLogs(logSelectedKeys);
          if (res.success) {
            message.success(res.message);
          } else {
            message.error(res.message);
          }
        } catch (err: any) {
          message.error('删除失败: ' + (err.message || ''));
        }
        setLogSelectedKeys([]);
        loadLogs(logTaskId!);
      },
    });
  };

  const handleRun = async (id: number) => {
    setRunning(id);
    try {
      const res = await runSyncTask(id);
      if (res.success) {
        message.success(res.message);
        // 对于备份任务，不立即清除 running 状态（需要等到执行完成）
        const task = tasks.find(t => t.id === id);
        if (task && task.task_type === 'backup') {
          // 保持 running 状态，loadAll 会检查并更新
        } else {
          setRunning(null);
        }
      } else {
        message.error(res.message);
        setRunning(null);
      }
      loadAll();
    } catch (err: any) {
      message.error('执行失败: ' + (err.message || ''));
      setRunning(null);
    }
  };

  const handleToggle = async (task: SyncTask, checked: boolean) => {
    try {
      if (task.task_type === 'backup') {
        await updateSyncTask(task.id, {
          name: task.name,
          sync_config_id: task.sync_config_id,
          sync_config_ids: task.sync_config_ids || '[]',
          type: task.type, interval_value: task.interval_value, interval_unit: task.interval_unit,
          cron_expr: task.cron_expr, scheduled_time: task.scheduled_time,
          scheduled_days: task.scheduled_days, enabled: checked ? 1 : 0,
          task_type: 'backup',
          backup_config_id: task.backup_config_id,
        });
      } else {
        await updateSyncTask(task.id, {
          name: task.name,
          sync_config_id: task.sync_config_id,
          sync_config_ids: task.sync_config_ids || (task.sync_config_id ? JSON.stringify([task.sync_config_id]) : '[]'),
          type: task.type, interval_value: task.interval_value, interval_unit: task.interval_unit,
          cron_expr: task.cron_expr, scheduled_time: task.scheduled_time,
          scheduled_days: task.scheduled_days, enabled: checked ? 1 : 0,
          task_type: 'sync',
        });
      }
      message.success(checked ? '任务已启用' : '任务已禁用');
      loadAll();
    } catch { message.error('操作失败'); }
  };

  const showLogs = async (taskId: number) => {
    setLogTaskId(taskId);
    const task = tasks.find(t => t.id === taskId);
    setLogTaskType(task?.task_type || 'sync');
    setLogOpen(true);
    setLogLoading(true);
    await loadLogs(taskId);
    setLogLoading(false);

    // 自动刷新
    if (logTimer.current) clearInterval(logTimer.current);
    logTimer.current = setInterval(async () => {
      await loadLogs(taskId);
    }, 3000);
  };

  const loadLogs = async (taskId: number) => {
    try {
      const res = await listTaskExecutions(taskId);
      if (res.success) setExecLogs(res.data);
    } catch {}
  };

  const closeLogs = () => {
    setLogOpen(false);
    if (logTimer.current) { clearInterval(logTimer.current); logTimer.current = null; }
  };

  const handleStopBackup = async (configId: number) => {
    setStoppingId(configId);
    // 立即清除运行状态，恢复执行按钮
    setRunning(null);
    try {
      const res = await stopBackup(configId);
      if (res.success) {
        message.success(res.message);
        // 立即更新本地状态，将 running 状态的日志标记为 error
        setExecLogs(prev => prev.map(log => {
          if (log.status === 'running' && log.sync_config_id === configId) {
            return { ...log, status: 'error' as const, error_message: '用户手动停止' };
          }
          return log;
        }));
      } else {
        message.error(res.message);
      }
      // 刷新日志
      if (logTaskId) await loadLogs(logTaskId);
      // 刷新任务列表
      loadAll();
    } catch (err: any) { message.error('停止失败: ' + (err.message || '')); }
    finally {
      setStoppingId(null);
      setTimeout(() => { if (logTaskId) loadLogs(logTaskId); }, 1000);
    }
  };

  const backupConfigMap = Object.fromEntries(backupConfigs.map(c => [c.id, c]));

  const columns = [
    {
      title: '类型', dataIndex: 'task_type', key: 'type', width: 80,
      render: (v: string) => v === 'backup'
        ? <Tag icon={<DatabaseOutlined />} color="green">备份</Tag>
        : <Tag icon={<SyncOutlined />} color="blue">同步</Tag>,
    },
    { title: '任务名称', dataIndex: 'name', key: 'name', width: 180 },
    {
      title: '配置', key: 'config', width: 200, ellipsis: true, responsive: ['sm'] as any,
      render: (_: any, r: SyncTask) => {
        if (r.task_type === 'backup') {
          const bc = backupConfigMap[r.backup_config_id];
          return bc ? <Tag color="green">{bc.name}</Tag> : <Text type="secondary">备份 #{r.backup_config_id}</Text>;
        }
        try {
          const ids: number[] = JSON.parse(r.sync_config_ids || '[]');
          return ids.length ? ids.map(id => <Tag key={id} color="blue">配置#{id}</Tag>) : <Text type="secondary">-</Text>;
        } catch { return <Text type="secondary">-</Text>; }
      },
    },
    {
      title: '调度', key: 'schedule', width: 150, responsive: ['sm'] as any,
      render: (_: any, r: SyncTask) => {
        if (r.type === 'interval') return `每 ${r.interval_value} ${r.interval_unit === 'days' ? '天' : r.interval_unit === 'hours' ? '小时' : '分钟'}`;
        if (r.type === 'daily') return `每天 ${r.scheduled_time}`;
        if (r.type === 'weekly') return `每周 ${r.scheduled_days} ${r.scheduled_time}`;
        if (r.type === 'once') return `单次 ${r.scheduled_time}`;
        return '-';
      },
    },

    { title: '上次执行', dataIndex: 'last_run_at', key: 'last', width: 140, responsive: ['md'] as any, render: (v: string) => v || '-' },
    { title: '下次执行', dataIndex: 'next_run_at', key: 'next', width: 140, responsive: ['md'] as any,
      render: (v: string) => v ? <Text type="warning">{v}</Text> : '-' },
    {
      title: '状态', dataIndex: 'enabled', key: 'enabled', width: 60,
      render: (_: any, r: SyncTask) => (
        <Switch checked={r.enabled === 1} onChange={checked => handleToggle(r, checked)} size="small" />
      ),
    },
    {
      title: '操作', key: 'action', width: 160, className: 'table-action-column',
      render: (_: any, r: SyncTask) => (
        <Space size="small">
          <Tooltip title="执行">
            <Button size="small" type="primary" icon={<PlayCircleOutlined />}
              onClick={() => handleRun(r.id)} loading={running === r.id} />
          </Tooltip>
          <Tooltip title="日志">
            <Button size="small" icon={<HistoryOutlined />} onClick={() => showLogs(r.id)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
            <Tooltip title="删除">
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const logColumns = [
    { title: '状态', dataIndex: 'status', key: 'status', width: 90,
      render: (v: string, r: TaskExecutionLog) => {
        if (v === 'running') {
          return <Badge status="processing" text="执行中" />;
        }
        if (v === 'success') return <Badge status="success" text="成功" />;
        if (v === 'error' && r.error_message && r.error_message.includes('手动停止')) {
          return <Badge status="warning" text="终止备份" />;
        }
        if (v === 'error') return <Badge status="error" text="失败" />;
        if (v === 'cancelled') return <Badge status="warning" text="已取消" />;
        return <Badge status="processing" text="执行中" />;
      } },
    { title: '配置名称', dataIndex: 'sync_config_name', key: 'cfgName', width: 140, ellipsis: true, responsive: ['sm'] as any },
    { title: '目标', dataIndex: 'target_table', key: 'table', width: 100,
      render: (v: string, r: TaskExecutionLog) => {
        if (r.error_message && (r.status === 'running' || (r.status === 'error' && !r.log_filename))) {
          return <Text type="secondary" style={{ fontSize: 11 }}>{r.error_message.substring(0, 50)}</Text>;
        }
        return v || '-';
      } },
    {
      title: '进度', key: 'progress', width: 200,
      render: (_: any, r: TaskExecutionLog) => {
        if (r.status === 'running') {
          const pct = r.error_count || 0;
          const done = r.success_count || 0;
          const total = r.total_records || 0;
          const isBackup = r.task_type === 'backup';
          const label = isBackup ? `表 ${done}/${total} (${pct}%)` : (total > 0 ? `${done} / ${total}` : `${pct}%`);
          return (
            <Space size="small">
              <Progress percent={pct} size="small" status="active" style={{ width: 100 }}
                format={() => label} />
              <Button type="text" size="small" danger icon={<CloseCircleOutlined />}
                loading={stoppingId === (r.sync_config_id || 0)}
                onClick={() => handleStopBackup(r.sync_config_id || 0)} />
            </Space>
          );
        }
        if (r.status === 'success') {
          if (r.task_type === 'backup') {
            return <Text type="success">完成</Text>;
          }
          const succ = r.success_count || 0;
          const fail = r.error_count || 0;
          if (succ > 0 || fail > 0) {
            return <Text><Text type="success">{succ}</Text> / <Text type="danger">{fail}</Text></Text>;
          }
          return <Text type="success">完成</Text>;
        }
        if (r.status === 'error') {
          if (r.error_message && r.error_message.includes('手动停止')) {
            return <Tag color="orange" style={{ margin: 0 }}>终止备份</Tag>;
          }
          if (r.task_type === 'backup') {
            return <Badge status="error" text="失败" />;
          }
          const succ = r.success_count || 0;
          const fail = r.error_count || 0;
          if (succ > 0 || fail > 0) {
            return <Text><Text type="success">{succ}</Text> / <Text type="danger">{fail}</Text></Text>;
          }
          return <Badge status="error" text="失败" />;
        }
        return '-';
      },
    },
    { title: '失败日志', key: 'log', width: 100, className: 'table-action-column',
      render: (_: any, r: TaskExecutionLog) => r.log_filename ? (
        <Button size="small" icon={<DownloadOutlined />}
          href={'/api/logs/' + r.log_filename} target="_blank">下载</Button>
      ) : '-',
    },
    ...(logTaskType === 'backup' ? [{ title: '备份文件', key: 'backupFile', width: 80,
      render: (_: any, r: TaskExecutionLog) => {
        if (!r.backup_file) return '-';
        const files = r.backup_file.split(',').map((f: string) => f.trim()).filter(Boolean);
        return (
          <Space size="small">
            {files.map((f, i) => (
              <Tooltip key={i} title={f} placement="top">
                <Button type="link" size="small" icon={<DownloadOutlined />}
                  href={'/api/backup-logs/by-file/' + encodeURIComponent(f)}
                  target="_blank" />
              </Tooltip>
            ))}
          </Space>
        );
      } }] : []),
    { title: '开始时间', dataIndex: 'started_at', key: 'started', width: 140, responsive: ['sm'] as any },
    { title: '完成时间', dataIndex: 'finished_at', key: 'finished', width: 140, responsive: ['md'] as any },
  ];

  return (
    <div className="responsive-page-container">
      {isMobile ? (
        <Card title={<><ClockCircleOutlined /> 任务管理</>}>
          <div style={{ marginBottom: 16 }}>
            <Button type="primary" block icon={<PlusOutlined />} onClick={openAdd}>
              新增定时任务
            </Button>
          </div>
          {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
          {!loading && tasks.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无任务</div>}
          {!loading && tasks.map(r => {
            const renderType = () => r.task_type === 'backup'
              ? <Tag icon={<DatabaseOutlined />} color="green">备份</Tag>
              : <Tag icon={<SyncOutlined />} color="blue">同步</Tag>;
            const renderSchedule = () => {
              if (r.type === 'interval') return `每 ${r.interval_value} ${r.interval_unit === 'days' ? '天' : r.interval_unit === 'hours' ? '小时' : '分钟'}`;
              if (r.type === 'daily') return `每天 ${r.scheduled_time}`;
              if (r.type === 'weekly') return `每周 ${r.scheduled_days} ${r.scheduled_time}`;
              if (r.type === 'once') return `单次 ${r.scheduled_time}`;
              return '-';
            };
            return (
              <Card
                key={r.id}
                size="small"
                style={{ marginBottom: 12, borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {renderType()}
                    <span style={{ fontWeight: 500 }}>{r.name}</span>
                  </div>
                }
                extra={<Switch checked={r.enabled === 1} onChange={checked => handleToggle(r, checked)} size="small" />}
              >
                <div style={{ padding: '4px 0', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><Text type="secondary">调度方式:</Text> <Text strong>{renderSchedule()}</Text></div>
                  <div><Text type="secondary">上次执行:</Text> {r.last_run_at || '-'}</div>
                  <div><Text type="secondary">下次执行:</Text> {r.next_run_at ? <Text type="warning">{r.next_run_at}</Text> : '-'}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8, flexWrap: 'wrap' }}>
                  <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => handleRun(r.id)} loading={running === r.id}>执行</Button>
                  <Button size="small" icon={<HistoryOutlined />} onClick={() => showLogs(r.id)}>日志</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                  <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
              </Card>
            );
          })}
        </Card>
      ) : (
        <Card title={<><ClockCircleOutlined /> 任务管理</>}>
          <div style={{ marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
              新增定时任务
            </Button>
          </div>
          <Table dataSource={tasks} columns={columns} rowKey="id" loading={loading}
            pagination={false} size="small" scroll={{ x: 'max-content' }} />
        </Card>
      )}

      {/* 编辑弹窗 */}
      <Modal title={editingId ? '编辑定时任务' : '新增定时任务'}
        open={editOpen} onOk={handleSave} onCancel={() => setEditOpen(false)} maskClosable={false}
        okText="保存" cancelText="取消" confirmLoading={saving} width={680}>
        <Form form={form} layout="vertical">
          <Form.Item label="任务名称" name="name" rules={[{ required: true, message: '请输入任务名称' }]}>
            <Input placeholder="例如：每日同步教师数据" />
          </Form.Item>
          <Form.Item label="任务类型" name="task_type" rules={[{ required: true }]}>
            <Select options={[
              { value: 'sync', label: <><SyncOutlined /> 数据同步</> },
              { value: 'backup', label: <><DatabaseOutlined /> 数据库备份</> },
            ]} />
          </Form.Item>
          {/* 备份配置字段 */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.task_type !== cur.task_type}>
            {({ getFieldValue }) => {
              const taskType = getFieldValue('task_type');
              return (
                <>
                  <div style={{ display: taskType === 'backup' ? 'block' : 'none' }}>
                    <Form.Item label="备份配置" name="backup_config_id"
                      rules={[{ required: taskType === 'backup', message: '请选择备份配置' }]}>
                      <Select placeholder="选择备份配置"
                        options={backupConfigs.map(c => ({ value: c.id, label: c.name }))}
                        showSearch />
                    </Form.Item>
                  
                  </div>
                  <div style={{ display: taskType !== 'backup' ? 'block' : 'none' }}>
                    <Form.Item label="同步配置（可多选）" name="sync_config_ids"
                      rules={[{ required: taskType !== 'backup', message: '请选择至少一个同步配置' }]}>
                      <Select mode="multiple" placeholder="选择要执行的导入配置（可多选）"
                        options={configs.map(c => ({ value: Number(c.id), label: `${c.name} (${c.target_table})` }))}
                        showSearch />
                    </Form.Item>
                  </div>
                </>
              );
            }}
          </Form.Item>
          <Form.Item label="执行类型" name="type">
            <Select options={[
              { value: 'interval', label: '间隔执行' },
              { value: 'daily', label: '每天指定时间' },
              { value: 'weekly', label: '每周指定时间' },
              { value: 'once', label: '单次执行' },
            ]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
            {({ getFieldValue }) => {
              const type = getFieldValue('type');
              if (type === 'interval') return (
                <Row gutter={8}>
                  <Col xs={24} sm={12}>
                    <Form.Item label="间隔值" name="interval_value" rules={[{ required: true, message: '请输入间隔值' }]}>
                      <Input type="number" min={1} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12}>
                    <Form.Item label="单位" name="interval_unit">
                      <Select style={{ width: '100%' }} options={[
                        { value: 'minutes', label: '分钟' },
                        { value: 'hours', label: '小时' },
                        { value: 'days', label: '天' },
                      ]} />
                    </Form.Item>
                  </Col>
                </Row>
              );
              if (type === 'daily' || type === 'once') return (
                <Form.Item label="执行时间" name="scheduled_time" rules={[{ required: true, message: '请选择时间' }]}>
                  <Input type="time" style={{ width: 160 }} />
                </Form.Item>
              );
              if (type === 'weekly') return (
                <>
                  <Form.Item label="执行时间" name="scheduled_time" rules={[{ required: true, message: '请选择时间' }]}>
                    <Input type="time" style={{ width: 160 }} />
                  </Form.Item>
                  <Form.Item label="星期" name="scheduled_days" rules={[{ required: true, message: '请选择星期' }]}>
                    <Select mode="multiple" placeholder="选择星期"
                      options={[
                        { value: '1', label: '周一' }, { value: '2', label: '周二' },
                        { value: '3', label: '周三' }, { value: '4', label: '周四' },
                        { value: '5', label: '周五' }, { value: '6', label: '周六' },
                        { value: '7', label: '周日' },
                      ]}
                      onChange={vals => form.setFieldsValue({ scheduled_days: vals })} />
                  </Form.Item>
                </>
              );
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>

      {/* 执行日志弹窗 */}
      <Modal title={<>执行日志 {logTaskId && <Text type="secondary">(任务 #{logTaskId})</Text>}</>}
        open={logOpen} onCancel={() => { setLogSelectedKeys([]); closeLogs(); }} footer={null}
        width={isMobile ? "96%" : "90%"} style={{ top: 20 }}>
        {isMobile ? (
          <div>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Checkbox
                  checked={execLogs.length > 0 && logSelectedKeys.length === execLogs.length}
                  indeterminate={logSelectedKeys.length > 0 && logSelectedKeys.length < execLogs.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setLogSelectedKeys(execLogs.map(log => log.id));
                    } else {
                      setLogSelectedKeys([]);
                    }
                  }}
                >
                  全选
                </Checkbox>
                {logSelectedKeys.length > 0 && (
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={handleBatchDeleteLog}>
                    批量删除 ({logSelectedKeys.length})
                  </Button>
                )}
              </div>
            </div>
            <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
              {logLoading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
              {!logLoading && execLogs.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无日志</div>}
              {!logLoading && execLogs.map(r => {
                const renderStatus = () => {
                  const v = r.status;
                  if (v === 'running') return <Badge status="processing" text="执行中" />;
                  if (v === 'success') return <Badge status="success" text="成功" />;
                  if (v === 'error' && r.error_message && r.error_message.includes('手动停止')) {
                    return <Badge status="warning" text="终止备份" />;
                  }
                  if (v === 'error') return <Badge status="error" text="失败" />;
                  if (v === 'cancelled') return <Badge status="warning" text="已取消" />;
                  return <Badge status="processing" text="执行中" />;
                };

                const renderProgress = () => {
                  if (r.status === 'running') {
                    const pct = r.error_count || 0;
                    const done = r.success_count || 0;
                    const total = r.total_records || 0;
                    const isBackup = r.task_type === 'backup';
                    const label = isBackup ? `表 ${done}/${total} (${pct}%)` : (total > 0 ? `${done} / ${total}` : `${pct}%`);
                    return (
                      <Space size="small">
                        <Progress percent={pct} size="small" status="active" style={{ width: 100 }} format={() => label} />
                        <Button type="text" size="small" danger icon={<CloseCircleOutlined />}
                          loading={stoppingId === (r.sync_config_id || 0)}
                          onClick={() => handleStopBackup(r.sync_config_id || 0)} />
                      </Space>
                    );
                  }
                  if (r.status === 'success') {
                    if (r.task_type === 'backup') return <Text type="success">完成</Text>;
                    const succ = r.success_count || 0;
                    const fail = r.error_count || 0;
                    if (succ > 0 || fail > 0) {
                      return <Text><Text type="success">{succ}</Text> / <Text type="danger">{fail}</Text></Text>;
                    }
                    return <Text type="success">完成</Text>;
                  }
                  if (r.status === 'error') {
                    if (r.error_message && r.error_message.includes('手动停止')) {
                      return <Tag color="orange" style={{ margin: 0 }}>终止备份</Tag>;
                    }
                    if (r.task_type === 'backup') return <Badge status="error" text="失败" />;
                    const succ = r.success_count || 0;
                    const fail = r.error_count || 0;
                    if (succ > 0 || fail > 0) {
                      return <Text><Text type="success">{succ}</Text> / <Text type="danger">{fail}</Text></Text>;
                    }
                    return <Badge status="error" text="失败" />;
                  }
                  return '-';
                };

                const renderBackupFile = () => {
                  if (!r.backup_file) return null;
                  const files = r.backup_file.split(',').map((f: string) => f.trim()).filter(Boolean);
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <Text type="secondary">备份文件:</Text>
                      {files.map((f, i) => (
                        <Tooltip key={i} title={f} placement="top">
                          <Button type="link" size="small" icon={<DownloadOutlined />} style={{ padding: '0 4px' }}
                            href={'/api/backup-logs/by-file/' + encodeURIComponent(f)}
                            target="_blank" />
                        </Tooltip>
                      ))}
                    </div>
                  );
                };

                const isChecked = logSelectedKeys.includes(r.id);

                return (
                  <Card
                    key={r.id}
                    size="small"
                    style={{ marginBottom: 10, borderRadius: 6, border: '1px solid #f0f0f0' }}
                    bodyStyle={{ padding: 10 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Checkbox
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setLogSelectedKeys([...logSelectedKeys, r.id]);
                            } else {
                              setLogSelectedKeys(logSelectedKeys.filter(k => k !== r.id));
                            }
                          }}
                        />
                        {renderStatus()}
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 500, color: '#333', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.sync_config_name || '-'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#666' }}>
                      <div>
                        <Text type="secondary">目标表:</Text> {r.target_table || '-'}
                      </div>
                      {r.error_message && (r.status === 'running' || (r.status === 'error' && !r.log_filename)) && (
                        <div style={{ background: '#fff2f0', border: '1px solid #ffccc7', padding: '4px 8px', borderRadius: 4, fontSize: 11, color: '#ff4d4f', wordBreak: 'break-all' }}>
                          {r.error_message}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <Text type="secondary">进度/结果:</Text> {renderProgress()}
                        </div>
                        {r.log_filename && (
                          <Button size="small" type="primary" ghost icon={<DownloadOutlined />} style={{ height: 22, fontSize: 11, display: 'flex', alignItems: 'center', gap: 2 }}
                            href={'/api/logs/' + r.log_filename} target="_blank">
                            下载失败日志
                          </Button>
                        )}
                      </div>
                      {logTaskType === 'backup' && renderBackupFile()}
                      <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                        <div>开始: {r.started_at || '-'}</div>
                        {r.finished_at && <div>结束: {r.finished_at}</div>}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              {logSelectedKeys.length > 0 && (
                <Button danger icon={<DeleteOutlined />} onClick={handleBatchDeleteLog}>
                  批量删除日志 ({logSelectedKeys.length})
                </Button>
              )}
            </div>
            <Table dataSource={execLogs} columns={logColumns} rowKey="id"
              loading={logLoading} pagination={false} size="small"
              scroll={{ x: 'max-content' }}
              rowSelection={{
                selectedRowKeys: logSelectedKeys,
                onChange: (keys: React.Key[]) => setLogSelectedKeys(keys as number[]),
              }} />
          </>
        )}
      </Modal>
    </div>
  );
};

export default TaskManager;

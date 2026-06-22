import React, { useState, useEffect, useRef } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm,
  Tag, Typography, Badge, InputNumber, Alert, Progress, Spin, Tooltip,
  Radio, Checkbox,
} from 'antd';
import {
  LoadingOutlined, PlusOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined,
  CloudServerOutlined, HistoryOutlined, DownloadOutlined, StopOutlined, InfoCircleOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import {
  listBackupConfigs, createBackupConfig, updateBackupConfig, deleteBackupConfig,
  runBackupNow, listBackupLogs, deleteBackupLogs, listPgSources, checkPgDump, installPgTools,
  stopBackup, getBackupProgress, getInstallProgress,
  getPgSourceDatabases, getBackupLogTables, restoreBackupLog, getBackupRestoreProgress, stopBackupRestore,
} from '../api';
import type { BackupConfig, BackupLog, PgDatasource } from '../api';

const { Text } = Typography;

const BackupPage: React.FC = () => {
  const [configs, setConfigs] = useState<BackupConfig[]>([]);
  const [pgSources, setPgSources] = useState<PgDatasource[]>([]);
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

  // 恢复数据弹窗状态
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoringLog, setRestoringLog] = useState<BackupLog | null>(null);
  const [restoreDatabases, setRestoreDatabases] = useState<string[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [dumpTables, setDumpTables] = useState<{ schema: string; name: string }[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [restoreMode, setRestoreMode] = useState<'all' | 'schema' | 'custom'>('all');
  const [selectedRestoreSchema, setSelectedRestoreSchema] = useState<string | undefined>(undefined);
  const [selectedRestoreTables, setSelectedRestoreTables] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreForm] = Form.useForm();
  const [restoreProgress, setRestoreProgress] = useState<{
    status: string;
    progress: number;
    message: string;
    currentTable: string;
    totalTables: number;
    doneTables: number;
  } | null>(null);
  const restoreProgressTimer = useRef<any>(null);
  const [requirePassword, setRequirePassword] = useState(false);
  const [tableSearchText, setTableSearchText] = useState('');
  const [configDatabases, setConfigDatabases] = useState<string[]>([]);
  const [loadingConfigDatabases, setLoadingConfigDatabases] = useState(false);
  const [configRequirePassword, setConfigRequirePassword] = useState(false);
  const [showRestoreButton, setShowRestoreButton] = useState(false);
  const [stoppingRestore, setStoppingRestore] = useState(false);

  const handleStopRestore = async () => {
    if (!restoringLog) return;
    setStoppingRestore(true);
    try {
      const res = await stopBackupRestore(restoringLog.id);
      if (res.success) {
        message.success(res.message || '已成功发送中断信号');
      } else {
        message.error(res.message || '中断失败');
      }
    } catch (err: any) {
      message.error('中断失败: ' + err.message);
    } finally {
      setStoppingRestore(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        setShowRestoreButton(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    loadAll();
    checkPgDumpStatus();
    return () => {
      if (logTimer.current) clearInterval(logTimer.current);
      if (progressTimer.current) clearInterval(progressTimer.current);
      if (restoreProgressTimer.current) clearInterval(restoreProgressTimer.current);
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

  const fetchDatabasesForConfig = async (sourceId: number, password?: string) => {
    setLoadingConfigDatabases(true);
    try {
      const res = await getPgSourceDatabases(sourceId, password);
      if (res.success) {
        setConfigDatabases(res.data || []);
      } else {
        message.warning('获取数据库列表失败: ' + res.message);
        setConfigDatabases([]);
      }
    } catch (err: any) {
      console.error(err);
      setConfigDatabases([]);
    } finally {
      setLoadingConfigDatabases(false);
    }
  };

  const handleConfigSourceChange = (sourceId: number) => {
    form.setFieldsValue({ database_name: undefined, temp_password: undefined });
    const src = pgSources.find(s => s.id === sourceId);
    const needsPwd = !!(src && !src.password);
    setConfigRequirePassword(needsPwd);
    
    if (!needsPwd) {
      fetchDatabasesForConfig(sourceId);
    } else {
      setConfigDatabases([]);
    }
  };

  const openAdd = () => {
    setEditingId(null);
    setConfigDatabases([]);
    setConfigRequirePassword(false);
    form.resetFields();
    form.setFieldsValue({ backup_format: 'sql', enabled: 1 });
    setKeepDays(180);
    setEditOpen(true);
  };

  const openEdit = (cfg: BackupConfig) => {
    setEditingId(cfg.id);
    setConfigDatabases([]);
    
    const targetSource = sourceMap[cfg.pg_source_id];
    const needsPwd = targetSource && !targetSource.password;
    setConfigRequirePassword(!!needsPwd);
    
    form.setFieldsValue({
      name: cfg.name,
      pg_source_id: cfg.pg_source_id,
      database_name: cfg.database_name || undefined,
      backup_dir: cfg.backup_dir || '',
      backup_format: cfg.backup_format || 'sql',
      enabled: cfg.enabled === 1 || cfg.enabled === true,
    });
    setKeepDays(Number(cfg.keep_days));
    
    if (!needsPwd) {
      fetchDatabasesForConfig(cfg.pg_source_id);
    }
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

  // 打开恢复弹窗
  const handleOpenRestore = async (log: BackupLog) => {
    // 检查是否有正在运行的恢复任务，如果有，直接恢复显示进度
    try {
      const progRes = await getBackupRestoreProgress(log.id);
      if (progRes.success && progRes.data && progRes.data.status === 'running') {
        setRestoringLog(log);
        setRestoreProgress(progRes.data);
        setRestoring(true);
        setRestoreOpen(true);
        
        if (restoreProgressTimer.current) clearInterval(restoreProgressTimer.current);
        restoreProgressTimer.current = setInterval(async () => {
          try {
            const progRes2 = await getBackupRestoreProgress(log.id);
            if (progRes2.success && progRes2.data) {
              const progressData = progRes2.data;
              setRestoreProgress(progressData);
              
              if (progressData.status === 'success') {
                message.success('数据恢复成功！');
                setRestoring(false);
                if (restoreProgressTimer.current) {
                  clearInterval(restoreProgressTimer.current);
                  restoreProgressTimer.current = null;
                }
              } else if (progressData.status === 'error') {
                message.error('数据恢复失败: ' + progressData.message);
                setRestoring(false);
                if (restoreProgressTimer.current) {
                  clearInterval(restoreProgressTimer.current);
                  restoreProgressTimer.current = null;
                }
              }
            } else {
              if (progRes2.message && progRes2.message.includes('未找到')) {
                setRestoring(false);
                if (restoreProgressTimer.current) {
                  clearInterval(restoreProgressTimer.current);
                  restoreProgressTimer.current = null;
                }
              }
            }
          } catch (err) {
            console.error('获取数据恢复进度失败:', err);
          }
        }, 1500);
        return;
      }
    } catch (err) {
      console.error('检查恢复任务进度失败:', err);
    }

    setRestoringLog(log);
    setRestoreMode('all');
    setSelectedRestoreSchema(undefined);
    setSelectedRestoreTables([]);
    setRestoreDatabases([]);
    setDumpTables([]);
    setRestoreProgress(null);
    if (restoreProgressTimer.current) {
      clearInterval(restoreProgressTimer.current);
      restoreProgressTimer.current = null;
    }
    restoreForm.resetFields();
    
    // 自动回显数据源和数据库名
    const cfg = configs.find(c => c.id === log.config_id);
    if (cfg) {
      const sourceId = cfg.pg_source_id;
      const targetSource = sourceMap[sourceId];
      const isDisabled = targetSource && (targetSource.disable_import === 1 || targetSource.disable_import === true);
      
      if (!isDisabled) {
        const dbName = log.database_name || cfg.database_name || targetSource?.database || '';
        restoreForm.setFieldsValue({
          pg_source_id: sourceId,
          database_name: dbName
        });
        
        // 检查目标数据源是否配置了密码
        const needsPwd = targetSource && !targetSource.password;
        setRequirePassword(!!needsPwd);
        
        if (!needsPwd) {
          // 如果不需要临时输入密码，则直接加载该数据源下的数据库
          fetchDatabasesForSource(sourceId);
        } else {
          setRestoreDatabases([]);
        }
      } else {
        // 如果默认数据源被禁用导入，则清空默认数据源的选择，防止在下拉框显示不可点击的 raw ID 值 (如 2)
        restoreForm.setFieldsValue({
          pg_source_id: undefined,
          database_name: undefined
        });
        setRequirePassword(false);
      }
    }
    
    setRestoreOpen(true);
    setTableSearchText('');

    // 如果包含 dump 文件，则自动加载其中的表列表以供指定恢复
    const hasDump = log.backup_file?.split(',').some(f => f.trim().endsWith('.dump'));
    if (hasDump) {
      setLoadingTables(true);
      try {
        const res = await getBackupLogTables(log.id);
        if (res.success) {
          setDumpTables(res.data || []);
        } else {
          message.error('获取备份表结构失败: ' + res.message);
        }
      } catch (err: any) {
        message.error('获取备份表结构失败: ' + err.message);
      } finally {
        setLoadingTables(false);
      }
    }
  };

  // 关闭/取消恢复弹窗
  const handleCancelRestore = () => {
    setRestoreOpen(false);
    setRestoring(false);
    setRestoreProgress(null);
    setRequirePassword(false);
    setTableSearchText('');
    if (restoreProgressTimer.current) {
      clearInterval(restoreProgressTimer.current);
      restoreProgressTimer.current = null;
    }
  };

  // 恢复源更改时动态查询数据库
  const handleRestoreSourceChange = async (sourceId: number) => {
    restoreForm.setFieldsValue({ database_name: undefined, temp_password: undefined });
    const src = pgSources.find(s => s.id === sourceId);
    const needsPwd = !!(src && !src.password);
    setRequirePassword(needsPwd);
    
    if (!needsPwd) {
      fetchDatabasesForSource(sourceId);
    } else {
      setRestoreDatabases([]);
    }
  };

  const fetchDatabasesForSource = async (sourceId: number, password?: string) => {
    setLoadingDatabases(true);
    try {
      const res = await getPgSourceDatabases(sourceId, password);
      if (res.success) {
        setRestoreDatabases(res.data || []);
        
        // 如果当前没有选中的数据库，则默认填充该数据源对应的默认数据库
        const currentDb = restoreForm.getFieldValue('database_name');
        if (!currentDb) {
          const src = pgSources.find(s => s.id === sourceId);
          if (src) {
            restoreForm.setFieldsValue({ database_name: src.database });
          }
        }
      } else {
        message.warning('获取数据库列表失败: ' + res.message);
      }
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingDatabases(false);
    }
  };

  // 执行恢复操作
  const handleRestore = async () => {
    try {
      const values = await restoreForm.validateFields();
      if (restoreMode === 'custom' && selectedRestoreTables.length === 0) {
        message.warning('请选择至少一个要恢复的表');
        return;
      }
      if (restoreMode === 'schema' && !selectedRestoreSchema) {
        message.warning('请选择要恢复的 Schema');
        return;
      }

      const targetSource = pgSources.find(s => s.id === values.pg_source_id);

      Modal.confirm({
        title: '确认恢复数据库备份？',
        icon: <InfoCircleOutlined style={{ color: '#faad14' }} />,
        content: (
          <div>
            <p>您即将执行数据恢复，请<b>务必再次核对</b>以下目标库信息，防止选错破坏已有数据：</p>
            <Card size="small" style={{ background: '#fafafa', border: '1px solid #f0f0f0', margin: '12px 0' }}>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary">目标数据源: </Text>
                <Text strong>{targetSource?.name} ({targetSource?.host}:{targetSource?.port})</Text>
              </div>
              <div>
                <Text type="secondary">目标数据库: </Text>
                <Text type="danger" strong style={{ fontSize: 16 }}>{values.database_name}</Text>
              </div>
              <div style={{ marginTop: 6 }}>
                <Text type="secondary">恢复范围: </Text>
                <Text strong>
                  {restoreMode === 'custom' 
                    ? `指定表 (${selectedRestoreTables.length} 张表)` 
                    : restoreMode === 'schema' 
                    ? `指定 Schema (${selectedRestoreSchema})` 
                    : '整库备份 (全部恢复)'}
                </Text>
              </div>
              {values.overwrite && (
                <div style={{ marginTop: 6, color: '#ff4d4f', fontWeight: 'bold' }}>
                  ⚠️ 已启用“覆盖已存在的表”（将先 DROP 现有表再恢复数据）
                </div>
              )}
            </Card>
            <p style={{ color: '#8c8c8c', fontSize: 12 }}>确认无误请点击下方的“确认恢复”按钮开始执行。</p>
          </div>
        ),
        okText: '确认恢复',
        cancelText: '取消',
        onOk: async () => {
          setRestoring(true);
          setRestoreProgress({
            status: 'running',
            progress: 0,
            message: '准备恢复任务中...',
            currentTable: '',
            totalTables: restoreMode === 'custom' 
              ? selectedRestoreTables.length 
              : restoreMode === 'schema' 
              ? dumpTables.filter(t => t.schema === selectedRestoreSchema).length 
              : 0,
            doneTables: 0
          });
          
          const payload = {
            pg_source_id: values.pg_source_id,
            database_name: values.database_name,
            overwrite: !!values.overwrite,
            disable_triggers: !!values.disable_triggers,
            tables: restoreMode === 'custom' ? selectedRestoreTables : undefined,
            schema: restoreMode === 'schema' ? selectedRestoreSchema : undefined,
            temp_password: values.temp_password
          };

          if (!restoringLog) return;

          try {
            const res = await restoreBackupLog(restoringLog.id, payload);
            if (res.success) {
              message.info(res.message || '恢复任务已在后台启动，正在刷新进度...');
              
              // 启动轮询获取进度
              if (restoreProgressTimer.current) clearInterval(restoreProgressTimer.current);
              restoreProgressTimer.current = setInterval(async () => {
                try {
                  const progRes = await getBackupRestoreProgress(restoringLog.id);
                  if (progRes.success && progRes.data) {
                    const progressData = progRes.data;
                    setRestoreProgress(progressData);
                    
                    if (progressData.status === 'success') {
                      message.success('数据恢复成功！');
                      setRestoring(false);
                      if (restoreProgressTimer.current) {
                        clearInterval(restoreProgressTimer.current);
                        restoreProgressTimer.current = null;
                      }
                    } else if (progressData.status === 'error') {
                      message.error('数据恢复失败: ' + progressData.message);
                      setRestoring(false);
                      if (restoreProgressTimer.current) {
                        clearInterval(restoreProgressTimer.current);
                        restoreProgressTimer.current = null;
                      }
                    }
                  } else {
                    // 找不到该日志的恢复进度，可能是恢复时间很短瞬间结束了，或者超时被清除了
                    // 尝试停止轮询
                    if (progRes.message && progRes.message.includes('未找到')) {
                      setRestoring(false);
                      if (restoreProgressTimer.current) {
                        clearInterval(restoreProgressTimer.current);
                        restoreProgressTimer.current = null;
                      }
                    }
                  }
                } catch (err) {
                  console.error('获取数据恢复进度失败:', err);
                }
              }, 1500);
            } else {
              message.error('恢复失败: ' + res.message);
              setRestoring(false);
              setRestoreProgress(null);
            }
          } catch (err: any) {
            message.error('恢复操作失败: ' + (err.message || '未知错误'));
            setRestoring(false);
            setRestoreProgress(null);
          }
        }
      });
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('恢复操作失败: ' + (err.message || '未知错误'));
      setRestoring(false);
      setRestoreProgress(null);
    }
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
      title: '操作', key: 'action', width: 140, className: 'table-action-column',
      render: (_: any, r: BackupLog) => {
        if (r.status === 'running') {
          return (
            <Button size="small" danger icon={<StopOutlined />}
              loading={stoppingId === logConfigId}
              onClick={() => logConfigId && handleStop(logConfigId)}>
              停止
            </Button>
          );
        } else if (r.status === 'success' && r.backup_file) {
          if (!showRestoreButton) return '-';
          return (
            <Button size="small" type="primary" ghost icon={<HistoryOutlined />}
              onClick={() => handleOpenRestore(r)}>
              恢复
            </Button>
          );
        }
        return '-';
      }
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
    { title: '大小', dataIndex: 'file_size', key: 'size', width: 80, responsive: ['sm'] as any,
      render: (v: number) => v ? (v / 1024).toFixed(1) + ' KB' : '-' },
    { title: '开始时间', dataIndex: 'started_at', key: 'start', width: 150, responsive: ['sm'] as any },
    { title: '结束时间', dataIndex: 'finished_at', key: 'end', width: 150, responsive: ['md'] as any },
  ];

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
    { title: '数据源', dataIndex: 'pg_source_id', key: 'source', width: 120, responsive: ['sm'] as any,
      render: (v: number) => <Tag color="blue">{sourceMap[v]?.name || '#' + v}</Tag> },
    { title: '数据库', dataIndex: 'database_name', key: 'db', width: 120, responsive: ['md'] as any,
      render: (v: string, r: BackupConfig) => v || sourceMap[r.pg_source_id]?.database || '-' },
    { title: '备份格式', dataIndex: 'backup_format', key: 'format', width: 130, responsive: ['md'] as any,
      render: (v: string) => <Tag color={formatColors[v] || 'blue'}>{formatLabels[v] || v}</Tag> },
    { title: '备份目录', dataIndex: 'backup_dir', key: 'dir', width: 180, ellipsis: true, responsive: ['lg'] as any,
      render: (v: string) => v || <Text type="secondary">默认 backups/</Text> },
    { title: '保留天数', dataIndex: 'keep_days', key: 'keep', width: 70, responsive: ['sm'] as any, render: (v: number) => v + ' 天' },
    { title: '上次执行', dataIndex: 'last_run_at', key: 'last', width: 140, responsive: ['sm'] as any, render: (v: string) => v || '-' },
    { title: '状态', dataIndex: 'enabled', key: 'enabled', width: 60,
      render: (v: number) => <Badge status={v ? 'success' : 'default'} text={v ? '启用' : '禁用'} /> },
    {
      title: '操作', key: 'action', width: 260, className: 'table-action-column',
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

  const filteredDumpTables = dumpTables.filter(t => {
    const fullName = `${t.schema}.${t.name}`.toLowerCase();
    return fullName.includes(tableSearchText.toLowerCase());
  });

  return (
    <div className="responsive-page-container">
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
          <span>定时调度请到「<a href="/?page=taskManager" target="_blank">任务管理</a>」创建任务</span>
        </div>
        {isMobile ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Button type="primary" block icon={<PlusOutlined />} onClick={openAdd}>新增备份配置</Button>
            </div>
            {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
            {!loading && configs.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无配置</div>}
            {!loading && configs.map(r => {
              const srcName = sourceMap[r.pg_source_id]?.name || '#' + r.pg_source_id;
              const dbName = r.database_name || sourceMap[r.pg_source_id]?.database || '-';
              return (
                <Card
                  key={r.id}
                  size="small"
                  style={{ marginBottom: 12, borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                  title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 500 }}>{r.name}</span>
                    </div>
                  }
                  extra={<Badge status={r.enabled ? 'success' : 'default'} text={r.enabled ? '启用' : '禁用'} />}
                >
                  <div style={{ padding: '4px 0', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div><Text type="secondary">数据源:</Text> <Tag color="blue">{srcName}</Tag></div>
                    <div><Text type="secondary">数据库:</Text> <Text strong>{dbName}</Text></div>
                    <div><Text type="secondary">备份格式:</Text> <Tag color={formatColors[r.backup_format] || 'blue'}>{formatLabels[r.backup_format] || r.backup_format}</Tag></div>
                    <div><Text type="secondary">保留天数:</Text> {r.keep_days} 天</div>
                    <div><Text type="secondary">上次执行:</Text> {r.last_run_at || '-'}</div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8, flexWrap: 'wrap' }}>
                    <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => handleRun(r.id)} loading={runningId === r.id}>执行</Button>
                    <Button size="small" icon={<HistoryOutlined />} onClick={() => showLogs(r.id)}>日志</Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                    <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
                      <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <>
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
          </>
        )}
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
            <Select 
              placeholder="选择 PG 数据源" 
              options={pgSources.map(s => ({ value: s.id, label: s.name }))} 
              onChange={handleConfigSourceChange}
            />
          </Form.Item>
          {configRequirePassword && (
            <Form.Item
              label="临时连接密码"
              name="temp_password"
              rules={[{ required: true, message: '该数据源未在后台配置密码，必须手动输入密码才能获取数据库列表' }]}
              extra="此数据源未配置密码，请输入密码以继续。输入后点击下方刷新按钮或直接聚焦下一个表单项即可自动载入数据库。"
            >
              <Input.Password
                placeholder="请输入 PostgreSQL 数据库密码"
                onBlur={(e) => {
                  const val = e.target.value;
                  const sourceId = form.getFieldValue('pg_source_id');
                  if (sourceId && val) {
                    fetchDatabasesForConfig(sourceId, val);
                  }
                }}
              />
            </Form.Item>
          )}
          <Form.Item label="数据库名" required={false} extra="留空则默认使用数据源配置中默认的主数据库">
            <div style={{ display: 'flex', gap: 8 }}>
              <Form.Item
                name="database_name"
                noStyle
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="选择要备份的数据库"
                  loading={loadingConfigDatabases}
                  options={configDatabases.map(db => ({ value: db, label: db }))}
                  style={{ flex: 1 }}
                />
              </Form.Item>
              <Button
                icon={<ReloadOutlined />}
                loading={loadingConfigDatabases}
                onClick={() => {
                  const sourceId = form.getFieldValue('pg_source_id');
                  const pwd = form.getFieldValue('temp_password');
                  if (sourceId) {
                    fetchDatabasesForConfig(sourceId, pwd);
                  } else {
                    message.warning('请先选择 PG 数据源');
                  }
                }}
                title="刷新数据库列表"
              />
            </div>
          </Form.Item>
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

      {/* 恢复数据 Modal */}
      <Modal
        title="恢复数据库备份"
        open={restoreOpen}
        onCancel={handleCancelRestore}
        width={650}
        maskClosable={false}
        destroyOnClose
        footer={
          restoreProgress ? (
            restoreProgress.status === 'running' ? (
              <Space>
                <Button danger loading={stoppingRestore} onClick={handleStopRestore}>
                  中断恢复
                </Button>
                <Button type="primary" onClick={handleCancelRestore}>
                  后台运行
                </Button>
              </Space>
            ) : (
              <Button type="primary" onClick={handleCancelRestore}>
                关闭
              </Button>
            )
          ) : (
            <Space>
              <Button onClick={handleCancelRestore}>取消</Button>
              <Button type="primary" loading={restoring} onClick={handleRestore}>
                开始恢复
              </Button>
            </Space>
          )
        }
      >
        {restoreProgress ? (
          <div style={{ padding: '10px 0' }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              {restoreProgress.status === 'running' && (
                <Spin indicator={<LoadingOutlined style={{ fontSize: 24, marginBottom: 8 }} spin />} />
              )}
              <h3 style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>
                {restoreProgress.status === 'running' && '正在恢复数据...'}
                {restoreProgress.status === 'success' && '数据恢复成功！'}
                {restoreProgress.status === 'error' && '数据恢复失败'}
              </h3>
            </div>

            <div style={{ marginBottom: 20 }}>
              <Progress
                percent={restoreProgress.progress}
                status={
                  restoreProgress.status === 'error'
                    ? 'exception'
                    : restoreProgress.status === 'success'
                    ? 'success'
                    : 'active'
                }
                strokeWidth={8}
              />
            </div>

            <Card size="small" style={{ background: '#fafafa', border: '1px solid #f0f0f0' }}>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary">备份文件: </Text>
                <Text strong>{restoringLog?.backup_file}</Text>
              </div>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary">目标数据库: </Text>
                <Text strong>{restoreForm.getFieldValue('database_name')}</Text>
              </div>
              {restoreProgress.totalTables > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <Text type="secondary">恢复进度: </Text>
                  <Text strong>{restoreProgress.status === 'success' ? restoreProgress.totalTables : restoreProgress.doneTables} / {restoreProgress.totalTables} 张表</Text>
                </div>
              )}
              {restoreProgress.currentTable && (
                <div style={{ marginBottom: 6 }}>
                  <Text type="secondary">当前表: </Text>
                  <Text code>{restoreProgress.currentTable}</Text>
                </div>
              )}
              <div>
                <Text type="secondary">当前状态: </Text>
                <Text type={restoreProgress.status === 'error' ? 'danger' : 'secondary'}>
                  {restoreProgress.message}
                </Text>
              </div>
            </Card>

            {restoreProgress.status === 'error' && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 16 }}
                message="错误详情"
                description={
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 150, overflowY: 'auto' }}>
                    {restoreProgress.message}
                  </div>
                }
              />
            )}
          </div>
        ) : (
          <>
            {restoringLog && (
              <div style={{ marginBottom: 16 }}>
                <Alert
                  type="warning"
                  showIcon
                  message="请谨慎操作"
                  description={
                    <div>
                      正在准备使用备份文件进行恢复：
                      <div style={{ wordBreak: 'break-all', marginTop: 4 }}>
                        文件: <Text code>{restoringLog.backup_file}</Text>
                      </div>
                      <div>备份时间: {restoringLog.started_at}</div>
                    </div>
                  }
                />
              </div>
            )}
            
            <Form form={restoreForm} layout="vertical" initialValues={{ restore_mode: 'all', overwrite: false, disable_triggers: true }}>
              <Form.Item
                label="目标数据源"
                name="pg_source_id"
                rules={[{ required: true, message: '请选择目标数据源' }]}
              >
                <Select
                  placeholder="请选择要恢复到的 PostgreSQL 数据源"
                  options={pgSources.filter(s => s.disable_import !== 1 && s.disable_import !== true).map(s => ({ value: s.id, label: `${s.name} (${s.host}:${s.port})` }))}
                  onChange={handleRestoreSourceChange}
                />
              </Form.Item>

              {requirePassword && (
                <Form.Item
                  label="临时连接密码"
                  name="temp_password"
                  rules={[{ required: true, message: '该数据源未在后台配置密码，必须手动输入密码才能进行备份恢复' }]}
                  extra="此数据源配置中未包含密码，请输入密码以继续。输入后点击下方刷新按钮或直接聚焦下一个表单项即可自动载入数据库。"
                >
                  <Input.Password
                    placeholder="请输入 PostgreSQL 数据库密码"
                    onBlur={(e) => {
                      const val = e.target.value;
                      const sourceId = restoreForm.getFieldValue('pg_source_id');
                      if (sourceId && val) {
                        fetchDatabasesForSource(sourceId, val);
                      }
                    }}
                  />
                </Form.Item>
              )}
              
              <Form.Item
                label="目标数据库"
                required
                extra="选择要将数据恢复 to 哪个数据库中，请确保该数据库已在目标服务器中存在"
              >
                <div style={{ display: 'flex', gap: 8 }}>
                  <Form.Item
                    name="database_name"
                    noStyle
                    rules={[{ required: true, message: '请选择目标数据库' }]}
                  >
                    <Select
                      showSearch
                      placeholder="选择目标数据库"
                      loading={loadingDatabases}
                      options={restoreDatabases.map(db => ({ value: db, label: db }))}
                      style={{ flex: 1 }}
                    />
                  </Form.Item>
                  <Button
                    icon={<ReloadOutlined />}
                    loading={loadingDatabases}
                    onClick={() => {
                      const sourceId = restoreForm.getFieldValue('pg_source_id');
                      const pwd = restoreForm.getFieldValue('temp_password');
                      if (sourceId) {
                        fetchDatabasesForSource(sourceId, pwd);
                      } else {
                        message.warning('请先选择目标数据源');
                      }
                    }}
                    title="刷新数据库列表"
                  />
                </div>
              </Form.Item>

              <Form.Item label="恢复范围" name="restore_mode">
                <Radio.Group onChange={(e) => setRestoreMode(e.target.value)} value={restoreMode}>
                  <Radio value="all">全部恢复</Radio>
                  <Radio value="schema" disabled={restoringLog && !restoringLog.backup_file.split(',').some(f => f.trim().endsWith('.dump'))}>
                    恢复指定 Schema
                    {restoringLog && !restoringLog.backup_file.split(',').some(f => f.trim().endsWith('.dump')) && (
                      <span style={{ color: '#ccc', fontSize: 12, marginLeft: 8 }}>(仅 DUMP 格式支持 Schema)</span>
                    )}
                  </Radio>
                  <Radio value="custom" disabled={restoringLog && !restoringLog.backup_file.split(',').some(f => f.trim().endsWith('.dump'))}>
                    恢复指定表
                    {restoringLog && !restoringLog.backup_file.split(',').some(f => f.trim().endsWith('.dump')) && (
                      <span style={{ color: '#ccc', fontSize: 12, marginLeft: 8 }}>(仅 DUMP 格式支持指定表)</span>
                    )}
                  </Radio>
                </Radio.Group>
              </Form.Item>

              {restoreMode === 'schema' && (
                <Form.Item label="选择要恢复的 Schema" required>
                  <Select
                    placeholder="请选择要恢复的 Schema"
                    value={selectedRestoreSchema}
                    onChange={(val) => setSelectedRestoreSchema(val)}
                    options={Array.from(new Set(dumpTables.map(t => t.schema))).map(s => ({ value: s, label: s }))}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              )}

              {restoreMode === 'custom' && (
                <Form.Item label="选择要恢复的表" required>
                  {dumpTables.length > 0 && (
                    <Input
                      placeholder="搜索备份文件中的表名..."
                      prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                      value={tableSearchText}
                      onChange={(e) => setTableSearchText(e.target.value)}
                      style={{ marginBottom: 8 }}
                      allowClear
                    />
                  )}
                  {selectedRestoreTables.length > 0 && (
                    <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fafafa', border: '1px dashed #d9d9d9', borderRadius: 4 }}>
                      <div style={{ marginBottom: 6, fontSize: 13, color: '#595959' }}>
                        已选择 <Text strong style={{ color: '#fa8c16' }}>{selectedRestoreTables.length}</Text> 个表：
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 85, overflowY: 'auto', padding: '2px 0' }}>
                        {selectedRestoreTables.map(tableKey => (
                          <Tag
                            key={tableKey}
                            closable
                            onClose={() => {
                              setSelectedRestoreTables(prev => prev.filter(k => k !== tableKey));
                            }}
                            color="orange"
                            style={{ margin: 0 }}
                          >
                            {tableKey}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ border: '1px solid #f0f0f0', borderRadius: 4, padding: 8, maxHeight: 250, overflowY: 'auto' }}>
                    {loadingTables ? (
                      <div style={{ textAlign: 'center', padding: 20 }}><Spin size="small" /> 正在读取备份文件中的表结构...</div>
                    ) : dumpTables.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: 10, color: '#999' }}>未检测到表结构</div>
                    ) : filteredDumpTables.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: 10, color: '#999' }}>未找到匹配的表</div>
                    ) : (
                      <Table
                        size="small"
                        pagination={false}
                        rowKey={r => `${r.schema}.${r.name}`}
                        dataSource={filteredDumpTables}
                        columns={[
                          { title: 'Schema', dataIndex: 'schema', key: 'schema', width: 120 },
                          { title: '表名', dataIndex: 'name', key: 'name' }
                        ]}
                        rowSelection={{
                          selectedRowKeys: selectedRestoreTables,
                          onSelect: (record, selected) => {
                            const key = `${record.schema}.${record.name}`;
                            if (selected) {
                              setSelectedRestoreTables(prev => [...prev, key]);
                            } else {
                              setSelectedRestoreTables(prev => prev.filter(k => k !== key));
                            }
                          },
                          onSelectAll: (selected, selectedRows, changeRows) => {
                            const changeKeys = changeRows.map(r => `${r.schema}.${r.name}`);
                            if (selected) {
                              setSelectedRestoreTables(prev => {
                                const unique = new Set([...prev, ...changeKeys]);
                                return Array.from(unique);
                              });
                            } else {
                              setSelectedRestoreTables(prev => prev.filter(k => !changeKeys.includes(k)));
                            }
                          }
                        }}
                      />
                    )}
                  </div>
                </Form.Item>
              )}

              <Form.Item name="disable_triggers" valuePropName="checked">
                <Checkbox>
                  禁用触发器
                  <span style={{ color: '#8c8c8c', marginLeft: 8, fontSize: 12 }}>
                    (推荐，防止恢复期间触发约束或触发器逻辑)
                  </span>
                </Checkbox>
              </Form.Item>

              <Form.Item name="overwrite" valuePropName="checked">
                <Checkbox>
                  覆盖已存在的表
                  <span style={{ color: '#ff4d4f', marginLeft: 8, fontSize: 12 }}>
                    (启用后，如果数据库中已存在同名表，将先 DROP 删除再重新创建，请务必确认目标库数据！)
                  </span>
                </Checkbox>
              </Form.Item>
            </Form>
          </>
        )}
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

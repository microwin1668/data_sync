import React, { useState, useEffect, useMemo } from 'react';
import {
  Card, Form, Input, Button, Space, message, Alert, Typography, Tabs, Table, Modal, Tag, Popconfirm, Tooltip, Checkbox, Row, Col, Spin, Select, Switch, InputNumber, AutoComplete
} from 'antd';
import {
  KeyOutlined, SaveOutlined, SendOutlined, DatabaseOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LinkOutlined, ApiOutlined, ExportOutlined, ImportOutlined, DownloadOutlined, UploadOutlined, MailOutlined,
} from '@ant-design/icons';
import { JsonView, allExpanded, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

import {
  getTokenConfig, saveTokenConfig, fetchAccessToken, exportConfig, importConfig, clearConfig,
  listPgSources, createPgSource, updatePgSource, deletePgSource, testPgSourceConnection,
  getEmailNotifyConfig, saveEmailNotifyConfig, sendNotifyTestEmail,
} from '../api';
import type { PgDatasource } from '../api';

const { Text } = Typography;

// ==================== Token 配置 Tab ====================

const TokenConfigTab: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    try {
      const res = await getTokenConfig();
      if (res.success && res.data) {
        form.setFieldsValue({ key: res.data.key, secret: res.data.secret, token_url: res.data.token_url });
        setAccessToken(res.data.access_token || '');
      }
    } catch (err: any) { message.error('加载配置失败: ' + err.message); }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true); setError('');
      const res = await saveTokenConfig(values);
      if (res.success) message.success('Token 配置保存成功');
      else message.error(res.message);
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + err.message);
    } finally { setLoading(false); }
  };

  const handleFetchToken = async () => {
    try { await form.validateFields(); }
    catch { message.warning('请先填写并保存 Token 配置'); return; }
    setFetching(true); setError('');
    try {
      const res = await fetchAccessToken();
      if (res.success) { setAccessToken(res.token); message.success(res.message); }
      else { setError(res.message); message.error(res.message); }
    } catch (err: any) {
      const errMsg = '请求失败: ' + err.message;
      setError(errMsg); message.error(errMsg);
    } finally { setFetching(false); }
  };

  return (
    <div>
      <Form form={form} layout="vertical" style={{ maxWidth: 700 }}>
        <Form.Item label="Token URL" name="token_url"
          rules={[{ required: true, message: '请输入 Token URL' }]}
          extra="获取 access_token 的完整 URL 地址"
        >
          <Input placeholder="http://dataapi.example.com/open_api/authentication/get_access_token" />
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item label="Key" name="key">
              <Input placeholder="key 参数值（如有）" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="Secret" name="secret">
              <Input.Password placeholder="secret 参数值（如有）" />
            </Form.Item>
          </Col>
        </Row>
        <Space>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>保存配置</Button>
          <Button icon={<SendOutlined />} onClick={handleFetchToken} loading={fetching}>获取 Token</Button>
        </Space>
      </Form>
      {accessToken && (
        <Card size="small" title="Access Token" style={{ marginTop: 24, maxWidth: 700 }} type="inner">
          <Text code copyable style={{ fontSize: 13, wordBreak: 'break-all' }}>{accessToken}</Text>
        </Card>
      )}
      {error && <Alert message="请求失败" description={error} type="error" showIcon style={{ marginTop: 16, maxWidth: 700 }} />}
    </div>
  );
};

// ==================== PG 数据源管理 Tab ====================

const PgSourcesTab: React.FC = () => {
  const [sources, setSources] = useState<PgDatasource[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { success: boolean; message: string; version?: string }>>({});

  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => { loadSources(); }, []);

  const loadSources = async () => {
    setLoading(true);
    try {
      const res = await listPgSources();
      if (res.success) setSources(res.data);
    } catch { message.error('加载数据源列表失败'); }
    finally { setLoading(false); }
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({ port: '5432', schema: 'public', disable_import: false });
    setModalOpen(true);
  };

  const openEdit = (record: PgDatasource) => {
    setEditingId(record.id);
    form.setFieldsValue({
      ...record,
      disable_import: record.disable_import === 1 || record.disable_import === true
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingId) {
        await updatePgSource(editingId, values);
        message.success('数据源更新成功');
      } else {
        await createPgSource(values);
        message.success('数据源添加成功');
      }
      setModalOpen(false);
      loadSources();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + (err.message || ''));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deletePgSource(id);
      message.success('数据源已删除');
      loadSources();
    } catch { message.error('删除失败'); }
  };

  const handleTest = async (record: PgDatasource) => {
    setTestingId(record.id);
    setTestResults(prev => ({ ...prev, [record.id]: undefined as any }));
    try {
      const res = await testPgSourceConnection({
        host: record.host, port: record.port,
        user: record.user, password: record.password, database: record.database,
      });
      setTestResults(prev => ({
        ...prev,
        [record.id]: {
          success: res.success,
          message: res.message,
          version: res.data?.version,
        }
      }));
      if (res.success) message.success(record.name + ' 连接成功');
      else message.error(record.name + ' ' + res.message);
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [record.id]: { success: false, message: '请求失败: ' + err.message } }));
      message.error('测试失败: ' + err.message);
    } finally { setTestingId(null); }
  };

  const columns = [
    {
      title: '名称', dataIndex: 'name', key: 'name', width: 140,
      render: (v: string) => <><DatabaseOutlined style={{ marginRight: 6 }} />{v}</>,
    },
    { title: '主机', dataIndex: 'host', key: 'host', width: 140, responsive: ['md'] as any },
    { title: '端口', dataIndex: 'port', key: 'port', width: 70, responsive: ['md'] as any },
    { title: '用户名', dataIndex: 'user', key: 'user', width: 100, responsive: ['md'] as any },
    {
      title: '数据库', key: 'database', width: 130, responsive: ['sm'] as any,
      render: (_: any, r: PgDatasource) => r.database + (r.schema !== 'public' ? '/' + r.schema : ''),
    },
    {
      title: '状态', key: 'status', width: 120,
      render: (_: any, r: PgDatasource) => {
        const tr = testResults[r.id];
        if (testingId === r.id) return <Tag color="processing">测试中...</Tag>;
        if (!tr) return <Tag>未测试</Tag>;
        return tr.success
          ? <Tag color="success"><CheckCircleOutlined /> 连接成功</Tag>
          : <Tooltip title={tr.message}><Tag color="error"><CloseCircleOutlined /> 连接失败</Tag></Tooltip>;
      },
    },
    {
      title: '导入限制', key: 'disable_import', width: 100,
      render: (_: any, r: PgDatasource) => r.disable_import ? <Tag color="error">禁止导入</Tag> : <Tag color="success">允许导入</Tag>
    },
    {
      title: '操作', key: 'action', width: 200, className: 'table-action-column',
      render: (_: any, r: PgDatasource) => (
        <Space>
          <Button size="small" icon={<CheckCircleOutlined />} onClick={() => handleTest(r)} loading={testingId === r.id}>测试</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title="确定删除此数据源？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {isMobile ? (
        <div>
          <div style={{ marginBottom: 16 }}>
            <Button type="primary" block icon={<PlusOutlined />} onClick={openAdd}>添加数据源</Button>
          </div>
          {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
          {!loading && sources.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无数据源</div>}
          {!loading && sources.map(r => {
            const tr = testResults[r.id];
            const renderStatus = () => {
              if (testingId === r.id) return <Tag color="processing">测试中...</Tag>;
              if (!tr) return <Tag>未测试</Tag>;
              return tr.success
                ? <Tag color="success"><CheckCircleOutlined /> 连接成功</Tag>
                : <Tooltip title={tr.message}><Tag color="error"><CloseCircleOutlined /> 连接失败</Tag></Tooltip>;
            };
            return (
              <Card
                key={r.id}
                size="small"
                style={{ marginBottom: 12, borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <DatabaseOutlined style={{ color: '#1677ff' }} />
                    <span style={{ fontWeight: 500 }}>{r.name}</span>
                  </div>
                }
                extra={renderStatus()}
              >
                <div style={{ padding: '4px 0', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><Text type="secondary">主机地址:</Text> <Text code>{r.host}:{r.port}</Text></div>
                  <div><Text type="secondary">数据库名:</Text> <Text strong>{r.database}</Text>{r.schema !== 'public' && <Text type="secondary"> / {r.schema}</Text>}</div>
                  <div><Text type="secondary">用户名:</Text> {r.user}</div>
                  <div><Text type="secondary">导入限制:</Text> {r.disable_import ? <Tag color="error">禁止导入</Tag> : <Tag color="success">允许导入</Tag>}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  <Button size="small" icon={<CheckCircleOutlined />} onClick={() => handleTest(r)} loading={testingId === r.id}>测试</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                  <Popconfirm title="确定删除此数据源？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加数据源</Button>
          </div>

          <Table
            dataSource={sources}
            columns={columns}
            rowKey="id"
            loading={loading}
            pagination={false}
            size="small"
            scroll={{ x: 'max-content' }}
          />
        </>
      )}

      <Modal
        title={editingId ? '编辑数据源' : '添加数据源'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="数据源名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：本地 PG、生产数据库" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={16}>
              <Form.Item label="主机地址" name="host" rules={[{ required: true, message: '请输入主机地址' }]}>
                <Input placeholder="localhost 或 IP" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item label="端口" name="port" rules={[{ required: true, message: '请输入端口' }]}>
                <Input placeholder="5432" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="用户名" name="user" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input placeholder="postgres" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="密码" name="password">
                <Input.Password placeholder="数据库密码" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="数据库名" name="database" rules={[{ required: true, message: '请输入数据库名' }]}>
                <Input placeholder="data_sync" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="Schema" name="schema">
                <Input placeholder="public" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="disable_import" valuePropName="checked">
            <Checkbox>
              禁止导入数据到此数据源
              <span style={{ color: '#ff4d4f', marginLeft: 8, fontSize: 12 }}>
                (启用后，在执行备份恢复时此数据源不会出现在目标选项中，防止误操作破坏数据)
              </span>
            </Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

// ==================== 配置导入/导出 Tab ====================

const categories = [
  { key: 'token', label: 'Token 配置' },
  { key: 'pg_sources', label: 'PG 数据源' },
  { key: 'remote_tables', label: '远程数据表' },
  { key: 'sync_configs', label: '数据导入配置' },
  { key: 'sync_tasks', label: '定时任务' },
  { key: 'backup_configs', label: '数据库备份配置' },
];

const ExportImportTab: React.FC = () => {
  const [selectedExport, setSelectedExport] = useState<string[]>([]);
  const [selectedClear, setSelectedClear] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [exportData, setExportData] = useState<string>('');
  const [jsonViewMode, setJsonViewMode] = useState(false);

  const parsedJson = useMemo(() => {
    try {
      return JSON.parse(exportData);
    } catch { return null; }
  }, [exportData]);

  const handleExport = async () => {
    if (selectedExport.length === 0 && !confirm('未选择分类，将导出所有配置。继续？')) return;
    setExporting(true);
    try {
      const res = await exportConfig(selectedExport);
      if (res.success) {
        const json = JSON.stringify(res.data, null, 2);
        setExportData(json);
        // 下载 JSON 文件
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'config_export_' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        message.success('导出成功');
      } else message.error(res.message);
    } catch (err: any) { message.error('导出失败: ' + err.message); }
    finally { setExporting(false); }
  };

  const handleImport = async () => {
    if (!exportData) { message.warning('请先粘贴或上传 JSON 配置数据'); return; }
    if (selectedExport.length === 0 && !confirm('未选择分类，将导入所有配置。继续？')) return;
    setImporting(true);
    try {
      const data = JSON.parse(exportData);
      const res = await importConfig(data, selectedExport);
      if (res.success) {
        const result = res.data;
        let msg = '导入完成: ' + (result?.imported || []).join(', ');
        if (result?.errors && result.errors.length > 0) msg += '，错误: ' + result.errors.join('; ');
        message.success(msg);
      } else message.error(res.message);
    } catch (err: any) {
      if (err instanceof SyntaxError) message.error('JSON 格式错误: ' + err.message);
      else message.error('导入失败: ' + err.message);
    }
    finally { setImporting(false); }
  };

  const handleClear = async () => {
    if (selectedClear.length === 0 && !confirm('未选择分类，将清空所有配置！确定？')) return;
    if (!confirm('确定要清空所选配置？此操作不可恢复！')) return;
    setClearing(true);
    try {
      const res = await clearConfig(selectedClear);
      if (res.success) message.success(res.message);
      else message.error(res.message);
    } catch (err: any) { message.error('清空失败: ' + err.message); }
    finally { setClearing(false); }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setExportData(ev.target?.result as string || '');
      message.info('已加载文件: ' + file.name);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div>
      <Card size="small" title="导出配置" type="inner" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <Checkbox.Group options={categories.map(c => ({ value: c.key, label: c.label }))}
            value={selectedExport} onChange={setSelectedExport as any} />
        </div>
        <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport} loading={exporting}>
          导出选中配置
        </Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>不选则导出所有</Text>
      </Card>

      <Card size="small" title="导入配置" type="inner" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Button icon={<UploadOutlined />} onClick={() => document.getElementById('config-file-input')?.click()}>
              选择 JSON 文件
            </Button>
            <input id="config-file-input" type="file" accept=".json" style={{ display: 'none' }}
              onChange={handleFileUpload} />
          </Space>
        </div>
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Button size="small" type={jsonViewMode ? 'primary' : 'default'} onClick={() => setJsonViewMode(true)}>
              树形视图
            </Button>
            <Button size="small" type={!jsonViewMode ? 'primary' : 'default'} onClick={() => setJsonViewMode(false)}>
              文本编辑
            </Button>
          </Space>
        </div>
        {jsonViewMode ? (
          <div className="json-tree-container" style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 12, border: '1px solid #d9d9d9', borderRadius: 6, padding: 8, maxHeight: 400, overflow: 'auto', background: '#fafafa' }}>
            {parsedJson ? (
              <JsonView data={parsedJson} shouldExpandNode={allExpanded} style={defaultStyles} />
            ) : (
              <Text type="warning">JSON 格式无效，无法显示树形视图</Text>
            )}
          </div>
        ) : (
          <Input.TextArea rows={8} value={exportData}
            onChange={e => setExportData(e.target.value)}
            placeholder="粘贴 JSON 配置数据或选择文件..." style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 12 }} />
        )}
        <Checkbox.Group options={categories.map(c => ({ value: c.key, label: c.label }))}
          value={selectedExport} onChange={setSelectedExport as any}
          style={{ marginBottom: 12, display: 'block' }} />
        <Button type="primary" icon={<ImportOutlined />} onClick={handleImport} loading={importing}>
          导入配置
        </Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>不选则导入所有</Text>
      </Card>

      <Card size="small" title="清空配置" type="inner">
        <div style={{ marginBottom: 12 }}>
          <Checkbox.Group options={categories.map(c => ({ value: c.key, label: c.label }))}
            value={selectedClear} onChange={setSelectedClear as any} />
        </div>
        <Button danger icon={<DeleteOutlined />} onClick={handleClear} loading={clearing}>
          清空选中配置
        </Button>
        <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>不选则清空所有</Text>
      </Card>
    </div>
  );
};

// ==================== 邮件告警 Tab ====================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 常用 SMTP 服务器预设(支持手动输入其他地址)
const SMTP_PRESETS = [
  { value: 'smtp.qq.com', label: 'smtp.qq.com(QQ 邮箱)' },
  { value: 'smtp.163.com', label: 'smtp.163.com(网易 163)' },
  { value: 'smtp.126.com', label: 'smtp.126.com(网易 126)' },
  { value: 'smtp.exmail.qq.com', label: 'smtp.exmail.qq.com(腾讯企业邮)' },
  { value: 'smtp.qiye.aliyun.com', label: 'smtp.qiye.aliyun.com(阿里企业邮)' },
  { value: 'smtp.gmail.com', label: 'smtp.gmail.com(Gmail)' },
  { value: 'smtp.office365.com', label: 'smtp.office365.com(Microsoft 365)' },
  { value: 'smtp.outlook.com', label: 'smtp.outlook.com(Outlook)' },
];

const EmailNotifyTab: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    try {
      const res = await getEmailNotifyConfig();
      if (res.success && res.data) {
        const d = res.data;
        form.setFieldsValue({
          smtp_host: d.smtp_host,
          smtp_port: Number(d.smtp_port) || 465,
          encrypt: d.smtp_secure ? 'ssl' : (Number(d.smtp_port) === 25 ? 'none' : 'starttls'),
          smtp_user: d.smtp_user,
          smtp_password: d.smtp_password,
          from_email: d.from_email,
          recipients: String(d.recipients || '').split(/[,;，；\s]+/).filter(Boolean),
          notify_backup_fail: !!d.notify_backup_fail,
          notify_sync_fail: !!d.notify_sync_fail,
          notify_crash: !!d.notify_crash,
          notify_file_backup_fail: d.notify_file_backup_fail === undefined ? true : !!d.notify_file_backup_fail,
          throttle_minutes: d.throttle_minutes,
          crash_throttle_minutes: d.crash_throttle_minutes,
        });
      }
    } catch (err: any) { message.error('加载邮件告警配置失败: ' + err.message); }
  };

  const handleEncryptChange = (v: string) => {
    const portMap: Record<string, number> = { ssl: 465, starttls: 587, none: 25 };
    const cur = form.getFieldValue('smtp_port');
    // 端口还是默认值时跟随加密方式自动切换
    if (!cur || cur === 465 || cur === 587 || cur === 25) {
      form.setFieldsValue({ smtp_port: portMap[v] });
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      const res = await saveEmailNotifyConfig({
        smtp_host: values.smtp_host,
        smtp_port: values.smtp_port,
        smtp_secure: values.encrypt === 'ssl' ? 1 : 0,
        smtp_user: values.smtp_user,
        smtp_password: values.smtp_password,
        from_email: values.from_email || '',
        recipients: (values.recipients || []).join(','),
        notify_backup_fail: values.notify_backup_fail ? 1 : 0,
        notify_sync_fail: values.notify_sync_fail ? 1 : 0,
        notify_crash: values.notify_crash ? 1 : 0,
        notify_file_backup_fail: values.notify_file_backup_fail ? 1 : 0,
        throttle_minutes: values.throttle_minutes,
        crash_throttle_minutes: values.crash_throttle_minutes,
      });
      if (res.success) message.success('邮件告警配置已保存');
      else message.error(res.message);
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + err.message);
    } finally { setLoading(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await sendNotifyTestEmail();
      if (res.success) message.success(res.message);
      else message.error(res.message);
    } catch (err: any) {
      message.error('请求失败: ' + err.message);
    } finally { setTesting(false); }
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16, maxWidth: 700 }}
        message="备份失败 / 同步失败 / 服务进程崩溃时,自动向以下收件人发送告警邮件(仅定时任务触发,手动执行不通知)"
      />
      <Form form={form} layout="vertical" style={{ maxWidth: 700 }}
        initialValues={{ encrypt: 'ssl', smtp_port: 465, notify_backup_fail: true, notify_sync_fail: true, notify_crash: true, notify_file_backup_fail: true, throttle_minutes: 30, crash_throttle_minutes: 10 }}>
        <Row gutter={16}>
          <Col xs={24} sm={14}>
            <Form.Item label="SMTP 服务器" name="smtp_host" rules={[{ required: true, message: '请输入 SMTP 服务器地址' }]}>
              <AutoComplete
                options={SMTP_PRESETS}
                placeholder="下拉选择常用服务器,或直接输入自定义地址"
                filterOption={(input, option) =>
                  String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={10}>
            <Form.Item label="加密方式" name="encrypt" rules={[{ required: true }]}>
              <Select onChange={handleEncryptChange} options={[
                { value: 'ssl', label: 'SSL/TLS (465)' },
                { value: 'starttls', label: 'STARTTLS (587)' },
                { value: 'none', label: '不加密 (25)' },
              ]} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={10}>
            <Form.Item label="端口" name="smtp_port" rules={[{ required: true, message: '请输入端口' }]}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={14}>
            <Form.Item label="发件人地址" name="from_email" extra="留空则使用 SMTP 账号作为发件人"
              rules={[{ pattern: EMAIL_RE, message: '邮箱格式不正确' }]}>
              <Input placeholder="可选,如 noreply@example.com" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item label="SMTP 账号(邮箱)" name="smtp_user" rules={[{ required: true, message: '请输入 SMTP 账号' }]}>
          <Input placeholder="发件邮箱账号" />
        </Form.Item>
        <Form.Item label="SMTP 密码 / 授权码" name="smtp_password" rules={[{ required: true, message: '请输入 SMTP 密码或授权码' }]}
          extra="QQ/163 等个人邮箱需使用授权码(非登录密码);企业邮箱通常为登录密码">
          <Input.Password placeholder="密码或授权码" />
        </Form.Item>
        <Form.Item label="收件人邮箱(可添加多个)" name="recipients"
          rules={[{ validator: (_: any, v: string[] = []) => {
            if (!v || v.length === 0) return Promise.reject(new Error('请至少添加一个收件人'));
            if (v.some((e: string) => !EMAIL_RE.test(e))) return Promise.reject(new Error('存在格式不正确的邮箱地址'));
            return Promise.resolve();
          } }]}>
          <Select mode="tags" placeholder="输入邮箱后回车添加,可添加多个" open={false} suffixIcon={null}
            tokenSeparators={[',', '，', ';', '；', ' ']} />
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} sm={6}>
            <Form.Item label="备份失败通知" name="notify_backup_fail" valuePropName="checked">
              <Switch checkedChildren="开" unCheckedChildren="关" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item label="文件备份失败通知" name="notify_file_backup_fail" valuePropName="checked">
              <Switch checkedChildren="开" unCheckedChildren="关" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item label="同步失败通知" name="notify_sync_fail" valuePropName="checked">
              <Switch checkedChildren="开" unCheckedChildren="关" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={6}>
            <Form.Item label="进程崩溃通知" name="notify_crash" valuePropName="checked">
              <Switch checkedChildren="开" unCheckedChildren="关" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item label="失败告警间隔(分钟)" name="throttle_minutes"
              extra="同一任务/配置的同类失败在该时间内只发一封,防轰炸"
              rules={[{ required: true, message: '请输入间隔(1-1440 分钟)' }]}>
              <InputNumber min={1} max={1440} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="崩溃告警间隔(分钟)" name="crash_throttle_minutes"
              extra="进程重启风暴时在该时间内只发一封崩溃邮件"
              rules={[{ required: true, message: '请输入间隔(1-1440 分钟)' }]}>
              <InputNumber min={1} max={1440} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Space>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>保存配置</Button>
          <Button icon={<SendOutlined />} onClick={handleTest} loading={testing}>发送测试邮件</Button>
        </Space>
        <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>「发送测试邮件」使用的是已保存的配置,请先保存再测试</div>
      </Form>
    </div>
  );
};

// ==================== 主页面 ====================

const TokenConfig: React.FC = () => {
  return (
    <div className="responsive-page-container">
      <Card title={<><ApiOutlined /> 系统配置</>}>
        <Tabs
          defaultActiveKey="token"
          items={[
            {
              key: 'token',
              label: <span><KeyOutlined /> Token 配置</span>,
              children: <TokenConfigTab />,
            },
            {
              key: 'pg',
              label: <span><DatabaseOutlined /> PostgreSQL 数据源</span>,
              children: <PgSourcesTab />,
            },
            {
              key: 'notify',
              label: <span><MailOutlined /> 邮件告警</span>,
              children: <EmailNotifyTab />,
            },
            {
              key: 'io',
              label: <span><ExportOutlined /> 配置导入/导出</span>,
              children: <ExportImportTab />,
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default TokenConfig;

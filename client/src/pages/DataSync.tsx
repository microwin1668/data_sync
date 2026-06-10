import React, { useState, useEffect } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Tag, Typography, Spin, Row, Col, Divider, Checkbox, Tooltip, Progress
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SwapOutlined, DownloadOutlined,
  EyeOutlined, ImportOutlined, QuestionCircleOutlined, StopOutlined,
} from '@ant-design/icons';
import {
  listSyncConfigs, createSyncConfig, updateSyncConfig, deleteSyncConfig,
  previewSyncData, importSyncData, importSyncDataStream, importCancelStream,
  listRemoteTables, listPgSources, listPgTablesInSource, listPgColumnsInSource, getRemoteTableFields, fetchRemoteData,
} from '../api';
import type { SyncConfig, RemoteTable, PgDatasource } from '../api';
import JsonTreeViewer from '../components/JsonTreeViewer';
import ConditionBuilder from "../components/ConditionBuilder";
import type { QueryParams, QueryCondition } from "../api";
const { Text } = Typography;

interface FieldMapping {
  key: string;
  srcField: string;
  distField: string;
  type: string;
  isPk: boolean;
  transformer: string;
  mappingValues: { key: string; fromValue: string; toValue: string }[];
  staticValue: string;
  customCode: string;
}

const genKey = () => Math.random().toString(36).slice(2);

const TRANSFORM_OPTIONS = [
  { value: 'none', label: '无转换' },
  { value: 'mapping', label: '值映射' },
  { value: 'static', label: '固定值' },
  { value: 'custom', label: '自定义函数' },
  { value: 'upper', label: '转大写' },
  { value: 'lower', label: '转小写' },
  { value: 'trim', label: '去空格' },
];

const defaultCustomCode = '// val 是源字段值, type 是字段类型\n// 返回转换后的值\nreturn val;';

const newField = (): FieldMapping => ({
  key: genKey(), srcField: '', distField: '', type: 'string', isPk: false,
  transformer: 'none', mappingValues: [{ key: genKey(), fromValue: '', toValue: '' }],
  staticValue: '', customCode: defaultCustomCode,
});

const DataSync: React.FC = () => {
  const [configs, setConfigs] = useState<SyncConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [remoteTables, setRemoteTables] = useState<RemoteTable[]>([]);
  const [pgSources, setPgSources] = useState<PgDatasource[]>([]);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [fields, setFields] = useState<FieldMapping[]>([newField()]);
  const [pgTables, setPgTables] = useState<string[]>([]);
  const [srcFields, setSrcFields] = useState<{ name: string; description: string }[]>([]);
  const [dstFields, setDstFields] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [srcFieldsLoading, setSrcFieldsLoading] = useState(false);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);
  const closeImportStream = React.useRef<(() => void) | null>(null);
  const [editPreviewData, setEditPreviewData] = useState<any>(null);
  const [editPreviewLoading, setEditPreviewLoading] = useState(false);  const defaultQuery: QueryParams = {
    conditions: [], logic: "and", page: 1, perPage: 200, orderField: "", orderDir: "asc",
  };
  const [editQuery, setEditQuery] = useState<QueryParams>(defaultQuery);  const handleCancelImport = async () => {
    if (importing !== null) {
      try {
        await importCancelStream(importing);
        message.info("正在中断导入，等待当前页处理完成...");
        // 不关闭 EventSource，让服务器返回 cancelled 事件来更新状态和失败记录
      } catch (err: any) {
        message.error("中断失败: " + (err.message || String(err)));
      }
    }
  };

    const [importResult, setImportResult] = useState('');
  const [importProgressOpen, setImportProgressOpen] = useState(false);
  const [importProgress, setImportProgress] = useState({ total: 0, imported: 0, success: 0, error: 0, page: 0, maxPage: 0, done: false, failedRecords: [], msg: "", logFilename: "" });
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfgRes, tblRes, pgRes] = await Promise.all([
        listSyncConfigs(), listRemoteTables(), listPgSources(),
      ]);
      if (cfgRes.success) setConfigs(cfgRes.data);
      if (tblRes.success) setRemoteTables(tblRes.data);
      if (pgRes.success) setPgSources(pgRes.data);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const onSelectPgSource = async (sourceId: number) => {
    const src = pgSources.find(s => s.id === sourceId);
    if (!src) return;
    try {
      const res = await listPgTablesInSource({
        host: src.host, port: src.port, user: src.user, password: src.password, database: src.database, schema: src.schema,
      });
      if (res.success) setPgTables(res.tables || []);
    } catch { setPgTables([]); }
  };

  const onSelectTargetTable = async (tableName: string) => {
    const src = pgSources.find(s => s.id === form.getFieldValue('pg_source_id'));
    if (!src || !tableName) return;
    try {
      const res = await listPgColumnsInSource({
        host: src.host, port: src.port, user: src.user, password: src.password, database: src.database, schema: src.schema, table: tableName,
      });
      if (res.success) setDstFields((res.columns || []).map((c: any) => c.name));
    } catch { setDstFields([]); }
  };

  const onSelectRemoteTable = async (tableId: number) => {
    setSrcFields([]);
    setSrcFieldsLoading(true);
    try {
      const res = await getRemoteTableFields(tableId);
      if (res.success && res.data) setSrcFields(res.data);
    } catch { /**/ }
    finally { setSrcFieldsLoading(false); }
  };

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    setFields([newField()]);
    setPgTables([]); setSrcFields([]); setDstFields([]);
    setEditQuery(defaultQuery);    setEditOpen(true);
    setEditPreviewData(null);  };

  const openEdit = async (cfg: SyncConfig) => {
    try {
      setEditingId(cfg.id);
      form.setFieldsValue({
        name: cfg.name, remote_table_id: cfg.remote_table_id, pg_source_id: cfg.pg_source_id,
        target_table: cfg.target_table, page: cfg.page, per_page: cfg.per_page,
      });
      setEditQuery(prev => ({ ...prev, perPage: cfg.per_page || 200 }));
      await onSelectPgSource(cfg.pg_source_id);
      await onSelectTargetTable(cfg.target_table);
      await onSelectRemoteTable(cfg.remote_table_id);
      try {
        const ms = JSON.parse(cfg.import_settings || '[]');
        if (Array.isArray(ms) && ms.length > 0) {
          setFields(ms.map((m: any) => ({
            key: genKey(), srcField: m.srcField || '', distField: m.distField || '',
            type: m.type || 'string', isPk: m.isPk || false,
            transformer: m.transformer?.methods || 'none',
            mappingValues: m.transformer?.mapping
              ? Object.entries(m.transformer.mapping).map(([from, to]) => ({ key: genKey(), fromValue: from, toValue: to as string }))
              : [{ key: genKey(), fromValue: '', toValue: '' }],
            staticValue: m.transformer?.value || '',
            customCode: m.transformer?.customCode || defaultCustomCode,
          })));
        } else {
          setFields([newField()]);
        }
      } catch { setFields([newField()]); }
      setEditPreviewData(null);    
      let parsedConditions: QueryCondition[] = [];
      try { 
        const pc = JSON.parse(cfg.conditions || '[]'); 
        if (Array.isArray(pc)) parsedConditions = pc;
      } catch {}
      setEditQuery({
        conditions: parsedConditions,
        logic: (cfg.logic as "and" | "or") || "and",
        page: cfg.page || 1,
        perPage: cfg.per_page || 200,
        orderField: cfg.order_field || "",
        orderDir: (cfg.order_dir as "asc" | "desc") || "asc",
      });    
      setEditOpen(true);
    } catch (e: any) {
      message.error("打开编辑失败: " + e.message);
    }
  };

  const addField = () => setFields(prev => [...prev, newField()]);
  const removeField = (key: string) => setFields(prev => prev.filter(f => f.key !== key));
  const updateField = (key: string, patch: Partial<FieldMapping>) =>
    setFields(prev => prev.map(f => f.key === key ? { ...f, ...patch } : f));

  const addMappingRow = (fieldKey: string) => {
    setFields(prev => prev.map(f =>
      f.key === fieldKey ? { ...f, mappingValues: [...f.mappingValues, { key: genKey(), fromValue: '', toValue: '' }] } : f
    ));
  };

  const updateMappingRow = (fieldKey: string, rowKey: string, patch: Partial<{ fromValue: string; toValue: string }>) => {
    setFields(prev => prev.map(f =>
      f.key === fieldKey ? {
        ...f,
        mappingValues: f.mappingValues.map(r => r.key === rowKey ? { ...r, ...patch } : r)
      } : f
    ));
  };

  const removeMappingRow = (fieldKey: string, rowKey: string) => {
    setFields(prev => prev.map(f =>
      f.key === fieldKey ? {
        ...f,
        mappingValues: f.mappingValues.length > 1
          ? f.mappingValues.filter(r => r.key !== rowKey)
          : f.mappingValues
      } : f
    ));
  };

  const buildSettings = () => fields.filter(f => f.srcField && f.distField).map(f => {
    const base: any = { srcField: f.srcField, distField: f.distField, type: f.type, isPk: f.isPk };
    if (f.transformer === 'mapping') {
      const map: Record<string, string> = {};
      f.mappingValues.filter(r => r.fromValue !== '').forEach(r => { map[r.fromValue] = r.toValue; });
      base.transformer = { methods: 'mapping', mapping: map };
    } else if (f.transformer === 'static') {
      base.transformer = { methods: 'static', value: f.staticValue };
    } else if (f.transformer === 'custom') {
      base.transformer = { methods: 'custom', customCode: f.customCode };
    } else if (f.transformer !== 'none') {
      base.transformer = { methods: f.transformer };
    }
    return base;
  });

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload = {
        name: values.name, remote_table_id: values.remote_table_id, pg_source_id: values.pg_source_id,
        target_table: values.target_table, target_pk: '', page: values.page || 1, per_page: editQuery.perPage || 200,
        import_settings: JSON.stringify(buildSettings()), all_import: 0,        conditions: JSON.stringify(editQuery.conditions),        logic: editQuery.logic,        order_field: editQuery.orderField,        order_dir: editQuery.orderDir,
      };
      if (editingId) { await updateSyncConfig(editingId, payload); message.success('更新成功'); }
      else { await createSyncConfig(payload); message.success('创建成功'); }
      setEditOpen(false);
      loadAll();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + (err.message || ''));
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => { await deleteSyncConfig(id); message.success('已删除'); loadAll(); };

  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return;
    Modal.confirm({
      title: `确定删除选中的 ${selectedKeys.length} 条导入配置？`,
      content: '删除后无法恢复',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        let errCount = 0;
        for (const id of selectedKeys) {
          try { await deleteSyncConfig(id); } catch { errCount++; }
        }
        if (errCount > 0) message.warning(`已删除 ${selectedKeys.length - errCount} 条，${errCount} 条失败`);
        else message.success(`成功删除 ${selectedKeys.length} 条导入配置`);
        setSelectedKeys([]);
        loadAll();
      },
    });
  };


  const handleEditFetchFields = async () => {
    const tableId = form.getFieldValue("remote_table_id");
    if (!tableId) { message.warning("请先选择远程数据表"); return; }
    const tbl = remoteTables.find(t => t.id === tableId);
    if (!tbl) { message.warning("未找到表配置"); return; }
    setEditPreviewLoading(true);
    setEditPreviewData(null);
    try {
      const q = { ...editQuery, page: 1, perPage: 5 };
      const res = await fetchRemoteData(q, tbl.data_api_url);
      if (res.success && res.data) {
        const records = res.data.records || [];
        // 应用字段映射转换
        const settings = buildSettings();
        const transformVal = (val: any, t: any, type: string): any => {
          if (!t) return val;
          switch (t.methods) {
            case 'custom':
              try { const fn = new Function("val", "type", t.customCode || "return val;"); return fn(val, type); } catch { return val; }
            case 'mapping': return t.mapping?.[String(val)] ?? val;
            case 'static': return t.value ?? val;
            case 'upper': return typeof val === 'string' ? val.toUpperCase() : val;
            case 'lower': return typeof val === 'string' ? val.toLowerCase() : val;
            case 'trim': return typeof val === 'string' ? val.trim() : val;
            default: return val;
          }
        };
        const transformed = records.map((record: any) => {
          const out: Record<string, any> = {};
          for (const s of settings) {
            out[s.distField] = transformVal(record[s.srcField], s.transformer, s.type);
          }
          return out;
        });
        setEditPreviewData(transformed);
        if (records.length > 0) {
          const fieldNames = Object.keys(records[0]);
          const knownFields: { name: string; description: string }[] = [];
          if (res.data.dataStruct) {
            for (const [name, desc] of Object.entries(res.data.dataStruct)) {
              knownFields.push({ name, description: desc as string });
            }
          } else {
            knownFields.push(...fieldNames.map(n => ({ name: n, description: "" })));
          }
          setSrcFields(knownFields);
          message.success("获取到 " + records.length + " 条数据，" + knownFields.length + " 个字段");
        } else {
          message.warning("未获取到数据记录");
        }
        return { records: transformed, rawResponse: res.data.rawResponse, total: res.data.total };
      } else {
        message.error(res.message);
      }
    } catch (err: any) {
      message.error("请求失败: " + err.message);
    } finally {
      setEditPreviewLoading(false);
    }
  };

  const handlePreview = async (id: number) => {
    setPreviewOpen(true); setPreviewData(null); setPreviewing(true);
    try {
      const res = await previewSyncData(id);
      if (res.success) setPreviewData(res.data);
      else message.error(res.message);
    } catch (err: any) { message.error(err.message); }
    finally { setPreviewing(false); }
  };

  const handleImport = (id: number) => {
    setImporting(id);
    setImportProgressOpen(true);
    setImportProgress({ total: 0, imported: 0, success: 0, error: 0, page: 0, maxPage: 0, done: false, failedRecords: [], msg: "", logFilename: "" });
    setImportResult("");
    
    const close = importSyncDataStream(id, (event, data) => {
      if (event === "start") {
        setImportProgress(prev => ({ ...prev, total: data.total, maxPage: data.maxPage }));
      } else if (event === "progress") {
        setImportProgress(prev => ({
          ...prev,
          imported: data.imported,
          success: data.success,
          error: data.error,
          page: data.page,
        }));
      } else if (event === "done") {
        setImportProgress(prev => ({ ...prev, success: data.success, error: data.error, done: true, failedRecords: data.failedRecords || [], msg: data.message, logFilename: data.logFilename || '' }));
        setImportResult(data.message);
        setImporting(null);
      } else if (event === "error") {
        message.error(data.message || "导入失败");
        setImportProgress(prev => ({ ...prev, done: true, msg: data.message }));
        setImporting(null);
        close();
      } else if (event === "cancelled") {
        setImportProgress(prev => ({ ...prev, done: true, msg: "导入已被中断", failedRecords: data.failedRecords || [], success: data.success || prev.success, error: data.error || prev.error, logFilename: data.logFilename || '' }));
        setImportResult("导入已被中断");
        setImporting(null);
      }
    });
    closeImportStream.current = close;
  };

  const columns = [
    { title: '配置名', dataIndex: 'name', key: 'name', width: 140 },
    { title: '目标表', dataIndex: 'target_table', key: 'target_table', width: 130, responsive: ['sm'] as any },
    {
      title: '映射', dataIndex: 'import_settings', key: 'settings', width: 70, responsive: ['sm'] as any,
      render: (v: string) => {
        try { return <Tag color="blue">{JSON.parse(v).length}</Tag>; }
        catch { return <Tag>-</Tag>; }
      },
    },
    {
      title: '操作', key: 'action', width: 300, className: 'table-action-column',
      render: (_: any, r: SyncConfig) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(r.id)}>预览</Button>
          <Button size="small" type="primary" icon={<ImportOutlined />}
            onClick={() => handleImport(r.id)} loading={importing === r.id}>导入</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="responsive-page-container">
      {isMobile ? (
        <Card title={<><SwapOutlined /> 数据导入配置</>}>
          <div style={{ marginBottom: 16 }}>
            <Button type="primary" block icon={<PlusOutlined />} onClick={openAdd}>新增导入配置</Button>
          </div>
          {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
          {!loading && configs.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无配置</div>}
          {!loading && configs.map(r => {
            let fieldCount = 0;
            try { fieldCount = JSON.parse(r.import_settings || '[]').length; } catch {}
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
                extra={<Tag color="blue">映射字段: {fieldCount}</Tag>}
              >
                <div style={{ padding: '4px 0', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><Text type="secondary">目标表:</Text> <Text strong>{r.target_table}</Text></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8, flexWrap: 'wrap' }}>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(r.id)}>预览</Button>
                  <Button size="small" type="primary" icon={<ImportOutlined />} onClick={() => handleImport(r.id)} loading={importing === r.id}>导入</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                  <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
              </Card>
            );
          })}
          {importResult && (
            <Card size="small" style={{ marginTop: 16, background: '#f6ffed' }}>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, color: "#389e0d" }}>{importResult}</pre>
            </Card>
          )}
        </Card>
      ) : (
        <Card title={<><SwapOutlined /> 数据导入配置</>}>
          <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd} style={{ marginBottom: 16 }}>新增导入配置</Button>
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
          {importResult && (
            <Card size="small" style={{ marginTop: 16, background: '#f6ffed' }}>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, color: "#389e0d" }}>{importResult}</pre>
            </Card>
          )}
        </Card>
      )}


      {/* 导入进度弹窗 */}
      <Modal title="导入进度" open={importProgressOpen} footer={null} width={450}
        maskClosable={false} closable={importProgress.done}
        onCancel={() => { if (importProgress.done) setImportProgressOpen(false); }}>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <div style={{ textAlign: "center", fontSize: 14 }}>
            {importProgress.done
              ? `导入完成: ${importProgress.success} 成功, ${importProgress.error} 失败`
              : `正在导入... 第 ${importProgress.page}/${importProgress.maxPage} 页`}
          </div>
          <Progress
            percent={importProgress.total > 0
              ? Math.round((importProgress.imported / importProgress.total) * 100)
              : (importProgress.done ? 100 : 0)}
            status={importProgress.done ? (importProgress.error > 0 ? "exception" : "success") : "active"}
            format={() => `${importProgress.imported} / ${importProgress.total}`}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#8c8c8c" }}>
            <span>成功: <b style={{ color: "#52c41a" }}>{importProgress.success}</b></span>
            <span>失败: <b style={{ color: "#ff4d4f" }}>{importProgress.error}</b></span>
            <span>总数: <b>{importProgress.total}</b></span>
          </div>
          {!importProgress.done && (
            <Button icon={<StopOutlined />} block danger onClick={handleCancelImport}
              style={{ marginBottom: 8 }}>
              中断导入
            </Button>
          )}
          {importProgress.done && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {importProgress.error > 0 && (
                <>
                  {importProgress.logFilename ? (
                    <Button icon={<DownloadOutlined />} block type="primary"
                      href={"/api/logs/" + importProgress.logFilename}
                      target="_blank">
                      下载失败日志 ({importProgress.error} 条)
                    </Button>
                  ) : (
                    <Button icon={<DownloadOutlined />} block
                      onClick={() => {
                        const rows = importProgress.failedRecords || [];
                        if (rows.length === 0) { message.warning("没有失败记录可下载"); return; }
                        const fields = Object.keys(rows[0].data || {});
                        let csv = "\ufeff";
                        csv += [...fields, "失败原因"].join(",") + "\n";
                        for (const r of rows) {
                          const vals = fields.map(f => {
                            const v = r.data[f];
                            const s = v === null || v === undefined ? "" : String(v);
                            if (s.includes(",") || s.includes('"')) {
                              return '"' + s.replace(/"/g, '""') + '"';
                            }
                            return s;
                          });
                          const reason = (r.reason || "").replace(/"/g, '""');
                          csv += vals.join(",") + ',"' + reason + '"\n';
                        }
                        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "fail_import_" + new Date().toISOString().slice(0, 10) + ".csv";
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                      }}>
                      下载失败数据 ({importProgress.error} 条)
                    </Button>
                  )}
                </>
              )}
              <Button type="primary" block onClick={() => setImportProgressOpen(false)}>
                关闭
              </Button>
            </div>
          )}
        </Space>
      </Modal>

      {/* 编辑弹窗 90% */}
      <Modal title={editingId ? '编辑导入配置' : '新增导入配置'} open={editOpen}
        onOk={handleSave} onCancel={() => setEditOpen(false)} okText="保存" cancelText="取消"
        width="90%" style={{ top: 20 }}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item label="配置名称" name="name" rules={[{ required: true }]}>
                <Input placeholder="如：单位信息导入" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item label="远程数据表" name="remote_table_id" rules={[{ required: true }]}>
                <Select placeholder="选择数据源表" options={remoteTables.map(t => ({ value: t.id, label: t.name }))}
                  onChange={onSelectRemoteTable} allowClear />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item label="PG 数据源" name="pg_source_id" rules={[{ required: true }]}>
                <Select placeholder="选择数据库" options={pgSources.map(s => ({ value: s.id, label: s.name }))}
                  onChange={val => { onSelectPgSource(val); form.setFieldsValue({ target_table: undefined }); }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item label="目标表" name="target_table" rules={[{ required: true }]}>
                <Select placeholder="选择表" options={pgTables.map(t => ({ value: t, label: t }))}
                  onChange={onSelectTargetTable} showSearch />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="每页条数" name="per_page">
                <Select options={[50, 100, 200, 500, 1000].map(n => ({ value: n, label: String(n) }))} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item label="起始页" name="page">
                <Input type="number" min={1} />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <ConditionBuilder value={editQuery} onChange={setEditQuery}
          knownFields={Object.fromEntries(srcFields.map(f => [f.name, f.description]))}
          onPreview={handleEditFetchFields} />

        <Space style={{ marginBottom: 12 }}>
          <Button icon={<EyeOutlined />} onClick={handleEditFetchFields}
            loading={editPreviewLoading}
            disabled={!form.getFieldValue("remote_table_id")}>
            获取远程字段结构
          </Button>
          {srcFields.length > 0 && (
            <Tag color="blue">{srcFields.length} 个字段</Tag>
          )}
        </Space>

        {editPreviewData && editPreviewData.length > 0 && (
          <Card size="small" title="样本数据" style={{ marginBottom: 12 }} type="inner">
            <JsonTreeViewer data={editPreviewData.slice(0, 3)} defaultExpanded={false} maxHeight={200} />
          </Card>
        )}
        <Divider plain>
          字段映射
          <Tooltip title="至少勾选一个主键，用于 upsert 的 ON CONFLICT">
            <QuestionCircleOutlined style={{ marginLeft: 6 }} />
          </Tooltip>
        </Divider>

        {srcFieldsLoading && <Spin size="small" style={{ marginBottom: 8 }} />}

        {fields.map((f, i) => (
          <div key={f.key} style={{ marginBottom: 8 }}>
            {isMobile ? (
              <Card
                size="small"
                style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 8 }}
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>字段 #{i + 1} {f.isPk && <Tag color="gold" style={{ marginLeft: 6 }}>PK</Tag>}</span>
                    <Space size="small">
                      <Checkbox checked={f.isPk} onChange={e => updateField(f.key, { isPk: e.target.checked })}>主键</Checkbox>
                      <Button size="small" danger onClick={() => removeField(f.key)} disabled={fields.length <= 1}>删除</Button>
                    </Space>
                  </div>
                }
              >
                <Row gutter={[8, 8]}>
                  <Col xs={24}>
                    <div style={{ marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 2 }}>源字段:</span>
                      <Select placeholder="源字段" style={{ width: '100%' }} size="small" showSearch
                        value={f.srcField || undefined}
                        onChange={val => updateField(f.key, { srcField: val || '' })}
                        filterOption={(input, option) => {
                          const lbl = String(option?.label ?? '').toLowerCase();
                          const val = String(option?.value ?? '').toLowerCase();
                          return lbl.includes(input.toLowerCase()) || val.includes(input.toLowerCase());
                        }}
                        options={srcFields.map(s => ({
                          value: s.name,
                          label: `${s.name} ${s.description ? '('+s.description+')' : ''}`,
                        }))}
                        loading={srcFieldsLoading}
                      />
                    </div>
                  </Col>
                  <Col xs={24}>
                    <div style={{ marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 2 }}>目标字段:</span>
                      <Select placeholder="目标字段" style={{ width: '100%' }} size="small" showSearch
                        value={f.distField || undefined}
                        onChange={val => updateField(f.key, { distField: val || '' })}
                        options={dstFields.map(d => ({ value: d, label: d }))}
                      />
                    </div>
                  </Col>
                  <Col xs={12}>
                    <div style={{ marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 2 }}>类型:</span>
                      <Select size="small" style={{ width: '100%' }} value={f.type}
                        onChange={val => updateField(f.key, { type: val })}
                        options={[
                          { value: 'string', label: 'string' }, { value: 'number', label: 'number' },
                          { value: 'integer', label: 'integer' }, { value: 'boolean', label: 'boolean' },
                        ]} />
                    </div>
                  </Col>
                  <Col xs={12}>
                    <div style={{ marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 2 }}>转换器:</span>
                      <Select size="small" style={{ width: '100%' }} value={f.transformer}
                        onChange={val => updateField(f.key, { transformer: val })}
                        options={TRANSFORM_OPTIONS} />
                    </div>
                  </Col>
                </Row>
              </Card>
            ) : (
              <Row gutter={6} style={{ background: '#fafafa', padding: '6px 0', borderRadius: 6, alignItems: 'center' }}>
                <Col span={1} style={{ textAlign: 'center', lineHeight: '32px', fontSize: 12, color: '#8c8c8c' }}>{i + 1}</Col>
                <Col span={3}>
                  <Select placeholder="源字段" style={{ width: '100%' }} size="small" showSearch
                    value={f.srcField || undefined}
                    onChange={val => updateField(f.key, { srcField: val || '' })}
                    filterOption={(input, option) => {
                      const lbl = String(option?.label ?? '').toLowerCase();
                      const val = String(option?.value ?? '').toLowerCase();
                      return lbl.includes(input.toLowerCase()) || val.includes(input.toLowerCase());
                    }}
                    options={srcFields.map(s => ({
                      value: s.name,
                      label: React.createElement('span', null,
                        s.name,
                        React.createElement('span', { style: { color: '#8c8c8c', fontSize: 11, marginLeft: 6 } }, s.description)
                      ),
                    }))}
                    loading={srcFieldsLoading}
                  />
                </Col>
                <Col span={1} style={{ textAlign: 'center' }}>→</Col>
                <Col span={3}>
                  <Select placeholder="目标字段" style={{ width: '100%' }} size="small" showSearch
                    value={f.distField || undefined}
                    onChange={val => updateField(f.key, { distField: val || '' })}
                    options={dstFields.map(d => ({ value: d, label: d }))}
                  />
                </Col>
                <Col span={2}>
                  <Select size="small" style={{ width: '100%' }} value={f.type}
                    onChange={val => updateField(f.key, { type: val })}
                    options={[
                      { value: 'string', label: 'string' }, { value: 'number', label: 'number' },
                      { value: 'integer', label: 'integer' }, { value: 'boolean', label: 'boolean' },
                    ]} />
                </Col>
                <Col span={2}>
                  <Select size="small" style={{ width: '100%' }} value={f.transformer}
                    onChange={val => updateField(f.key, { transformer: val })}
                    options={TRANSFORM_OPTIONS} />
                </Col>
                <Col span={1} style={{ textAlign: 'center' }}>
                  <Tooltip title="主键">
                    <Checkbox checked={f.isPk} onChange={e => updateField(f.key, { isPk: e.target.checked })} />
                  </Tooltip>
                </Col>
                <Col span={1}>
                  <Button size="small" danger onClick={() => removeField(f.key)} disabled={fields.length <= 1}>删</Button>
                </Col>
              </Row>
            )}
            {/* 值映射配置 */}
            {f.transformer === 'mapping' && (
              <div style={{ marginLeft: isMobile ? 8 : 30, marginTop: 4, background: '#fffbe6', padding: '4px 8px', borderRadius: 4 }}>
                {f.mappingValues.map((r) => (
                  <Space key={r.key} style={{ marginBottom: 2 }} wrap>
                    <Input size="small" placeholder="原始值" style={{ width: 80 }}
                      value={r.fromValue} onChange={e => updateMappingRow(f.key, r.key, { fromValue: e.target.value })} />
                    <span>→</span>
                    <Input size="small" placeholder="目标值" style={{ width: 80 }}
                      value={r.toValue} onChange={e => updateMappingRow(f.key, r.key, { toValue: e.target.value })} />
                    <Button size="small" type="text" danger onClick={() => removeMappingRow(f.key, r.key)}
                      disabled={f.mappingValues.length <= 1}>✕</Button>
                  </Space>
                ))}
                <Button size="small" type="link" onClick={() => addMappingRow(f.key)}>+ 添加映射</Button>
              </div>
            )}
            {/* 固定值配置 */}
            {f.transformer === 'static' && (
              <div style={{ marginLeft: isMobile ? 8 : 30, marginTop: 4 }}>
                <Input size="small" style={{ width: 200 }} placeholder="固定值"
                  value={f.staticValue} onChange={e => updateField(f.key, { staticValue: e.target.value })} />
              </div>
            )}
            {/* 自定义函数 */}
            {f.transformer === 'custom' && (
              <div style={{ marginLeft: isMobile ? 8 : 30, marginTop: 4 }}>
                <Input.TextArea
                  size="small"
                  rows={3}
                  style={{ fontFamily: 'monospace', fontSize: 12, width: '100%', maxWidth: isMobile ? '100%' : 400 }}
                  value={f.customCode}
                  onChange={e => updateField(f.key, { customCode: e.target.value })}
                  placeholder={defaultCustomCode}
                />
                <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 2 }}>
                  参数: val（源字段值）, type（字段类型）。必须 return 转换后的值。
                </div>
              </div>
            )}
          </div>
        ))}
        <Button size="small" type="dashed" onClick={addField}>+ 添加字段</Button>
      </Modal>

      {/* 预览弹窗 */}
      <Modal title="数据预览" open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null}
        width="90%" style={{ top: 20 }}>
        {previewing && <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="加载中..." /></div>}
        {previewData && (
          <>
            <Space style={{ marginBottom: 12 }}>
              <Tag color="blue">源数据总数: {previewData.sourceTotal}</Tag>
              <Tag>预览: {previewData.previewCount} 条</Tag>
            </Space>
            <Row gutter={16}>
              <Col xs={24} md={12} style={{ marginBottom: isMobile ? 12 : 0 }}>
                <Card size="small" title="源数据（原始）" type="inner">
                  <JsonTreeViewer data={previewData.sourceRecords} defaultExpanded={false} maxHeight={400} />
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="转换后（将写入目标表）" type="inner">
                  <JsonTreeViewer data={previewData.transformedRecords} defaultExpanded={false} maxHeight={400} />
                </Card>
              </Col>
            </Row>
          </>
        )}
      </Modal>
    </div>
  );
};

export default DataSync;

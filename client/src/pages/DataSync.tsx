import React, { useState, useEffect } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Tag, Typography, Spin, Row, Col, Divider, Checkbox, Tooltip, Progress, Collapse, AutoComplete
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SwapOutlined, DownloadOutlined,
  EyeOutlined, ImportOutlined, QuestionCircleOutlined, StopOutlined, ReloadOutlined, DatabaseOutlined,
  ThunderboltOutlined, CloseOutlined, ClearOutlined, CopyOutlined,
} from '@ant-design/icons';
import {
  listSyncConfigs, createSyncConfig, updateSyncConfig, deleteSyncConfig,
  previewSyncData, importSyncData, importSyncDataStream, importCancelStream,
  listRemoteTables, listPgSources, listPgTablesInSource, listPgColumnsInSource, getRemoteTableFields, fetchRemoteData,
  getPgSourceDatabases,
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

  // 复制配置弹窗
  const [copyOpen, setCopyOpen] = useState(false);
  const [copySrc, setCopySrc] = useState<SyncConfig | null>(null);
  const [copyForm] = Form.useForm();
  const [copySaving, setCopySaving] = useState(false);
  const [copyDatabases, setCopyDatabases] = useState<string[]>([]);
  const [copyTables, setCopyTables] = useState<string[]>([]);
  const [copyLoadingDb, setCopyLoadingDb] = useState(false);
  const [copyLoadingTables, setCopyLoadingTables] = useState(false);
  const [copyRequirePassword, setCopyRequirePassword] = useState(false);
  const [form] = Form.useForm();
  const [fields, setFields] = useState<FieldMapping[]>([newField()]);
  const [pgTables, setPgTables] = useState<string[]>([]);
  const [srcFields, setSrcFields] = useState<{ name: string; description: string }[]>([]);
  const [dstFields, setDstFields] = useState<{ name: string; type: string; comment: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [srcFieldsLoading, setSrcFieldsLoading] = useState(false);
  // 目标数据库（同一服务器多库同步）：从数据源所在服务器拉取数据库列表
  const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
  const [loadingTargetDatabases, setLoadingTargetDatabases] = useState(false);
  const [targetRequirePassword, setTargetRequirePassword] = useState(false);

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

  // 实际生效的目标库：配置指定了目标库则用它，否则用数据源默认库
  const getEffectiveDatabase = () => {
    const sourceId = form.getFieldValue('pg_source_id');
    const src = pgSources.find(s => s.id === sourceId);
    return (form.getFieldValue('target_database') || '').trim() || (src ? src.database : '');
  };

  const fetchDatabasesForTarget = async (sourceId: number, password?: string) => {
    setLoadingTargetDatabases(true);
    try {
      const res = await getPgSourceDatabases(sourceId, password);
      if (res.success) {
        setTargetDatabases(res.data || []);
      } else {
        message.warning('获取数据库列表失败: ' + (res.message || ''));
        setTargetDatabases([]);
      }
    } catch {
      setTargetDatabases([]);
    } finally {
      setLoadingTargetDatabases(false);
    }
  };

  const onSelectPgSource = async (sourceId: number) => {
    const src = pgSources.find(s => s.id === sourceId);
    if (!src) return;
    setTargetRequirePassword(!src.password);
    // 目标数据库为必填:选择数据源后自动填入该数据源的默认库
    form.setFieldsValue({ target_database: src.database || undefined });
    if (src.password) {
      fetchDatabasesForTarget(sourceId);
    } else {
      setTargetDatabases([]);
    }
    try {
      const res = await listPgTablesInSource({
        host: src.host, port: src.port, user: src.user, password: src.password, database: src.database, schema: src.schema,
      });
      if (res.success) setPgTables(res.tables || []);
    } catch { setPgTables([]); }
  };

  // 切换目标数据库后重新拉取该库下的表
  const onSelectTargetDatabase = async (dbName?: string) => {
    form.setFieldsValue({ target_table: undefined });
    setPgTables([]);
    setDstFields([]);
    const sourceId = form.getFieldValue('pg_source_id');
    const src = pgSources.find(s => s.id === sourceId);
    if (!src) return;
    const database = (dbName || '').trim() || src.database;
    try {
      const res = await listPgTablesInSource({
        host: src.host, port: src.port, user: src.user, password: src.password, database, schema: src.schema,
      });
      if (res.success) setPgTables(res.tables || []);
    } catch { setPgTables([]); }
  };

  const onSelectTargetTable = async (tableName: string) => {
    const sourceId = form.getFieldValue('pg_source_id');
    const src = pgSources.find(s => s.id === sourceId);
    if (!src || !tableName) return;
    const database = getEffectiveDatabase() || src.database;
    try {
      const res = await listPgColumnsInSource({
        host: src.host, port: src.port, user: src.user, password: src.password, database, schema: src.schema, table: tableName,
      });
      if (res.success) setDstFields(res.columns || []);
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
    setTargetDatabases([]); setTargetRequirePassword(false);
    setEditQuery(defaultQuery);    setEditOpen(true);
    setEditPreviewData(null);  };

  const openEdit = async (cfg: SyncConfig) => {
    try {
      setEditingId(cfg.id);
      const src = pgSources.find(s => s.id === cfg.pg_source_id);
      form.setFieldsValue({
        name: cfg.name, remote_table_id: cfg.remote_table_id, pg_source_id: cfg.pg_source_id,
        // 编辑时回显生效的数据库:未显式指定的旧配置回填数据源默认库
        target_database: (cfg.target_database || '').trim() || (src ? src.database : '') || undefined,
        target_table: cfg.target_table, page: cfg.page, per_page: cfg.per_page,
      });
      setEditQuery(prev => ({ ...prev, perPage: cfg.per_page || 200 }));
      setTargetRequirePassword(!!src && !src.password);
      if (src && src.password) fetchDatabasesForTarget(cfg.pg_source_id);
      else setTargetDatabases([]);
      // 若指定了目标库，用目标库重新拉取表列表
      const effectiveDb = (cfg.target_database || '').trim() || (src ? src.database : '');
      if (src && effectiveDb) {
        try {
          const res = await listPgTablesInSource({
            host: src.host, port: src.port, user: src.user, password: src.password, database: effectiveDb, schema: src.schema,
          });
          if (res.success) setPgTables(res.tables || []);
        } catch { setPgTables([]); }
      } else {
        await onSelectPgSource(cfg.pg_source_id);
      }
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

  // ========== 复制配置到另一个数据源/数据库 ==========
  const fetchCopyDatabases = async (sourceId: number, password?: string) => {
    setCopyLoadingDb(true);
    try {
      const res = await getPgSourceDatabases(sourceId, password);
      if (res.success) setCopyDatabases(res.data || []);
      else { message.warning('获取数据库列表失败: ' + (res.message || '')); setCopyDatabases([]); }
    } catch { setCopyDatabases([]); }
    finally { setCopyLoadingDb(false); }
  };

  const fetchCopyTables = async (sourceId: number, dbName: string, password?: string) => {
    const src = pgSources.find(s => s.id === sourceId);
    if (!src || !dbName) { setCopyTables([]); return; }
    setCopyLoadingTables(true);
    try {
      const res = await listPgTablesInSource({
        host: src.host, port: src.port, user: src.user,
        password: password || src.password, database: dbName, schema: src.schema,
      });
      if (res.success) setCopyTables(res.tables || []);
      else setCopyTables([]);
    } catch { setCopyTables([]); }
    finally { setCopyLoadingTables(false); }
  };

  // 拉取指定数据源+库下的表列表
  const openCopy = (cfg: SyncConfig) => {
    setCopySrc(cfg);
    copyForm.resetFields();
    const src = pgSources.find(s => s.id === cfg.pg_source_id);
    setCopyRequirePassword(!!src && !src.password);
    copyForm.setFieldsValue({
      name: cfg.name,
      pg_source_id: cfg.pg_source_id,
      target_database: dbNameOf(cfg),
      target_table: cfg.target_table,
      per_page: cfg.per_page || 200,
      page: cfg.page || 1,
    });
    setCopyTables(cfg.target_table ? [cfg.target_table] : []);
    if (src && src.password) fetchCopyDatabases(cfg.pg_source_id);
    else setCopyDatabases([]);
    if (src && dbNameOf(cfg)) fetchCopyTables(cfg.pg_source_id, dbNameOf(cfg), src.password);
    setCopyOpen(true);
  };

  const handleCopyPgSourceChange = (sourceId: number) => {
    const src = pgSources.find(s => s.id === sourceId);
    setCopyRequirePassword(!!src && !src.password);
    // 目标数据库自动填入数据源默认库
    copyForm.setFieldsValue({ target_database: src?.database || undefined, target_table: undefined, temp_password: undefined });
    setCopyTables([]);
    if (src && src.password) fetchCopyDatabases(sourceId);
    else setCopyDatabases([]);
  };

  const handleCopyDatabaseChange = (dbName?: string) => {
    copyForm.setFieldsValue({ target_table: undefined });
    setCopyTables([]);
    const sourceId = copyForm.getFieldValue('pg_source_id');
    if (sourceId && dbName) {
      const pwd = copyForm.getFieldValue('temp_password');
      fetchCopyTables(sourceId, dbName, pwd);
    }
  };

  const handleCopySave = async () => {
    if (!copySrc) return;
    try {
      const values = await copyForm.validateFields();
      setCopySaving(true);
      // 复制源配置的全部映射/条件/排序,仅替换目标数据源/库/表/名称
      await createSyncConfig({
        name: values.name,
        remote_table_id: copySrc.remote_table_id,
        pg_source_id: values.pg_source_id,
        target_database: (values.target_database || '').trim(),
        target_table: values.target_table,
        target_pk: copySrc.target_pk || '',
        page: values.page || copySrc.page || 1,
        per_page: values.per_page || copySrc.per_page || 200,
        import_settings: copySrc.import_settings,
        all_import: copySrc.all_import || 0,
        conditions: copySrc.conditions,
        logic: copySrc.logic,
        order_field: copySrc.order_field || '',
        order_dir: copySrc.order_dir || 'asc',
      });
      message.success('复制成功');
      setCopyOpen(false);
      loadAll();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('复制失败: ' + (err.message || ''));
    } finally { setCopySaving(false); }
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
    let values: any;
    try {
      values = await form.validateFields();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + (err.message || ''));
      return;
    }
    const doSave = async () => {
      setSaving(true);
      try {
        const payload = {
          name: values.name, remote_table_id: values.remote_table_id, pg_source_id: values.pg_source_id,
          target_database: (values.target_database || '').trim(),
          target_table: values.target_table, target_pk: '', page: values.page || 1, per_page: editQuery.perPage || 200,
          import_settings: JSON.stringify(buildSettings()), all_import: 0,        conditions: JSON.stringify(editQuery.conditions),        logic: editQuery.logic,        order_field: editQuery.orderField,        order_dir: editQuery.orderDir,
        };
        if (editingId) { await updateSyncConfig(editingId, payload); message.success('更新成功'); }
        else { await createSyncConfig(payload); message.success('创建成功'); }
        setEditOpen(false);
        loadAll();
      } catch (err: any) {
        message.error('保存失败: ' + (err.message || ''));
      } finally { setSaving(false); }
    };
    // 没有任何有效字段映射(源字段+目标字段都填了)时,二次确认后才能保存
    if (!fields.some(f => f.srcField && f.distField)) {
      Modal.confirm({
        title: '尚未配置字段映射',
        icon: <QuestionCircleOutlined style={{ color: '#faad14' }} />,
        content: '当前没有任何有效的字段映射(源字段和目标字段都未填写),导入时将无法同步数据。确定仍要保存该配置吗?',
        okText: '继续保存',
        okType: 'danger',
        cancelText: '返回修改',
        onOk: doSave,
      });
      return;
    }
    // 有映射但没勾选任何主键时,二次确认(upsert 依赖主键定位记录)
    if (!fields.some(f => f.isPk && f.srcField && f.distField)) {
      Modal.confirm({
        title: '尚未勾选主键',
        icon: <QuestionCircleOutlined style={{ color: '#faad14' }} />,
        content: '字段映射中没有任何一行勾选主键。主键用于 upsert 的 ON CONFLICT 冲突定位,不设置可能导致重复插入数据。确定仍要保存该配置吗?',
        okText: '继续保存',
        okType: 'danger',
        cancelText: '返回修改',
        onOk: doSave,
      });
      return;
    }
    await doSave();
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

  // 自动匹配字段映射:源字段名与目标字段名(忽略大小写/下划线)或中文备注一致即填入
  const handleAutoMatch = () => {
    if (!srcFields.length) { message.warning('请先点击「获取远程字段结构」加载源字段'); return; }
    if (!dstFields.length) { message.warning('请先选择目标表以加载目标字段'); return; }
    const norm = (s: string) => (s || '').toLowerCase().replace(/[_\s]/g, '');
    const matchDst = (srcName: string, srcDesc: string) => {
      const dstList = dstFields;
      return dstList.find(d => norm(d.name) === norm(srcName))
        || dstList.find(d => srcDesc && d.comment && norm(d.comment) === norm(srcDesc));
    };
    // 全新映射(没有任何源字段):按远程字段逐个生成映射行,能匹配的目标字段自动填入
    if (!fields.some(f => f.srcField)) {
      let matched = 0;
      setFields(srcFields.map(s => {
        const dst = matchDst(s.name, s.description || '');
        if (dst) matched++;
        return { ...newField(), srcField: s.name, distField: dst ? dst.name : '' };
      }));
      message.success(`已按远程字段生成 ${srcFields.length} 行映射,其中 ${matched} 行自动匹配到目标字段`);
      return;
    }
    // 已有映射:只填充空缺的目标字段,不覆盖已手动选择的
    let filled = 0;
    setFields(fields.map(f => {
      if (!f.srcField || f.distField) return f;
      const dst = matchDst(f.srcField, srcFields.find(s => s.name === f.srcField)?.description || '');
      if (dst) { filled++; return { ...f, distField: dst.name }; }
      return f;
    }));
    if (filled > 0) message.success(`自动匹配完成: 补充了 ${filled} 个目标字段(已选的不会被覆盖)`);
    else message.warning('没有找到可自动匹配的字段,请检查字段命名是否一致');
  };

  // 一键清空全部字段映射,恢复为单个空白行
  const handleClearMappings = () => {
    setFields([newField()]);
    message.success('已清空全部字段映射');
  };

  const handleImport = (id: number) => {
    const cfg = configs.find(c => c.id === id);
    if (!cfg) { message.error('未找到该配置'); return; }
    Modal.confirm({
      title: '确认执行导入?',
      icon: <QuestionCircleOutlined style={{ color: '#faad14' }} />,
      content: (
        <div style={{ fontSize: 13 }}>
          <p>即将立即执行导入配置 <Text strong>{cfg.name}</Text></p>
          <p>远程表数据将按字段映射写入目标表 <Text code>{dbNameOf(cfg)}.{cfg.target_table}</Text>(主键冲突时覆盖更新),确定继续?</p>
        </div>
      ),
      okText: '开始导入',
      okType: 'primary',
      cancelText: '取消',
      onOk: () => runImport(id),
    });
  };

  const runImport = (id: number) => {
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

  const sourceMap = Object.fromEntries(pgSources.map(s => [s.id, s]));

  // 取配置生效的目标数据库名(未指定时回退到数据源默认库)
  const dbNameOf = (r: SyncConfig): string => {
    const src = sourceMap[r.pg_source_id];
    return (r.target_database || '').trim() || (src ? src.database : '') || '默认库';
  };

  const columns = [
    { title: '配置名', dataIndex: 'name', key: 'name', width: 140 },
    {
      title: '目标数据源', key: 'target_source', width: 120, responsive: ['sm'] as any,
      render: (_: any, r: SyncConfig) => {
        const src = sourceMap[r.pg_source_id];
        return <Tag color="geekblue">{src ? src.name : (r.pg_source_id ? `#${r.pg_source_id}` : '未指定')}</Tag>;
      },
    },
    {
      title: '目标数据库', key: 'target_db', width: 120, responsive: ['sm'] as any,
      render: (_: any, r: SyncConfig) => <Tag color="cyan">{dbNameOf(r)}</Tag>,
    },
    {
      title: '目标表', dataIndex: 'target_table', key: 'target_table', width: 130, responsive: ['md'] as any,
      render: (_: any, r: SyncConfig) => r.target_table,
    },
    {
      title: '映射', dataIndex: 'import_settings', key: 'settings', width: 70, responsive: ['sm'] as any,
      render: (v: string) => {
        try { return <Tag color="blue">{JSON.parse(v).length}</Tag>; }
        catch { return <Tag>-</Tag>; }
      },
    },
    {
      title: '操作', key: 'action', width: 360, className: 'table-action-column',
      render: (_: any, r: SyncConfig) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(r.id)}>预览</Button>
          <Button size="small" type="primary" icon={<ImportOutlined />}
            onClick={() => handleImport(r.id)} loading={importing === r.id}>导入</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => openCopy(r)}>复制</Button>
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
            const src = sourceMap[r.pg_source_id];
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
                  <div><Text type="secondary">目标数据源:</Text> <Tag color="geekblue">{src ? src.name : (r.pg_source_id ? `#${r.pg_source_id}` : '未指定')}</Tag></div>
                  <div><Text type="secondary">目标数据库:</Text> <Tag color="cyan">{dbNameOf(r)}</Tag></div>
                  <div><Text type="secondary">目标表:</Text> <Text strong>{r.target_table}</Text></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8, flexWrap: 'wrap' }}>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(r.id)}>预览</Button>
                  <Button size="small" type="primary" icon={<ImportOutlined />} onClick={() => handleImport(r.id)} loading={importing === r.id}>导入</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => openCopy(r)}>复制</Button>
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
          {(() => {
            // 按 目标数据源 + 目标数据库 分组,每组一个手风琴面板
            const groupMap = new Map<string, { sourceName: string; dbName: string; items: SyncConfig[] }>();
            for (const r of configs) {
              const src = sourceMap[r.pg_source_id];
              const sourceName = src ? src.name : (r.pg_source_id ? `#${r.pg_source_id}` : '未指定数据源');
              const dbName = dbNameOf(r);
              const key = `${r.pg_source_id || 0}::${dbName}`;
              if (!groupMap.has(key)) groupMap.set(key, { sourceName, dbName, items: [] });
              groupMap.get(key)!.items.push(r);
            }
            const groups = Array.from(groupMap.entries()).map(([key, g]) => ({ key, ...g }))
              .sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'zh-CN') || a.dbName.localeCompare(b.dbName, 'zh-CN'));
            if (groups.length === 0) {
              return loading
                ? <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
                : <div style={{ textAlign: 'center', padding: 24, color: '#999' }}>暂无配置</div>;
            }
            return (
              <Collapse accordion
                defaultActiveKey={groups.length ? [groups[0].key] : []}
                items={groups.map(g => ({
                  key: g.key,
                  label: (
                    <Space size={8} wrap>
                      <DatabaseOutlined style={{ color: '#1677ff' }} />
                      <span style={{ color: '#888' }}>目标数据源:</span>
                      <Tag color="geekblue" style={{ margin: 0 }}>{g.sourceName}</Tag>
                      <span style={{ color: '#888' }}>目标数据库:</span>
                      <Tag color="cyan" style={{ margin: 0 }}>{g.dbName}</Tag>
                      <Tag style={{ margin: 0 }}>{g.items.length} 个配置</Tag>
                    </Space>
                  ),
                  children: (
                    <Table dataSource={g.items} columns={columns} rowKey="id" pagination={false} size="small"
                      scroll={{ x: 'max-content' }}
                      rowSelection={{
                        selectedRowKeys: selectedKeys,
                        onChange: (keys: React.Key[]) => setSelectedKeys(keys as number[]),
                      }} />
                  ),
                }))} />
            );
          })()}
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

      {/* 编辑弹窗 */}
      <Modal title={editingId ? '编辑导入配置' : '新增导入配置'} open={editOpen}
        onOk={handleSave} onCancel={() => setEditOpen(false)} okText="保存" cancelText="取消"
        width="90%" style={{ top: 20 }}
      >
        {/* 顶部基础信息表单限宽保持紧凑,字段映射/查询条件区使用弹窗全部宽度 */}
        <Form form={form} layout="vertical" style={{ maxWidth: 1000 }}>
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
                  onChange={val => { onSelectPgSource(val); form.setFieldsValue({ target_table: undefined, temp_password: undefined }); }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item
                label="目标数据库"
                extra={(() => {
                  const sid = form.getFieldValue('pg_source_id');
                  const src = pgSources.find(s => s.id === sid);
                  return src ? `必选。默认为数据源默认库 ${src.database}，可指定同一服务器上的其他数据库` : '必选。请先选择 PG 数据源以拉取数据库列表';
                })()}
              >
                <div style={{ display: 'flex', gap: 8 }}>
                  <Form.Item name="target_database" noStyle
                    rules={[{ required: true, message: '请选择目标数据库' }]}>
                    <Select
                      showSearch
                      allowClear
                      placeholder="选择目标数据库"
                      loading={loadingTargetDatabases}
                      options={targetDatabases.map(db => ({ value: db, label: db }))}
                      onChange={onSelectTargetDatabase}
                      style={{ flex: 1 }}
                    />
                  </Form.Item>
                  <Button
                    icon={<ReloadOutlined />}
                    loading={loadingTargetDatabases}
                    onClick={() => {
                      const sourceId = form.getFieldValue('pg_source_id');
                      const pwd = form.getFieldValue('temp_password');
                      if (sourceId) {
                        fetchDatabasesForTarget(sourceId, pwd);
                      } else {
                        message.warning('请先选择 PG 数据源');
                      }
                    }}
                    title="刷新数据库列表"
                  />
                </div>
              </Form.Item>
              {targetRequirePassword && (
                <Form.Item
                  label="临时连接密码"
                  name="temp_password"
                  extra="该数据源未配置密码，输入后点击刷新按钮获取数据库列表"
                >
                  <Input.Password
                    placeholder="请输入 PostgreSQL 数据库密码"
                    onBlur={(e) => {
                      const val = e.target.value;
                      const sourceId = form.getFieldValue('pg_source_id');
                      if (sourceId && val) {
                        fetchDatabasesForTarget(sourceId, val);
                      }
                    }}
                  />
                </Form.Item>
              )}
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item label="目标表" name="target_table" rules={[{ required: true }]}>
                <Select placeholder="选择表" options={pgTables.map(t => ({ value: t, label: t }))}
                  onChange={onSelectTargetTable} showSearch />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Row gutter={8}>
                <Col span={12}>
                  <Form.Item label="每页条数" name="per_page">
                    <Select options={[50, 100, 200, 500, 1000].map(n => ({ value: n, label: String(n) }))} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="起始页" name="page">
                    <Input type="number" min={1} />
                  </Form.Item>
                </Col>
              </Row>
            </Col>
          </Row>
        </Form>

        <ConditionBuilder value={editQuery} onChange={setEditQuery}
          knownFields={Object.fromEntries(srcFields.map(f => [f.name, f.description]))}
          onPreview={handleEditFetchFields}
          extra={
            <Space size="small" wrap>
              <Button size="small" icon={<EyeOutlined />} onClick={handleEditFetchFields}
                loading={editPreviewLoading}
                disabled={!form.getFieldValue("remote_table_id")}>
                获取远程字段结构
              </Button>
              <Button size="small" icon={<ThunderboltOutlined />} onClick={handleAutoMatch}
                disabled={!form.getFieldValue("remote_table_id") || !form.getFieldValue("target_table")}>
                自动匹配
              </Button>
              <Popconfirm title="确定清空所有字段映射？" description="将删除全部映射行并恢复为空白"
                okText="清空" cancelText="取消" okButtonProps={{ danger: true }}
                disabled={!fields.some(f => f.srcField || f.distField)}
                onConfirm={handleClearMappings}>
                <Button size="small" icon={<ClearOutlined />}
                  disabled={!fields.some(f => f.srcField || f.distField)}>
                  清空映射
                </Button>
              </Popconfirm>
              {srcFields.length > 0 && (
                <Tag color="blue">{srcFields.length} 个字段</Tag>
              )}
            </Space>
          } />

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
                      <Select placeholder="源字段" style={{ width: '100%' }} size="small" showSearch allowClear
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
                      <Select placeholder="目标字段" style={{ width: '100%' }} size="small" showSearch allowClear
                        value={f.distField || undefined}
                        onChange={val => updateField(f.key, { distField: val || '' })}
                        options={dstFields.map(d => ({
                          value: d.name,
                          label: `${d.name}${d.comment ? ` (${d.comment})` : ''}`,
                        }))}
                        filterOption={(input, option) => {
                          const q = input.toLowerCase();
                          return String(option?.value ?? '').toLowerCase().includes(q)
                            || String((option as any)?.label ?? '').toLowerCase().includes(q);
                        }}
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
                  <Select placeholder="源字段" style={{ width: '100%' }} size="small" showSearch allowClear
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
                  <Select placeholder="目标字段" style={{ width: '100%' }} size="small" showSearch allowClear
                    value={f.distField || undefined}
                    onChange={val => updateField(f.key, { distField: val || '' })}
                    options={dstFields.map(d => ({
                      value: d.name,
                      comment: d.comment,
                      label: React.createElement('span', null,
                        d.name,
                        React.createElement('span', { style: { color: '#8c8c8c', fontSize: 11, marginLeft: 6 } }, d.comment || d.type)
                      ),
                    }))}
                    filterOption={(input, option: any) => {
                      const q = input.toLowerCase();
                      return String(option?.value ?? '').toLowerCase().includes(q)
                        || String(option?.comment ?? '').toLowerCase().includes(q);
                    }}
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
                <Col span={1} style={{ textAlign: 'center' }}>
                  <Tooltip title="删除此行">
                    <Button size="small" type="text" danger icon={<CloseOutlined />}
                      onClick={() => removeField(f.key)} disabled={fields.length <= 1}
                      style={{ width: 22, height: 22, padding: 0, minWidth: 22 }} />
                  </Tooltip>
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

      {/* 复制配置弹窗 */}
      <Modal title={<>复制配置 {copySrc && <Text type="secondary">({copySrc.name})</Text>}</>}
        open={copyOpen} onOk={handleCopySave} onCancel={() => setCopyOpen(false)}
        okText="复制" cancelText="取消" confirmLoading={copySaving} width={560} maskClosable={false}>
        <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 4, background: '#e6f7ff', border: '1px solid #91d5ff', fontSize: 12, color: '#1890ff' }}>
          ⓘ 远程数据表、字段映射、查询条件、排序将一并复制,仅替换目标数据源/数据库/表
        </div>
        <Form form={copyForm} layout="vertical">
          <Form.Item label="配置名称" name="name" rules={[{ required: true, message: '请输入配置名称' }]}>
            <Input placeholder="新配置名称" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="目标数据源" name="pg_source_id" rules={[{ required: true, message: '请选择目标数据源' }]}>
                <Select placeholder="选择目标数据源" showSearch
                  options={pgSources.map(s => ({ value: s.id, label: s.name }))}
                  onChange={handleCopyPgSourceChange} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="目标数据库" required style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Form.Item name="target_database" noStyle rules={[{ required: true, message: '请选择目标数据库' }]}>
                    <Select showSearch allowClear placeholder="选择目标数据库"
                      loading={copyLoadingDb}
                      options={copyDatabases.map(db => ({ value: db, label: db }))}
                      onChange={handleCopyDatabaseChange} style={{ flex: 1 }} />
                  </Form.Item>
                  <Button icon={<ReloadOutlined />} loading={copyLoadingDb}
                    title="刷新数据库列表"
                    onClick={() => {
                      const sourceId = copyForm.getFieldValue('pg_source_id');
                      const pwd = copyForm.getFieldValue('temp_password');
                      if (sourceId) fetchCopyDatabases(sourceId, pwd);
                      else message.warning('请先选择目标数据源');
                    }} />
                </div>
              </Form.Item>
            </Col>
          </Row>
          {copyRequirePassword && (
            <Form.Item label="临时连接密码" name="temp_password"
              extra="该数据源未配置密码,输入后点击刷新按钮获取数据库列表">
              <Input.Password placeholder="请输入 PostgreSQL 数据库密码"
                autoComplete="new-password"
                onBlur={(e) => {
                  const val = e.target.value;
                  const sourceId = copyForm.getFieldValue('pg_source_id');
                  if (sourceId && val) fetchCopyDatabases(sourceId, val);
                }} />
            </Form.Item>
          )}
          <Form.Item label="目标表" name="target_table" rules={[{ required: true, message: '请选择或输入目标表名' }]}
            extra="默认与原配置同名;可直接输入,或从目标库的表中选择">
            <AutoComplete
              placeholder="选择或输入目标表名"
              options={copyTables.map(t => ({ value: t }))}
              loading={copyLoadingTables}
              filterOption={(input, option) =>
                String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              } />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={12} sm={12}>
              <Form.Item label="每页条数" name="per_page">
                <Select options={[50, 100, 200, 500, 1000].map(n => ({ value: n, label: String(n) }))} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={12}>
              <Form.Item label="起始页" name="page">
                <Input type="number" min={1} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
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

import React, { useState, useEffect, useMemo } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, message, Popconfirm, Tag, Typography, Spin, Collapse, Select, Row, Col, Tooltip, Alert
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, TableOutlined, ApiOutlined,
  DownloadOutlined, KeyOutlined, ReloadOutlined,
} from '@ant-design/icons';
import {
  listRemoteTables, createRemoteTable, updateRemoteTable, deleteRemoteTable, fetchRemoteData,
  listTokenConfigs, fetchRemoteTableCount, getRemoteTableFields,
} from '../api';
import type { RemoteTable, QueryParams, QueryCondition, TokenConfigInfo } from '../api';
import ConditionBuilder from '../components/ConditionBuilder';
import JsonTreeViewer from '../components/JsonTreeViewer';

const { Text } = Typography;

const defaultQuery: QueryParams = {
  conditions: [], logic: 'and', page: 1, perPage: 20, orderField: '', orderDir: 'asc',
};

// 预览数据卡片(memo 隔离:大结果集不再拖累弹窗内输入框的每次重渲染)
const PreviewDataCard: React.FC<{ records: any[] }> = React.memo(({ records }) => {
  const MAX_LOAD = 500;   // 表格加载上限(分页浏览,单页仅渲染 10 行,不卡)
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  // 复制全文仅随数据变化重算一次并缓存
  const copyText = useMemo(() => JSON.stringify(records, null, 2), [records]);
  const shown = records.slice(0, MAX_LOAD);

  // 表格列 = 前 20 条记录字段的并集(保持出现顺序)
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const r of records.slice(0, 20)) {
      if (r && typeof r === 'object') {
        for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
      }
    }
    return keys.map(k => ({
      title: k,
      dataIndex: k,
      key: k,
      ellipsis: true,
      width: 160,
      render: (v: any) => (v === null || v === undefined ? <Text type="secondary">null</Text> : String(v)),
    }));
  }, [records]);

  return (
    <Card size="small"
      title={`数据 (${records.length} 条)${records.length > MAX_LOAD ? `,仅加载前 ${MAX_LOAD} 条` : ''}`}
      type="inner"
      extra={
        <Space size={8}>
          <Button size="small" type={viewMode === 'table' ? 'primary' : 'default'}
            onClick={() => setViewMode('table')}>表格</Button>
          <Button size="small" type={viewMode === 'json' ? 'primary' : 'default'}
            onClick={() => setViewMode('json')}>JSON</Button>
          <Text copyable={{ text: copyText }} style={{ fontSize: 12 }}>复制全部</Text>
        </Space>
      }
    >
      {viewMode === 'table' ? (
        <Table
          dataSource={shown}
          columns={columns}
          rowKey={(_, i) => String(i)}
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: false, size: 'small', showTotal: t => `共 ${t} 条` }}
          scroll={{ x: 'max-content' }}
        />
      ) : (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <JsonTreeViewer data={shown} />
        </div>
      )}
    </Card>
  );
});

const TableConfig: React.FC = () => {
  const [tables, setTables] = useState<RemoteTable[]>([]);
  const [tokenConfigs, setTokenConfigs] = useState<TokenConfigInfo[]>([]);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [loading, setLoading] = useState(false);

  // 新增/编辑弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [editForm] = Form.useForm();
  const [editQuery, setEditQuery] = useState<QueryParams>(defaultQuery);

  // 编辑弹窗内的数据预览
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [editRecords, setEditRecords] = useState<any[] | null>(null);
  const [editMeta, setEditMeta] = useState<{ duration: number; recordCount: number } | null>(null);
  const [editFetching, setEditFetching] = useState(false);
  const [editError, setEditError] = useState<string>('');

  // 数据量刷新
  const [refreshingIds, setRefreshingIds] = useState<number[]>([]);
  const [refreshingGroup, setRefreshingGroup] = useState<number | null>(null);

  const refreshOne = async (id: number): Promise<boolean> => {
    setRefreshingIds(prev => [...prev, id]);
    try {
      const res = await fetchRemoteTableCount(id);
      if (res.success && res.data) {
        const { count, updated_at } = res.data;
        setTables(prev => prev.map(t => t.id === id ? { ...t, record_count: count, record_count_updated_at: updated_at } : t));
        return true;
      }
      return false;
    } catch { return false; }
    finally { setRefreshingIds(prev => prev.filter(x => x !== id)); }
  };

  const handleGroupRefresh = async (tid: number) => {
    const ids = tables.filter(t => (t.token_config_id || 0) === tid).map(t => t.id);
    if (ids.length === 0) return;
    setRefreshingGroup(tid);
    let ok = 0, fail = 0;
    // 串行逐表刷新,避免并发压力;行级 loading 由 refreshingIds 驱动
    for (const id of ids) {
      const success = await refreshOne(id);
      if (success) ok++; else fail++;
    }
    setRefreshingGroup(null);
    if (fail > 0) message.warning(`刷新完成: 成功 ${ok} 张,失败 ${fail} 张(请检查 Token 或网络后重试)`);
    else message.success(`已刷新 ${ok} 张表的数据量`);
  };

  useEffect(() => { loadTables(); loadTokenConfigs(); }, []);

  const loadTables = async () => {
    setLoading(true);
    try {
      const res = await listRemoteTables();
      if (res.success) setTables(res.data);
    } catch { message.error('加载列表失败'); }
    finally { setLoading(false); }
  };

  const loadTokenConfigs = async () => {
    try {
      const res = await listTokenConfigs();
      if (res.success) setTokenConfigs(res.data);
    } catch { }
  };

  // ========== 新增/编辑 ==========

  const openAdd = () => {
    setEditingId(null);
    editForm.resetFields();
    // 默认归属到第一条 Token 配置
    if (tokenConfigs.length > 0) editForm.setFieldsValue({ token_config_id: tokenConfigs[0].id });
    setEditQuery(defaultQuery);
    setEditOpen(true);
  };

  const openEdit = (t: RemoteTable) => {
    try {
      setEditingId(t.id);
      editForm.setFieldsValue({ name: t.name, data_api_url: t.data_api_url, token_config_id: t.token_config_id || tokenConfigs[0]?.id });
      let parsedConditions: QueryCondition[] = [];
      try {
        const pc = JSON.parse(t.conditions || '[]');
        if (Array.isArray(pc)) parsedConditions = pc;
      } catch {}
      setEditQuery({
        conditions: parsedConditions,
        logic: (t.logic as 'and' | 'or') || 'and',
        page: t.page || 1,
        perPage: t.per_page || 20,
        orderField: t.order_field || '',
        orderDir: (t.order_dir as 'asc' | 'desc') || 'asc',
      });
      setEditRecords(null);
      setEditMeta(null);
      setEditFields({});
      setEditError('');
      setEditOpen(true);
      // 自动获取字段结构(供条件/排序字段下拉);部分接口不返回 data_struct,获取数据后会从记录推断
      getRemoteTableFields(t.id).then(res => {
        if (res.success && res.data && res.data.length > 0) {
          setEditFields(Object.fromEntries(res.data.map(f => [f.name, f.description])));
        }
      }).catch(() => { });
    } catch (e: any) {
      message.error("打开编辑失败: " + e.message);
    }
  };

  /** 编辑弹窗内:按表单当前 URL/Token 配置与查询条件拉取数据 */
  const handleEditFetchData = async () => {
    const values = editForm.getFieldsValue();
    const t = tables.find(x => x.id === editingId);
    const apiUrl = (values.data_api_url || '').trim() || t?.data_api_url;
    const tokenConfigId = values.token_config_id || t?.token_config_id;
    if (!apiUrl) { message.warning('请先填写数据 API URL'); return; }
    setEditFetching(true);
    try {
      const res = await fetchRemoteData(editQuery, apiUrl, tokenConfigId);
      if (res.success && res.data) {
        setEditError('');
        setEditRecords(res.data.records);
        setEditMeta(res.meta || null);
        if (res.data.dataStruct && Object.keys(res.data.dataStruct).length > 0) {
          setEditFields(prev => ({ ...prev, ...res.data.dataStruct }));
        } else if (res.data.records.length > 0 && res.data.records[0] && typeof res.data.records[0] === 'object') {
          // 接口未返回 data_struct 时,从真实数据字段名推断(描述留空)
          const inferred: Record<string, string> = {};
          for (const k of Object.keys(res.data.records[0])) inferred[k] = '';
          setEditFields(prev => (Object.keys(prev).length > 0 ? prev : inferred));
        }
        message.success('获取成功 (' + res.data.records.length + ' 条)');
      } else {
        // 失败信息持久显示在数据区域,方便查看与排查
        setEditError(res.message || '未知错误');
        setEditRecords(null);
        setEditMeta(null);
      }
    } catch (err: any) {
      setEditError('请求失败: ' + err.message);
      setEditRecords(null);
    } finally { setEditFetching(false); }
  };

  const handleSave = async () => {
    try {
      const values = await editForm.validateFields();
      const payload = {
        name: values.name,
        data_api_url: values.data_api_url,
        token_config_id: values.token_config_id || 0,
        conditions: JSON.stringify(editQuery.conditions),
        logic: editQuery.logic,
        page: editQuery.page,
        per_page: editQuery.perPage,
        order_field: editQuery.orderField,
        order_dir: editQuery.orderDir,
      };
      if (editingId) {
        await updateRemoteTable(editingId, payload);
        message.success('配置更新成功');
      } else {
        await createRemoteTable(payload);
        message.success('配置保存成功');
      }
      setEditOpen(false);
      loadTables();
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + (err.message || ''));
    }
  };

  const handleDelete = async (id: number) => {
    await deleteRemoteTable(id);
    message.success('配置已删除');
    loadTables();
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.length === 0) return;
    Modal.confirm({
      title: `确定删除选中的 ${selectedKeys.length} 条配置？`,
      content: '删除后无法恢复',
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        let errCount = 0;
        for (const id of selectedKeys) {
          try { await deleteRemoteTable(id); } catch { errCount++; }
        }
        if (errCount > 0) message.warning(`已删除 ${selectedKeys.length - errCount} 条，${errCount} 条失败`);
        else message.success(`成功删除 ${selectedKeys.length} 条配置`);
        setSelectedKeys([]);
        loadTables();
      },
    });
  };

  // ========== 表格列 ==========

  const columns = [
    {
      title: '表名', dataIndex: 'name', key: 'name', width: 240,
      render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}><TableOutlined style={{ marginRight: 6 }} />{v}</span>,
    },
    {
      title: '数据 API URL', dataIndex: 'data_api_url', key: 'data_api_url', ellipsis: true, responsive: ['sm'] as any,
      render: (v: string) => (
        <Text copyable ellipsis style={{ fontSize: 12, maxWidth: 380, display: 'inline-block' }}>{v}</Text>
      ),
    },
    {
      title: '条件', dataIndex: 'conditions', key: 'conditions', width: 80, responsive: ['sm'] as any,
      render: (v: string) => {
        try {
          const conds = JSON.parse(v || '[]');
          return conds.length ? <Tag color="blue">{conds.length}</Tag> : <Tag>-</Tag>;
        } catch { return <Tag>-</Tag>; }
      },
    },
    {
      title: '数据量', dataIndex: 'record_count', key: 'record_count', width: 100,
      render: (v: number, r: RemoteTable) => {
        if (refreshingIds.includes(r.id)) return <Spin size="small" />;
        if (v === undefined || v === null || v < 0) {
          return <Tooltip title="点击手风琴右侧 ⟳ 刷新获取"><Tag style={{ margin: 0 }}>未获取</Tag></Tooltip>;
        }
        return (
          <Tooltip title={`上次刷新: ${r.record_count_updated_at || '-'}`}>
            <Tag color="blue" style={{ margin: 0 }}>{v.toLocaleString()}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作', key: 'action', width: 130, className: 'table-action-column',
      render: (_: any, r: RemoteTable) => (
        <Space size={4}>
          <Tooltip title="刷新数据量">
            <Button size="small" icon={<ReloadOutlined />}
              loading={refreshingIds.includes(r.id)}
              onClick={async () => {
                const ok = await refreshOne(r.id);
                if (ok) message.success(`「${r.name}」数据量已更新`);
                else message.error(`「${r.name}」刷新失败,请检查 Token 或网络`);
              }} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
            <Tooltip title="删除">
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="responsive-page-container">
      {isMobile ? (
        <Card title={<><ApiOutlined /> 数据表配置</>}>
          <div style={{ marginBottom: 16 }}>
            <Button type="primary" block icon={<PlusOutlined />} onClick={openAdd}>新增表配置</Button>
          </div>
          {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
          {!loading && tables.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无配置</div>}
          {!loading && tables.map(r => {
            let condCount = 0;
            try { condCount = JSON.parse(r.conditions || '[]').length; } catch {}
            return (
              <Card
                key={r.id}
                size="small"
                style={{ marginBottom: 12, borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TableOutlined style={{ color: '#1677ff' }} />
                    <span style={{ fontWeight: 500 }}>{r.name}</span>
                  </div>
                }
                extra={condCount > 0 ? <Tag color="blue">条件: {condCount}</Tag> : null}
              >
                <div style={{ padding: '4px 0', fontSize: 13, wordBreak: 'break-all' }}>
                  <div style={{ marginBottom: 4 }}><Text type="secondary">API URL:</Text></div>
                  <Text copyable style={{ fontSize: 12, color: '#555' }}>{r.data_api_url}</Text>
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary">数据量: </Text>
                    {refreshingIds.includes(r.id) ? <Spin size="small" /> : (
                      r.record_count !== undefined && r.record_count >= 0
                        ? <Tag color="blue" style={{ margin: 0 }}>{r.record_count.toLocaleString()}</Tag>
                        : <Tag style={{ margin: 0 }}>未获取</Tag>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
                  <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)} okText="确定" cancelText="取消">
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </div>
              </Card>
            );
          })}
        </Card>
      ) : (
        <Card title={<><ApiOutlined /> 数据表配置</>}>
          <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>新增表配置</Button>
            {selectedKeys.length > 0 && (
              <Button danger icon={<DeleteOutlined />} onClick={handleBatchDelete}>
                批量删除 ({selectedKeys.length})
              </Button>
            )}
          </div>
          {(() => {
            // 按所属 Token 配置分组,每组一个手风琴面板
            const tokenName = (id: number) => tokenConfigs.find(t => t.id === id)?.name || (id ? `配置#${id}` : '未指定');
            const groupMap = new Map<number, RemoteTable[]>();
            for (const r of tables) {
              const key = r.token_config_id || 0;
              if (!groupMap.has(key)) groupMap.set(key, []);
              groupMap.get(key)!.push(r);
            }
            const groups = Array.from(groupMap.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([tid, items]) => ({ tid, items }));
            if (groups.length === 0) {
              return loading
                ? <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
                : <div style={{ textAlign: 'center', padding: 24, color: '#999' }}>暂无配置</div>;
            }
            return (
              <Collapse accordion
                defaultActiveKey={groups.length ? [String(groups[0].tid)] : []}
                items={groups.map(g => ({
                  key: String(g.tid),
                  label: (
                    <div style={{ display: 'flex', alignItems: 'center', width: '100%', paddingRight: 28 }}>
                      <Space size={8} wrap>
                        <KeyOutlined style={{ color: '#faad14' }} />
                        <span style={{ color: '#888' }}>所属 Token 配置:</span>
                        <Tag color="gold" style={{ margin: 0 }}>{tokenName(g.tid)}</Tag>
                        <Tag style={{ margin: 0 }}>{g.items.length} 张表</Tag>
                      </Space>
                      <Tooltip title="逐个刷新该配置下所有表的数据量">
                        <Button
                          size="small" type="text"
                          icon={<ReloadOutlined />}
                          loading={refreshingGroup === g.tid}
                          onClick={e => { e.stopPropagation(); handleGroupRefresh(g.tid); }}
                          style={{ marginLeft: 'auto', marginRight: 12 }} />
                      </Tooltip>
                    </div>
                  ),
                  children: (
                    <Table dataSource={g.items} columns={columns} rowKey="id"
                      pagination={false} size="small"
                      scroll={{ x: 'max-content' }}
                      rowSelection={{
                        selectedRowKeys: selectedKeys,
                        onChange: (keys: React.Key[]) => setSelectedKeys(keys as number[]),
                      }} />
                  ),
                }))} />
            );
          })()}
        </Card>
      )}

      {/* ======== 新增/编辑弹窗 ======== */}
      <Modal
        title={editingId ? '编辑表配置' : '新增表配置'}
        open={editOpen}
        onOk={handleSave}
        onCancel={() => setEditOpen(false)}
        okText="保存"
        cancelText="取消"
        width={700}
      >
        <Form form={editForm} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} sm={14}>
              <Form.Item label="表中文名" name="name" rules={[{ required: true, message: '请输入表名' }]}>
                <Input placeholder="例如：单位信息表、学生信息表" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={10}>
              <Form.Item label="所属 Token 配置" name="token_config_id"
                rules={[{ required: true, message: '请选择所属 Token 配置' }]}
                extra="该表的数据请求将使用此 Token 配置鉴权">
                <Select placeholder="选择 Token 配置"
                  options={tokenConfigs.map(t => ({ value: t.id, label: t.name || `配置#${t.id}` }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="数据 API URL" name="data_api_url" rules={[{ required: true, message: '请输入数据 API URL' }]}>
            <Input.TextArea rows={2} placeholder="http://dataapi.example.com/...?access_token=..." />
          </Form.Item>
        </Form>
        <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12, marginTop: 4 }}>
          <div style={{ fontWeight: 500, marginBottom: 8, color: '#595959' }}>默认查询条件</div>
          <ConditionBuilder value={editQuery} onChange={setEditQuery}
            knownFields={editFields}
            onPreview={handleEditFetchData} />
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" size="small" icon={<DownloadOutlined />}
              onClick={handleEditFetchData} loading={editFetching}>
              获取数据
            </Button>
            {editMeta && (
              <>
                <Tag color="blue">耗时: {(editMeta.duration / 1000).toFixed(2)}s</Tag>
                <Tag color="green">返回: {editMeta.recordCount} 条</Tag>
              </>
            )}
          </Space>
          {editError ? (
            <Alert
              type="error"
              showIcon
              message="获取数据失败"
              description={
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                  {editError}
                </pre>
              }
            />
          ) : editRecords !== null && <PreviewDataCard records={editRecords} />}
        </div>
      </Modal>
    </div>
  );
};

export default TableConfig;

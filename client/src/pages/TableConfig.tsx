import React, { useState, useEffect } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, message, Popconfirm, Tag, Typography, Spin, Tabs
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, TableOutlined, ApiOutlined, EyeOutlined,
  DownloadOutlined, SaveOutlined,
} from '@ant-design/icons';
import {
  listRemoteTables, createRemoteTable, updateRemoteTable, deleteRemoteTable, fetchRemoteData,
} from '../api';
import type { RemoteTable, QueryParams, QueryCondition } from '../api';
import ConditionBuilder from '../components/ConditionBuilder';
import JsonTreeViewer from '../components/JsonTreeViewer';

const { Text } = Typography;

const defaultQuery: QueryParams = {
  conditions: [], logic: 'and', page: 1, perPage: 20, orderField: '', orderDir: 'asc',
};

const TableConfig: React.FC = () => {
  const [tables, setTables] = useState<RemoteTable[]>([]);
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

  // 预览弹窗
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTable, setPreviewTable] = useState<RemoteTable | null>(null);
  const [previewQuery, setPreviewQuery] = useState<QueryParams>(defaultQuery);
  const [previewRecords, setPreviewRecords] = useState<any[] | null>(null);
  const [previewRaw, setPreviewRaw] = useState<any>(null);
  const [previewMeta, setPreviewMeta] = useState<{ duration: number; recordCount: number } | null>(null);
  const [previewFetching, setPreviewFetching] = useState(false);
  const [previewFields, setPreviewFields] = useState<Record<string, string>>({});

  useEffect(() => { loadTables(); }, []);

  const loadTables = async () => {
    setLoading(true);
    try {
      const res = await listRemoteTables();
      if (res.success) setTables(res.data);
    } catch { message.error('加载列表失败'); }
    finally { setLoading(false); }
  };

  // ========== 新增/编辑 ==========

  const openAdd = () => {
    setEditingId(null);
    editForm.resetFields();
    setEditQuery(defaultQuery);
    setEditOpen(true);
  };

  const openEdit = (t: RemoteTable) => {
    try {
      setEditingId(t.id);
      editForm.setFieldsValue({ name: t.name, data_api_url: t.data_api_url });
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
      setEditOpen(true);
    } catch (e: any) {
      message.error("打开编辑失败: " + e.message);
    }
  };

  const handleSave = async () => {
    try {
      const values = await editForm.validateFields();
      const payload = {
        name: values.name,
        data_api_url: values.data_api_url,
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

  // ========== 预览弹窗 ==========

  const openPreview = (t: RemoteTable) => {
    try {
      setPreviewTable(t);
      let parsedConditions: QueryCondition[] = [];
      try { 
        const pc = JSON.parse(t.conditions || '[]'); 
        if (Array.isArray(pc)) parsedConditions = pc;
      } catch {}
      const q: QueryParams = {
        conditions: parsedConditions,
        logic: (t.logic as 'and' | 'or') || 'and',
        page: t.page || 1,
        perPage: t.per_page || 20,
        orderField: t.order_field || '',
        orderDir: (t.order_dir as 'asc' | 'desc') || 'asc',
      };
      setPreviewQuery(q);
      setPreviewRecords(null);
      setPreviewRaw(null);
      setPreviewMeta(null);
      setPreviewFields({});
      setPreviewOpen(true);
    } catch (e: any) {
      message.error("打开预览失败: " + e.message);
    }
  };

  const handlePreviewFetch = async () => {
    setPreviewFetching(true);
    try {
      const res = await fetchRemoteData(previewQuery, previewTable?.data_api_url);
      if (res.success && res.data) {
        setPreviewRecords(res.data.records);
        setPreviewRaw(res.data.rawResponse);
        setPreviewMeta(res.meta || null);
        if (res.data.dataStruct) {
          setPreviewFields(prev => ({ ...prev, ...res.data.dataStruct }));
        }
        message.success('获取成功 (' + res.data.records.length + ' 条)');
        return { records: res.data.records, rawResponse: res.data.rawResponse, total: res.data.total };
      } else {
        message.error(res.message);
      }
    } catch (err: any) {
      message.error('请求失败: ' + err.message);
    } finally { setPreviewFetching(false); }
  };

  const handlePreviewSave = async () => {
    if (!previewTable) return;
    try {
      await updateRemoteTable(previewTable.id, {
        name: previewTable.name,
        data_api_url: previewTable.data_api_url,
        conditions: JSON.stringify(previewQuery.conditions),
        logic: previewQuery.logic,
        page: previewQuery.page,
        per_page: previewQuery.perPage,
        order_field: previewQuery.orderField,
        order_dir: previewQuery.orderDir,
      });
      message.success('查询条件已保存');
      // 更新表格数据
      loadTables();
    } catch { message.error('保存失败'); }
  };

  // ========== 表格列 ==========

  const columns = [
    {
      title: '表名', dataIndex: 'name', key: 'name', width: 180,
      render: (v: string) => <><TableOutlined style={{ marginRight: 6 }} />{v}</>,
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
      title: '操作', key: 'action', width: 240, className: 'table-action-column',
      render: (_: any, r: RemoteTable) => (
        <Space>
          <Button type="primary" size="small" icon={<EyeOutlined />} onClick={() => openPreview(r)}>预览</Button>
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
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  <Button type="primary" size="small" icon={<EyeOutlined />} onClick={() => openPreview(r)}>预览</Button>
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
          <Table dataSource={tables} columns={columns} rowKey="id"
            loading={loading} pagination={false} size="small"
            scroll={{ x: 'max-content' }}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: (keys: React.Key[]) => setSelectedKeys(keys as number[]),
            }} />
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
          <Form.Item label="表中文名" name="name" rules={[{ required: true, message: '请输入表名' }]}>
            <Input placeholder="例如：单位信息表、学生信息表" />
          </Form.Item>
          <Form.Item label="数据 API URL" name="data_api_url" rules={[{ required: true, message: '请输入数据 API URL' }]}>
            <Input.TextArea rows={2} placeholder="http://dataapi.example.com/...?access_token=..." />
          </Form.Item>
        </Form>
        <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12, marginTop: 4 }}>
          <div style={{ fontWeight: 500, marginBottom: 8, color: '#595959' }}>默认查询条件</div>
          <ConditionBuilder value={editQuery} onChange={setEditQuery}
 />
        </div>
      </Modal>

      {/* ======== 预览弹窗 ======== */}
      <Modal
        title={previewTable ? <><EyeOutlined /> {previewTable.name} - 数据预览</> : '数据预览'}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width="90%"
      >
        {previewTable && (
          <>
            <div style={{ marginBottom: 12, fontSize: 13, color: '#8c8c8c', wordBreak: 'break-all' }}>
              数据 API URL: {previewTable.data_api_url}
            </div>

            <ConditionBuilder value={previewQuery} onChange={setPreviewQuery}
              knownFields={previewFields}
              onPreview={handlePreviewFetch} />

            <Space style={{ marginTop: 12 }}>
              <Button type="primary" icon={<DownloadOutlined />}
                onClick={handlePreviewFetch} loading={previewFetching}>
                获取数据
              </Button>
              <Button icon={<SaveOutlined />} onClick={handlePreviewSave}>
                保存当前条件
              </Button>
            </Space>

            {previewMeta && (
              <Space style={{ marginTop: 12 }} wrap>
                <Tag color="blue">耗时: {(previewMeta.duration / 1000).toFixed(2)}s</Tag>
                <Tag color="green">返回: {previewMeta.recordCount} 条</Tag>
              </Space>
            )}

            {previewFetching && (
              <div style={{ textAlign: 'center', margin: 24 }}><Spin tip="正在获取..." /></div>
            )}

            {(previewRecords || previewRaw) && (
              <Card size="small" title={'数据 (' + (previewRecords?.length ?? 0) + ' 条)'}
                style={{ marginTop: 16 }} type="inner"
                extra={<Text copyable={{ text: JSON.stringify(previewRecords, null, 2) }} style={{ fontSize: 12 }}>复制</Text>}
              >
                <Tabs
                  defaultActiveKey="data"
                  items={[
                    { key: 'data', label: '数据 (' + (previewRecords?.length ?? 0) + ')',
                      children: <JsonTreeViewer data={previewRecords} /> },
                    { key: 'raw', label: '全部返回',
                      children: <JsonTreeViewer data={previewRaw} /> },
                  ]}
                />
              </Card>
            )}
          </>
        )}
      </Modal>
    </div>
  );
};

export default TableConfig;

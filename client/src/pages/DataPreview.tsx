import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Space, message, Alert, Typography, Spin, Tag, Tabs, Select } from 'antd';
import { ApiOutlined, SaveOutlined, DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import { getDataApiConfig, saveDataApiConfig, fetchRemoteData, listRemoteTables, getRemoteTable } from '../api';
import type { QueryParams, RemoteTable, QueryCondition } from '../api';
import JsonTreeViewer from '../components/JsonTreeViewer';
import ConditionBuilder from '../components/ConditionBuilder';

const { Text } = Typography;

const defaultQuery: QueryParams = {
  conditions: [], logic: 'and', page: 1, perPage: 20, orderField: '', orderDir: 'asc',
};

const DataPreview: React.FC = () => {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [records, setRecords] = useState<any[] | null>(null);
  const [rawResponse, setRawResponse] = useState<any>(null);
  const [meta, setMeta] = useState<{ duration: number; recordCount: number } | null>(null);
  const [error, setError] = useState<string>('');
  const [query, setQuery] = useState<QueryParams>(defaultQuery);
  const [dataStruct, setDataStruct] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number>(0);
  const [showFilter, setShowFilter] = useState(false);
  const [savedTables, setSavedTables] = useState<RemoteTable[]>([]);
  const [selectedTableLabel, setSelectedTableLabel] = useState<string>("");
  const [selectedApiUrl, setSelectedApiUrl] = useState<string>("");

  useEffect(() => {
    loadConfig();
    loadSavedTables();
  }, []);



  const loadTableConfig = async (id: number) => {
    try {
      const res = await getRemoteTable(id);
      if (res.success && res.data) {
        const t = res.data;
        form.setFieldsValue({ data_api_url: t.data_api_url });
        setQuery({
          conditions: JSON.parse(t.conditions || '[]') as QueryCondition[],
          logic: (t.logic as 'and' | 'or') || 'and',
          page: t.page || 1,
          perPage: t.per_page || 20,
          orderField: t.order_field || '',
          orderDir: (t.order_dir as 'asc' | 'desc') || 'asc',
        });
        setSelectedTableLabel(t.name);
        setSelectedApiUrl(t.data_api_url);
        setShowFilter(true);
        setRecords(null);
        setError('');
        message.info('已加载「' + t.name + '」配置');
      }
    } catch { message.error('加载表配置失败'); }
  };

  const loadConfig = async () => {
    try {
      const res = await getDataApiConfig();
      if (res.success && res.data) {
        form.setFieldsValue({ data_api_url: res.data.data_api_url });
      }
    } catch { /* ignore */ }
  };

  const loadSavedTables = async () => {
    try {
      const res = await listRemoteTables();
      if (res.success) setSavedTables(res.data);
    } catch { /* ignore */ }
  };

  const selectSavedTable = (tableId: number) => {
    loadTableConfig(tableId);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const res = await saveDataApiConfig(values.data_api_url);
      if (res.success) message.success('数据 API 配置保存成功');
      else message.error(res.message);
    } catch (err: any) {
      if (err.errorFields) return;
      message.error('保存失败: ' + err.message);
    } finally { setSaving(false); }
  };

  const handleFetch = async () => {
    try { await form.validateFields(); } catch {
      message.warning('请先填写数据 API URL');
      return;
    }
    setFetching(true); setError(''); setRecords(null); setRawResponse(null); setMeta(null); setTotal(0);
    try {
      const res = await fetchRemoteData(query, selectedApiUrl || undefined);
      if (res.success && res.data) {
        setRecords(res.data.records);
        setRawResponse(res.data.rawResponse);
        setTotal(res.data.total);
        if (res.meta) setMeta(res.meta);
        if (res.data.dataStruct) setDataStruct(prev => ({ ...prev, ...res.data.dataStruct }));
        message.success(res.message);
        return { records: res.data.records, rawResponse: res.data.rawResponse, total: res.data.total };
      } else {
        setError(res.message); message.error(res.message);
      }
    } catch (err: any) {
      const errMsg = '请求失败: ' + err.message;
      setError(errMsg); message.error(errMsg);
    } finally { setFetching(false); }
  };

  return (
    <div style={{ margin: 24 }}>
      <Card title={<><ApiOutlined /> 数据预览</>}>
        <Form form={form} layout="vertical" style={{ maxWidth: 700 }}>
          <Form.Item label="数据 API URL" name="data_api_url"
            rules={[{ required: true, message: '请输入数据 API URL' }]}
            extra={selectedTableLabel ? '来自配置：' + selectedTableLabel : '按 ⌘+Enter 快速获取数据'}
          >
            <Input placeholder="http://dataapi.example.com/open_api/customization/xxx/full?access_token=..." />
          </Form.Item>

          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>保存配置</Button>
            <Button icon={<DownloadOutlined />} onClick={handleFetch} loading={fetching}>获取数据</Button>
            <Button icon={<FilterOutlined />} onClick={() => setShowFilter(!showFilter)}
              type={showFilter ? 'primary' : 'default'} ghost={showFilter}>
              条件设置 {query.conditions.length > 0 && '(' + query.conditions.length + ')'}
            </Button>

            <Select
              placeholder="加载已保存的表配置"
              style={{ width: 220 }} size="middle"
              value={undefined} onChange={selectSavedTable} allowClear
              options={savedTables.map(t => ({ value: t.id, label: t.name }))}
            />
          </Space>
        </Form>

        {showFilter && (
          <ConditionBuilder value={query} onChange={setQuery} knownFields={dataStruct} onPreview={handleFetch} />
        )}

        {meta && (
          <Space style={{ marginTop: 16 }} wrap>
            <Tag color="blue">请求耗时: {(meta.duration / 1000).toFixed(2)}s</Tag>
            <Tag color="green">返回记录: {meta.recordCount}</Tag>
            <Tag color="purple">总数: {total}</Tag>
          </Space>
        )}

        {fetching && <div style={{ textAlign: 'center', marginTop: 24 }}><Spin tip="正在获取远程数据..." /></div>}

        {(records || rawResponse) && (
          <Card size="small" title={'数据记录 (' + (records?.length ?? 0) + ' 条)'}
            style={{ marginTop: 24 }} type="inner"
          >
            <Tabs
              defaultActiveKey="data"
              items={[
                { key: 'data', label: '数据 (' + (records?.length ?? 0) + ')', children: <JsonTreeViewer data={records} /> },
                { key: 'raw', label: '全部返回', children: <JsonTreeViewer data={rawResponse} /> },
              ]}
              tabBarExtraContent={
                <Text copyable={{ text: JSON.stringify(records, null, 2) }} style={{ fontSize: 12 }}>复制数据</Text>
              }
            />
          </Card>
        )}

        {error && <Alert message="请求失败" description={error} type="error" showIcon style={{ marginTop: 16, maxWidth: 700 }} />}
      </Card>
    </div>
  );
};

export default DataPreview;

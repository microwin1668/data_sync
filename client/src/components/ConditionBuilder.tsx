import React, { useState, useMemo } from 'react';
import { Card, Select, Input, Button, Space, Tag, Tooltip, Radio, Modal, Tabs, Spin, message, Typography } from 'antd';
import {
  PlusOutlined, DeleteOutlined, SearchOutlined,
  ArrowUpOutlined, ArrowDownOutlined,
} from '@ant-design/icons';
import type { QueryCondition, QueryParams } from '../api';
import JsonTreeViewer from './JsonTreeViewer';

interface ConditionBuilderProps {
  value: QueryParams;
  onChange: (params: QueryParams) => void;
  // 字段名 → 中文描述映射，用于智能提示
  knownFields?: Record<string, string>;
  onPreview?: () => Promise<{ records: any[]; rawResponse: any; total?: number } | void>;
  /** 是否正在预览 */
  previewLoading?: boolean;
}

const { TextArea } = Input;

const OPERATORS = [
  { value: 'eq', label: '等于 (=)', description: '精确匹配' },
  { value: 'neq', label: '不等于 (!=)', description: '不匹配' },
  { value: 'like', label: '包含 (LIKE)', description: '模糊匹配，如 %keyword%' },
  { value: 'gt', label: '大于 (>)', description: '大于指定值' },
  { value: 'gte', label: '大于等于 (>=)', description: '大于或等于指定值' },
  { value: 'lt', label: '小于 (<)', description: '小于指定值' },
  { value: 'lte', label: '小于等于 (<=)', description: '小于或等于指定值' },
  { value: 'between', label: '介于 (BETWEEN)', description: '两个值之间，用逗号分隔' },
  { value: 'in', label: '包含于 (IN)', description: '多个值，用逗号分隔' },
];

const defaultCondition: QueryCondition = { field: '', operator: 'eq', value: '' };

const ConditionBuilder: React.FC<ConditionBuilderProps> = ({ value, onChange, knownFields = {}, onPreview }) => {
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewRecords, setPreviewRecords] = useState<any[] | null>(null);
  const [previewRaw, setPreviewRaw] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTotal, setPreviewTotal] = useState<number>(0);


  // 构建 AutoComplete 选项（字段名 + 中文描述）
  const fieldOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: { value: string; label: React.ReactNode }[] = [];

    const addField = (name: string, desc: string) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      result.push({
        value: name,
        label: (
          <Space>
            <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{name}</span>
            {desc && <span style={{ color: '#8c8c8c', fontSize: 12 }}>{desc}</span>}
          </Space>
        ),
      });
    };

    // 优先展示有中文描述的字段
    for (const [name, desc] of Object.entries(knownFields)) {
      addField(name, desc);
    }
    // 补充用户手动输入的字段
    for (const name of customFields) {
      addField(name, '');
    }
    return result;
  }, [knownFields, customFields]);

  const updateCondition = (index: number, patch: Partial<QueryCondition>) => {
    const newConds = value.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onChange({ ...value, conditions: newConds });
  };

  const addCondition = () => {
    onChange({ ...value, conditions: [...value.conditions, { ...defaultCondition }] });
  };

  const removeCondition = (index: number) => {
    onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== index) });
  };

  const placeholderHint = (op: string) => {
    switch (op) {
      case 'like': return '模糊查询，需管理员开通字段权限（如：学院）';
      case 'between': return '最小值, 最大值';
      case 'in': return '值1, 值2, 值3';
      default: return '输入值';
    }
  };

  return (
    <>
    <Card
      size="small"
      title={<><SearchOutlined /> 查询条件</>}
      style={{ marginTop: 16 }}
      extra={
        <Space>
          <Radio.Group
            size="small"
            value={value.logic}
            onChange={e => onChange({ ...value, logic: e.target.value })}
          >
            <Radio.Button value="and">AND</Radio.Button>
            <Radio.Button value="or">OR</Radio.Button>
          </Radio.Group>
          {onPreview && (
            <Button size="small" type="primary" icon={<SearchOutlined />} loading={previewLoading}
              onClick={async () => {
                setPreviewLoading(true);
                try {
                  const result = await onPreview();
                  if (result) {
                    setPreviewRecords(result.records || []);
                    setPreviewRaw(result.rawResponse);
                    setPreviewTotal(result.total || 0);
                    setPreviewModalOpen(true);
                  }
                } catch (err: any) {
                  message.error(err.message || '预览失败');
                } finally {
                  setPreviewLoading(false);
                }
              }}>
              预览数据
            </Button>
          )}
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addCondition}>
            添加条件
          </Button>
        </Space>
      }
      styles={{ body: value.conditions.length === 0 ? { padding: '8px 16px' } : undefined }}
    >
      {value.conditions.length === 0 && (
        <div style={{ color: '#8c8c8c', fontSize: 13, textAlign: 'center', padding: '4px 0' }}>
          暂无条件，点击"添加条件"设置查询过滤条件
        </div>
      )}

      {value.conditions.map((cond, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            padding: '6px 8px',
            background: '#fafafa',
            borderRadius: 6,
            border: '1px solid #f0f0f0',
            flexWrap: 'wrap',
          }}
        >
          {i > 0 && (
            <Tag color="processing" style={{ marginRight: 0, lineHeight: '20px', fontSize: 12 }}>
              {value.logic.toUpperCase()}
            </Tag>
          )}

          <Select
            style={{ width: 200 }}
            options={fieldOptions}
            value={cond.field || undefined}
            onChange={val => {
              updateCondition(i, { field: val || '' });
            }}
            placeholder="选择字段名"
            size="small"
            showSearch
            allowClear
          />

          <Select
            style={{ width: 150 }}
            value={cond.operator}
            onChange={val => updateCondition(i, { operator: val, value: '' })}
            size="small"
            options={OPERATORS.map(op => ({
              value: op.value,
              label: (
                <Tooltip title={op.description}>
                  <span>{op.label}</span>
                </Tooltip>
              ),
            }))}
          />

          <Input
            style={{ width: 200 }}
            size="small"
            value={cond.value}
            onChange={e => updateCondition(i, { value: e.target.value })}
            placeholder={placeholderHint(cond.operator)}
          />

          {(cond.operator === 'between' || cond.operator === 'in') && (
            <Tag color="default" style={{ fontSize: 11, lineHeight: '18px' }}>
              多个值用逗号分隔
            </Tag>
          )}

          <Tooltip title="删除条件">
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => removeCondition(i)}
            />
          </Tooltip>
        </div>
      ))}

      {/* 分页和排序 */}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
        <Space wrap size="middle">
          <Space size={4}>
            <span style={{ fontSize: 13, color: '#595959' }}>每页</span>
            <Select
              size="small"
              style={{ width: 80 }}
              value={value.perPage}
              onChange={val => onChange({ ...value, perPage: val })}
              options={[10, 20, 50, 100, 200].map(n => ({ value: n, label: String(n) }))}
            />
            <span style={{ fontSize: 13, color: '#595959' }}>条</span>
          </Space>

          <Space size={4}>
            <span style={{ fontSize: 13, color: '#595959' }}>当前第</span>
            <Input
              size="small"
              type="number"
              style={{ width: 60 }}
              min={1}
              value={value.page}
              onChange={e => onChange({ ...value, page: Math.max(1, parseInt(e.target.value) || 1) })}
            />
            <span style={{ fontSize: 13, color: '#595959' }}>页</span>
          </Space>

          <Space size={4}>
            <span style={{ fontSize: 13, color: '#595959' }}>排序</span>
            <Select
              size="small"
              style={{ width: 180 }}
              value={value.orderField}
              onChange={val => onChange({ ...value, orderField: val })}
              placeholder="选择排序字段"
              options={fieldOptions}
              allowClear
              showSearch
            />
            <Select
              size="small"
              style={{ width: 80 }}
              value={value.orderDir}
              onChange={val => onChange({ ...value, orderDir: val })}
              options={[
                { value: "asc", label: <><ArrowUpOutlined /> 升序</> },
                { value: "desc", label: <><ArrowDownOutlined /> 降序</> },
              ]}
            />
          </Space>
        </Space>
      </div>
    </Card>

      {/* 预览数据弹窗 */}
      <Modal
        title="数据预览"
        open={previewModalOpen}
        onCancel={() => setPreviewModalOpen(false)}
        footer={null}
        width="90%"
        style={{ top: 20, maxWidth: 1200 }}
      >
        <Space style={{ marginBottom: 12 }}>
          <Tag color="purple">总数: {previewTotal}</Tag>
          <Tag color="blue">{previewRecords?.length ?? 0} 条</Tag>
        </Space>
        <Tabs
          defaultActiveKey="data"
          items={[
            {
              key: 'data',
              label: `数据 (${previewRecords?.length ?? 0})`,
              children: <JsonTreeViewer data={previewRecords} defaultExpanded={false} maxHeight={500} />,
            },
            {
              key: 'raw',
              label: '全部返回',
              children: <JsonTreeViewer data={previewRaw} defaultExpanded={false} maxHeight={500} />,
            },
          ]}
        />
      </Modal>
    </>
  );
};

export default ConditionBuilder;

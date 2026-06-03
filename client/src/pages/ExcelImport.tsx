import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Col, Divider, Empty, Form, Progress, Row, Select, Space,
  Table, Tag, Typography, Upload, message,
} from 'antd';
import {
  CheckCircleOutlined, DatabaseOutlined, DownloadOutlined, FileExcelOutlined,
  ImportOutlined, UploadOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import * as XLSX from 'xlsx';
import {
  listPgColumnsInSource, listPgSources, listPgTablesInSource, runExcelImport,
} from '../api';
import type { PgDatasource, ExcelImportMapping } from '../api';

const { Text } = Typography;

interface TargetColumn {
  name: string;
  type: string;
  comment: string;
}

interface MappingRow {
  key: string;
  targetField: string;
  targetType: string;
  comment: string;
  sourceField: string;
  isPk: boolean;
}

const normalizeField = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '');

const trimRow = (row: Record<string, any>) => {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    result[String(key).trim()] = value;
  }
  return result;
};

const isBlankRow = (row: Record<string, any>) =>
  Object.values(row).every(value => value === null || value === undefined || String(value).trim() === '');

const ExcelImport: React.FC = () => {
  const [form] = Form.useForm();
  const [pgSources, setPgSources] = useState<PgDatasource[]>([]);
  const [pgTables, setPgTables] = useState<string[]>([]);
  const [targetColumns, setTargetColumns] = useState<TargetColumn[]>([]);
  const [excelFields, setExcelFields] = useState<string[]>([]);
  const [excelRows, setExcelRows] = useState<Record<string, any>[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  useEffect(() => {
    setLoadingSources(true);
    listPgSources()
      .then(res => { if (res.success) setPgSources(res.data); })
      .catch(err => message.error('加载数据库失败: ' + (err.message || String(err))))
      .finally(() => setLoadingSources(false));
  }, []);

  const matchedCount = mappings.filter(m => m.sourceField && m.targetField).length;
  const previewColumns = excelFields.slice(0, 8).map(field => ({
    title: field,
    dataIndex: field,
    key: field,
    width: 140,
    ellipsis: true,
  }));

  const refreshMappings = (columns: TargetColumn[], fields: string[]) => {
    const exactMap = new Map(fields.map(field => [field, field]));
    const normalizedMap = new Map(fields.map(field => [normalizeField(field), field]));
    setMappings(columns.map(column => {
      const sourceField = exactMap.get(column.name) || normalizedMap.get(normalizeField(column.name)) || '';
      return {
        key: column.name,
        targetField: column.name,
        targetType: column.type,
        comment: column.comment || '',
        sourceField,
        isPk: false,
      };
    }));
  };

  const handleSourceChange = async (sourceId: number) => {
    form.setFieldsValue({ target_table: undefined });
    setPgTables([]);
    setTargetColumns([]);
    setMappings([]);
    setImportResult(null);
    const source = pgSources.find(item => item.id === sourceId);
    if (!source) return;
    setLoadingTables(true);
    try {
      const res = await listPgTablesInSource({
        host: source.host,
        port: source.port,
        user: source.user,
        password: source.password,
        database: source.database,
        schema: source.schema,
      });
      if (res.success) setPgTables(res.tables || []);
      else message.error(res.message || '读取目标表失败');
    } catch (err: any) {
      message.error('读取目标表失败: ' + (err.message || String(err)));
    } finally {
      setLoadingTables(false);
    }
  };

  const handleTableChange = async (tableName: string) => {
    setTargetColumns([]);
    setMappings([]);
    setImportResult(null);
    const sourceId = form.getFieldValue('pg_source_id');
    const selectedSource = pgSources.find(source => source.id === sourceId);
    if (!selectedSource || !tableName) return;
    setLoadingColumns(true);
    try {
      const res = await listPgColumnsInSource({
        host: selectedSource.host,
        port: selectedSource.port,
        user: selectedSource.user,
        password: selectedSource.password,
        database: selectedSource.database,
        schema: selectedSource.schema,
        table: tableName,
      });
      if (res.success) {
        const columns = (res.columns || []).map((c: any) => ({
          name: c.name,
          type: c.type,
          comment: c.comment || '',
        }));
        setTargetColumns(columns);
        refreshMappings(columns, excelFields);
      } else {
        message.error(res.message || '读取字段失败');
      }
    } catch (err: any) {
      message.error('读取字段失败: ' + (err.message || String(err)));
    } finally {
      setLoadingColumns(false);
    }
  };

  const downloadTemplate = () => {
    const tableName = form.getFieldValue('target_table');
    if (!tableName || targetColumns.length === 0) {
      message.warning('请先选择目标表');
      return;
    }

    const headers = targetColumns.map(column => column.name);
    const dataSheet = XLSX.utils.aoa_to_sheet([headers]);
    const descRows = [['字段名', '类型', '注释'], ...targetColumns.map(column => [column.name, column.type, column.comment])];
    const descSheet = XLSX.utils.aoa_to_sheet(descRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, dataSheet, '导入数据');
    XLSX.utils.book_append_sheet(workbook, descSheet, '字段说明');
    XLSX.writeFile(workbook, `${tableName}_导入模板.xlsx`);
  };

  const beforeUpload: UploadProps['beforeUpload'] = async (file) => {
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '', raw: false })
        .map(trimRow)
        .filter(row => !isBlankRow(row));

      if (rows.length === 0) {
        message.warning('Excel 中没有可读取的数据');
        return Upload.LIST_IGNORE;
      }

      const fields = Object.keys(rows[0] || {}).filter(Boolean);
      setExcelFields(fields);
      setExcelRows(rows);
      refreshMappings(targetColumns, fields);
      setImportResult(null);
      message.success(`已读取 ${rows.length} 行，${fields.length} 个字段`);
    } catch (err: any) {
      message.error('读取 Excel 失败: ' + (err.message || String(err)));
    }
    return Upload.LIST_IGNORE;
  };

  const updateMapping = (targetField: string, patch: Partial<MappingRow>) => {
    setMappings(prev => prev.map(row => row.targetField === targetField ? { ...row, ...patch } : row));
  };

  const handleAutoMatch = () => {
    if (targetColumns.length === 0 || excelFields.length === 0) {
      message.warning('请先选择目标表并上传 Excel');
      return;
    }
    refreshMappings(targetColumns, excelFields);
    message.success('已按字段名自动匹配');
  };

  const handleImport = async () => {
    const values = await form.validateFields();
    const activeMappings: ExcelImportMapping[] = mappings
      .filter(row => row.sourceField && row.targetField)
      .map(row => ({ sourceField: row.sourceField, targetField: row.targetField, isPk: row.isPk }));

    if (excelRows.length === 0) {
      message.warning('请先上传 Excel');
      return;
    }
    if (activeMappings.length === 0) {
      message.warning('请至少确认一个字段映射');
      return;
    }

    setImporting(true);
    setImportResult(null);
    try {
      const res = await runExcelImport({
        pg_source_id: values.pg_source_id,
        target_table: values.target_table,
        rows: excelRows,
        mappings: activeMappings,
        batch_size: 200,
      });
      if (res.success) {
        setImportResult(res.data);
        if ((res.data?.error || 0) > 0) message.warning(res.message);
        else message.success(res.message);
      } else {
        message.error(res.message || '导入失败');
      }
    } catch (err: any) {
      message.error('导入失败: ' + (err.message || String(err)));
    } finally {
      setImporting(false);
    }
  };

  const mappingColumns = [
    { title: '目标字段', dataIndex: 'targetField', key: 'targetField', width: 180 },
    { title: '类型', dataIndex: 'targetType', key: 'targetType', width: 140, responsive: ['sm'] as any },
    { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true, responsive: ['md'] as any },
    {
      title: 'Excel 字段',
      dataIndex: 'sourceField',
      key: 'sourceField',
      width: 220,
      render: (_: string, row: MappingRow) => (
        <Select
          allowClear
          showSearch
          size="small"
          style={{ width: '100%' }}
          placeholder="选择 Excel 字段"
          value={row.sourceField || undefined}
          options={excelFields.map(field => ({ value: field, label: field }))}
          onChange={value => updateMapping(row.targetField, { sourceField: value || '' })}
        />
      ),
    },
    {
      title: '主键',
      dataIndex: 'isPk',
      key: 'isPk',
      width: 70,
      align: 'center' as const,
      render: (_: boolean, row: MappingRow) => (
        <Checkbox checked={row.isPk} onChange={event => updateMapping(row.targetField, { isPk: event.target.checked })} />
      ),
    },
  ];

  return (
    <div className="responsive-page-container">
      <Card title={<><FileExcelOutlined /> Excel 手动导入</>}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="目标数据库" name="pg_source_id" rules={[{ required: true, message: '请选择目标数据库' }]}>
                <Select
                  showSearch
                  loading={loadingSources}
                  placeholder="选择数据库"
                  options={pgSources.map(source => ({ value: source.id, label: `${source.name} (${source.database})` }))}
                  onChange={handleSourceChange}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="目标表" name="target_table" rules={[{ required: true, message: '请选择目标表' }]}>
                <Select
                  showSearch
                  loading={loadingTables}
                  placeholder="选择目标表"
                  options={pgTables.map(table => ({ value: table, label: table }))}
                  onChange={handleTableChange}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="模板与文件">
                <Space wrap>
                  <Button icon={<DownloadOutlined />} onClick={downloadTemplate} disabled={targetColumns.length === 0}>
                    下载模板
                  </Button>
                  <Upload accept=".xlsx,.xls" showUploadList={false} beforeUpload={beforeUpload}>
                    <Button icon={<UploadOutlined />}>打开 Excel</Button>
                  </Upload>
                </Space>
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Excel 导入只在当前页面手动执行，不创建数据表配置，也不会加入任务调度或备份流程。"
        />

        <Row gutter={16}>
          <Col xs={24} lg={16}>
            <Space style={{ marginBottom: 12 }} wrap>
              <Tag icon={<DatabaseOutlined />} color="blue">目标字段 {targetColumns.length}</Tag>
              <Tag icon={<FileExcelOutlined />} color="green">Excel 行数 {excelRows.length}</Tag>
              <Tag icon={<CheckCircleOutlined />} color={matchedCount > 0 ? 'success' : 'default'}>已匹配 {matchedCount}</Tag>
              <Button size="small" onClick={handleAutoMatch} disabled={targetColumns.length === 0 || excelFields.length === 0}>
                自动匹配字段
              </Button>
            </Space>

            <Table
              rowKey="targetField"
              size="small"
              loading={loadingColumns}
              dataSource={mappings}
              columns={mappingColumns}
              pagination={false}
              scroll={{ x: 'max-content', y: 420 }}
              locale={{ emptyText: <Empty description="请选择目标表" /> }}
            />
          </Col>
          <Col xs={24} lg={8}>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 12, minHeight: 180 }}>
              <div style={{ fontWeight: 500, marginBottom: 12 }}>数据预览</div>
              {excelRows.length === 0 ? (
                <Empty description="尚未打开 Excel" />
              ) : (
                <Table
                  rowKey={(_, index) => String(index)}
                  size="small"
                  dataSource={excelRows.slice(0, 5)}
                  columns={previewColumns}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                />
              )}
            </div>
          </Col>
        </Row>

        <Divider />

        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Button
              type="primary"
              icon={<ImportOutlined />}
              loading={importing}
              disabled={excelRows.length === 0 || matchedCount === 0}
              onClick={handleImport}
            >
              确认导入
            </Button>
            <Text type="secondary">勾选主键字段后将按 ON CONFLICT 更新；不勾选主键则直接插入。</Text>
          </Space>

          {importing && <Progress percent={99} status="active" showInfo={false} />}

          {importResult && (
            <Alert
              type={importResult.error > 0 ? 'warning' : 'success'}
              showIcon
              message={`导入完成: ${importResult.success} 成功, ${importResult.error} 失败`}
              description={
                <Space direction="vertical">
                  <Text>总行数: {importResult.total}</Text>
                  {importResult.logFilename && (
                    <Button size="small" icon={<DownloadOutlined />} href={'/api/logs/' + importResult.logFilename} target="_blank">
                      下载失败日志
                    </Button>
                  )}
                </Space>
              }
            />
          )}
        </Space>
      </Card>
    </div>
  );
};

export default ExcelImport;

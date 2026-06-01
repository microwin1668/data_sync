import React, { useState } from 'react';

interface JsonNodeProps {
  label: string;
  value: unknown;
  defaultExpanded?: boolean;
  depth: number;
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    lineHeight: '22px',
    fontSize: 13,
    fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace",
  },
  indent: {
    display: 'inline-block',
    width: 20,
    flexShrink: 0,
  },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    flexShrink: 0,
    cursor: 'pointer',
    color: '#8c8c8c',
    fontSize: 10,
    userSelect: 'none',
    marginTop: 3,
    borderRadius: 3,
  },
  key: {
    color: '#881280',
    marginRight: 4,
    flexShrink: 0,
  },
  colon: {
    marginRight: 4,
    color: '#434343',
  },
  bracket: {
    color: '#434343',
  },
  count: {
    color: '#8c8c8c',
    fontSize: 11,
    marginLeft: 4,
  },
  string: { color: '#0b8235' },
  number: { color: '#1750eb' },
  boolean: { color: '#c41d7f' },
  null: { color: '#8c8c8c', fontStyle: 'italic' },
};

function getValueStyle(value: unknown): React.CSSProperties {
  switch (typeof value) {
    case 'string': return styles.string;
    case 'number': return styles.number;
    case 'boolean': return styles.boolean;
    default: return styles.null;
  }
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function JsonNode({ label, value, defaultExpanded, depth }: JsonNodeProps) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const isCollapsible = isObject || isArray;

  const [expanded, setExpanded] = useState(defaultExpanded ?? depth < 2);

  if (!isCollapsible) {
    return (
      <div style={styles.row}>
        {depth > 0 && <span style={styles.indent} />}
        {label !== '' && (
          <>
            <span style={styles.key}>{label}</span>
            <span style={styles.colon}>:</span>
          </>
        )}
        <span style={getValueStyle(value)}>{formatValue(value)}</span>
      </div>
    );
  }

  const entries = isObject
    ? Object.entries(value as Record<string, unknown>)
    : (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown]);

  const count = entries.length;
  const openBracket = isObject ? '{' : '[';
  const closeBracket = isObject ? '}' : ']';

  return (
    <div>
      <div style={{ ...styles.row, cursor: isCollapsible ? 'pointer' : undefined }} onClick={() => setExpanded(!expanded)}>
        {depth > 0 && <span style={styles.indent} />}
        <span style={styles.toggle}>{expanded ? '▼' : '▶'}</span>
        {label !== '' && (
          <>
            <span style={styles.key}>{label}</span>
            <span style={styles.colon}>:</span>
          </>
        )}
        <span style={styles.bracket}>
          {expanded ? openBracket : `${openBracket} ${count} item${count !== 1 ? 's' : ''} ${closeBracket}`}
        </span>
      </div>
      {expanded && (
        <div>
          {entries.map(([key, val]) => (
            <div key={key}>
              <JsonNode
                label={isObject ? key : ''}
                value={val}
                depth={depth + 1}
                defaultExpanded={depth < 2}
              />
            </div>
          ))}
          <div style={styles.row}>
            <span style={{ display: 'inline-block', width: depth * 20 + 20, flexShrink: 0 }} />
            <span style={styles.bracket}>{closeBracket}</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface JsonTreeViewerProps {
  data: unknown;
  defaultExpanded?: boolean;
  maxHeight?: number;
}

const JsonTreeViewer: React.FC<JsonTreeViewerProps> = ({ data, defaultExpanded, maxHeight = 500 }) => {
  return (
    <div
      style={{
        background: '#fafafa',
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        padding: '12px 16px',
        maxHeight,
        overflow: 'auto',
        fontSize: 13,
        lineHeight: '22px',
        fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace",
      }}
    >
      <JsonNode label="" value={data} defaultExpanded={defaultExpanded} depth={0} />
    </div>
  );
};

export default JsonTreeViewer;

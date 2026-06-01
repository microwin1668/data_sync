import React, { useState, useEffect } from 'react';
import { ConfigProvider, Layout, Menu, theme } from 'antd';
import { KeyOutlined, EyeOutlined, TableOutlined, SwapOutlined, ClockCircleOutlined, CloudServerOutlined, UserOutlined, LogoutOutlined } from '@ant-design/icons';
import TokenConfig from './pages/TokenConfig';
import DataPreview from './pages/DataPreview';
import BackupConfig from './pages/BackupConfig';
import TableConfig from './pages/TableConfig';
import DataSync from './pages/DataSync';
import TaskManager from './pages/TaskManager';
import Login from './pages/Login';

const { Header, Content, Footer } = Layout;

const menuItems = [
  { key: 'token', icon: <KeyOutlined />, label: '系统配置' },
  { key: 'tables', icon: <TableOutlined />, label: '数据表配置' },
  { key: 'sync', icon: <SwapOutlined />, label: '数据导入配置' },
  { key: 'backup', icon: <CloudServerOutlined />, label: '数据库备份配置' },
  { key: 'task', icon: <ClockCircleOutlined />, label: '任务管理' },
  { key: 'data', icon: <EyeOutlined />, label: '数据预览' },
];

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [activeKey, setActiveKey] = useState('token');
  const [serverTime, setServerTime] = useState<string>('');
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch('/api/auth/check')
      .then(r => r.json())
      .then(d => { if (d.success) setAuthenticated(d.data?.loggedIn || false); })
      .catch(() => setAuthenticated(false));
  }, []);

  const handleLoginSuccess = () => {
    setAuthenticated(true);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setAuthenticated(false);
    setLoggingOut(false);
  };

  useEffect(() => {
    const fetchTime = () => {
      fetch('/api/server/time')
        .then(r => r.json())
        .then(d => { if (d.success) setServerTime(d.data.local); })
        .catch(() => {});
    };
    fetchTime();
    const timer = setInterval(fetchTime, 1000);
    return () => clearInterval(timer);
  }, []);

  const renderPage = () => {
    switch (activeKey) {
      case 'token': return <TokenConfig />;
      case 'tables': return <TableConfig />;
      case 'sync': return <DataSync />;
      case 'backup': return <BackupConfig />;
      case 'task': return <TaskManager />;
      case 'data': return <DataPreview />;
      default: return <TokenConfig />;
    }
  };

  if (authenticated === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', fontSize: 16, color: '#999' }}>
        检查登录状态...
      </div>
    );
  }

  if (!authenticated) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <ConfigProvider
      theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#1677ff' } }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', padding: '0 24px' }}>
          <div style={{ color: '#fff', fontSize: 18, fontWeight: 'bold', marginRight: 40, whiteSpace: 'nowrap' }}>
            🚀 数据同步
          </div>
          <Menu
            theme="dark" mode="horizontal" selectedKeys={[activeKey]}
            items={menuItems}
            onClick={({ key }) => setActiveKey(key)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13, whiteSpace: 'nowrap', marginLeft: 16 }}>
            {serverTime}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, marginLeft: 16, borderLeft: '1px solid rgba(255,255,255,0.2)', paddingLeft: 16 }}>
            <UserOutlined />
            <span>admin</span>
            <a style={{ color: 'rgba(255,255,255,0.65)', marginLeft: 8, cursor: 'pointer', textDecoration: 'none' }}
               onClick={handleLogout}>
              <LogoutOutlined /> {loggingOut ? '退出中...' : '退出'}
            </a>
          </div>
        </Header>
        <Content>{renderPage()}</Content>
        <Footer style={{ textAlign: 'center', padding: '12px 24px', color: 'rgba(0,0,0,0.35)', fontSize: 12 }}>
          数据同步平台 v{__APP_VERSION__}
        </Footer>
      </Layout>
    </ConfigProvider>
  );
};

export default App;

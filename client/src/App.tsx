import React, { useState, useEffect } from 'react';
import { ConfigProvider, Layout, Menu, theme, Drawer, Button } from 'antd';
import { KeyOutlined, EyeOutlined, TableOutlined, SwapOutlined, ClockCircleOutlined, CloudServerOutlined, UserOutlined, LogoutOutlined, MenuOutlined, FileExcelOutlined } from '@ant-design/icons';
import TokenConfig from './pages/TokenConfig';
import DataPreview from './pages/DataPreview';
import BackupConfig from './pages/BackupConfig';
import TableConfig from './pages/TableConfig';
import DataSync from './pages/DataSync';
import TaskManager from './pages/TaskManager';
import Login from './pages/Login';
import ExcelImport from './pages/ExcelImport';

const { Header, Content, Footer } = Layout;

const menuItems = [
  { key: 'token', icon: <KeyOutlined />, label: '系统配置' },
  { key: 'tables', icon: <TableOutlined />, label: '数据表配置' },
  { key: 'sync', icon: <SwapOutlined />, label: '数据导入配置' },
  { key: 'excel', icon: <FileExcelOutlined />, label: 'Excel导入' },
  { key: 'backup', icon: <CloudServerOutlined />, label: '数据库备份配置' },
  { key: 'task', icon: <ClockCircleOutlined />, label: '任务管理' },
  { key: 'data', icon: <EyeOutlined />, label: '数据预览' },
];

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [activeKey, setActiveKey] = useState('task');
  const [serverTime, setServerTime] = useState<string>('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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
    setDrawerOpen(false);
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
      case 'excel': return <ExcelImport />;
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
      <style dangerouslySetInnerHTML={{ __html: `
        .responsive-page-container {
          margin: 24px;
        }
        @media (max-width: 768px) {
          .responsive-page-container {
            margin: 8px !important;
          }
          .ant-card-body {
            padding: 12px !important;
          }
          .ant-card-head {
            padding: 0 12px !important;
            min-height: 40px !important;
          }
          .ant-card-head-title {
            padding: 8px 0 !important;
            font-size: 14px !important;
          }
          .ant-tabs-nav {
            margin-bottom: 8px !important;
          }
          .ant-table-cell {
            padding: 8px 8px !important;
            font-size: 12px !important;
          }
          .table-action-column .ant-btn span:not(.anticon) {
            display: none !important;
          }
          .table-action-column .ant-space {
            gap: 4px !important;
          }
          .table-action-column {
            width: auto !important;
            min-width: 90px !important;
            white-space: nowrap !important;
          }
        }
      `}} />
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', padding: isMobile ? '0 16px' : '0 24px', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {isMobile && (
              <Button
                type="text"
                icon={<MenuOutlined style={{ color: '#fff', fontSize: 20 }} />}
                onClick={() => setDrawerOpen(true)}
                style={{ marginRight: 12, padding: 0 }}
              />
            )}
            <div style={{ color: '#fff', fontSize: isMobile ? 16 : 18, fontWeight: 'bold', marginRight: isMobile ? 0 : 40, whiteSpace: 'nowrap' }}>
              🚀 数据同步
            </div>
          </div>

          {!isMobile && (
            <>
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
            </>
          )}

          {isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11 }}>
                {serverTime ? serverTime.split(' ')[1] : ''}
              </div>
              <a style={{ color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center' }}
                 onClick={handleLogout}
                 title="退出登录">
                <LogoutOutlined />
              </a>
            </div>
          )}
        </Header>

        <Drawer
          title="导航菜单"
          placement="left"
          onClose={() => setDrawerOpen(false)}
          open={drawerOpen}
          styles={{ body: { padding: 0 } }}
          width={240}
        >
          <div style={{ padding: '16px', background: '#fafafa', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserOutlined style={{ fontSize: 16, color: '#1677ff' }} />
            <span style={{ fontWeight: 500 }}>当前用户: admin</span>
          </div>
          <Menu
            mode="inline"
            selectedKeys={[activeKey]}
            items={menuItems}
            onClick={({ key }) => {
              setActiveKey(key);
              setDrawerOpen(false);
            }}
            style={{ borderRight: 0 }}
          />
        </Drawer>

        <Content style={{ overflowX: 'hidden' }}>{renderPage()}</Content>
        <Footer style={{ textAlign: 'center', padding: '12px 24px', color: 'rgba(0,0,0,0.35)', fontSize: 12 }}>
          数据同步平台 v{__APP_VERSION__}
        </Footer>
      </Layout>
    </ConfigProvider>
  );
};

export default App;

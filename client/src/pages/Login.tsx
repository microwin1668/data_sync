import React, { useState } from 'react';
import { Card, Form, Input, Button, message, Typography, Alert } from 'antd';
import { UserOutlined, LockOutlined, KeyOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Text } = Typography;

interface LoginProps {
  onLoginSuccess: () => void;
}

const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [changePwd, setChangePwd] = useState(false);
  const [hasDefaultPwd, setHasDefaultPwd] = useState(false);

  React.useEffect(() => {
    axios.get('/api/auth/check').then(r => {
      if (r.data?.success) setHasDefaultPwd(r.data.data?.hasDefaultPassword);
    }).catch(() => {});
  }, []);

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await axios.post('/api/auth/login', values);
      if (res.data.success) {
        message.success('登录成功');
        onLoginSuccess();
      } else {
        message.error(res.data.message);
      }
    } catch (err: any) {
      message.error('登录请求失败: ' + (err.message || ''));
    } finally { setLoading(false); }
  };

  const handleChangePwd = async (values: { oldPassword: string; newPassword: string; confirmPassword: string }) => {
    if (values.newPassword !== values.confirmPassword) {
      message.error('两次输入的新密码不一致');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post('/api/auth/change-password', {
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });
      if (res.data.success) {
        message.success('密码修改成功，请重新登录');
        setChangePwd(false);
      } else {
        message.error(res.data.message);
      }
    } catch (err: any) {
      message.error('修改密码失败: ' + (err.message || ''));
    } finally { setLoading(false); }
  };

  const btnStyle: React.CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: -8,
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f0f2f5' }}>
      <Card style={{ width: 400, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', position: 'relative' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={3} style={{ margin: 0 }}>🚀 数据同步系统</Title>
          <Text type="secondary">请登录</Text>
        </div>

        {hasDefaultPwd && !changePwd && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }}
            message="您正在使用默认密码，建议立即修改"
            action={<Button size="small" onClick={() => setChangePwd(true)}>修改密码</Button>} />
        )}

        {!changePwd ? (
          <Form onFinish={handleLogin} layout="vertical">
            <Form.Item name="username" label="用户名" initialValue="admin"
              rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="admin" disabled />
            </Form.Item>
            <Form.Item name="password" label="密码"
              rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" loading={loading} block>登 录</Button>
            </Form.Item>
            <div style={{ position: 'relative', height: 28 }}>
              <Button type="link" onClick={() => setChangePwd(true)} icon={<KeyOutlined />} style={btnStyle}>修改密码</Button>
            </div>
          </Form>
        ) : (
          <Form onFinish={handleChangePwd} layout="vertical">
            <Form.Item name="oldPassword" label="原密码"
              rules={[{ required: true, message: '请输入原密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="原密码" />
            </Form.Item>
            <Form.Item name="newPassword" label="新密码"
              rules={[{ required: true, message: '请输入新密码' }, { min: 3, message: '至少 3 个字符' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="新密码" />
            </Form.Item>
            <Form.Item name="confirmPassword" label="确认新密码"
              rules={[{ required: true, message: '请确认新密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" loading={loading} block>修改密码</Button>
            </Form.Item>
            <div style={{ position: 'relative', height: 28 }}>
              <Button type="link" onClick={() => setChangePwd(false)} style={btnStyle}>返回登录</Button>
            </div>
          </Form>
        )}
      </Card>
    </div>
  );
};

export default Login;

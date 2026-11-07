import axios from 'axios';
import {
  getConfig, updateAccessToken, listTokenConfigs, getTokenConfigById, updateTokenConfigAccessToken,
} from '../db/sqlite';

export async function fetchAccessToken(): Promise<{ success: boolean; token?: string; message: string }> {
  return fetchAccessTokenFor(undefined);
}

/** 解析 access_token(兼容常见返回结构) */
function extractToken(data: any): string | undefined {
  return data.access_token || data.data?.access_token || data.result?.access_token || data.data?.result?.access_token;
}

/** 获取指定 token 配置(兼容:id 无效时回退到第一条配置,再回退到旧全局单例) */
export async function resolveTokenConfig(tokenConfigId?: number): Promise<{
  id: number; token_url: string; key: string; secret: string; access_token: string;
} | null> {
  if (tokenConfigId && tokenConfigId > 0) {
    const t = await getTokenConfigById(tokenConfigId);
    if (t) return t;
  }
  const list = await listTokenConfigs();
  if (list.length > 0) return list[0];
  const config = await getConfig();
  if (config && config.token_url) {
    return { id: 0, token_url: config.token_url, key: config.key, secret: config.secret, access_token: config.access_token };
  }
  return null;
}

/** 从指定 token 配置获取 access_token(成功后落库到对应配置) */
export async function fetchAccessTokenFor(tokenConfigId?: number): Promise<{ success: boolean; token?: string; message: string }> {
  const tc = await resolveTokenConfig(tokenConfigId);
  if (!tc) {
    return { success: false, message: '未找到 Token 配置,请先在系统配置 → Token 配置中添加' };
  }
  if (!tc.token_url) {
    return { success: false, message: '请先配置 Token URL' };
  }

  try {
    const response = await axios.post(
      tc.token_url,
      { key: tc.key, secret: tc.secret },
      { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
    );
    const data = response.data;
    const accessToken = extractToken(data);

    const isBizSuccess = data.code === undefined || data.code === 10000 || data.code === 0 || data.code === 200;

    if (accessToken && isBizSuccess) {
      // 刷新结果落库到所属配置(id=0 为旧全局兜底)
      if (tc.id > 0) await updateTokenConfigAccessToken(tc.id, accessToken);
      else await updateAccessToken(accessToken);
      return { success: true, token: accessToken, message: 'Token 获取成功' };
    }

    if (data.code !== undefined && !isBizSuccess) {
      const reason = data.message || data.description || ('业务错误码 ' + data.code);
      return { success: false, message: 'Token 获取失败: ' + reason + '，原始返回: ' + JSON.stringify(data) };
    }

    return { success: false, message: 'Token 获取失败: 返回数据中未找到 access_token，原始返回: ' + JSON.stringify(data) };
  } catch (error: any) {
    const errMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    return { success: false, message: '请求失败: ' + errMsg };
  }
}

/** 获取有效 token(按 token 配置):优先取已缓存的 access_token,不存在则实时获取 */
export async function getValidTokenFor(tokenConfigId?: number): Promise<string> {
  const tc = await resolveTokenConfig(tokenConfigId);
  if (!tc) throw new Error('未找到 Token 配置,请先在系统配置 → Token 配置中添加');
  if (tc.access_token) return tc.access_token;
  const result = await fetchAccessTokenFor(tc.id > 0 ? tc.id : undefined);
  if (result.success && result.token) return result.token;
  throw new Error('无法获取 access_token: ' + result.message);
}

/** 兼容旧调用(取第一条配置) */
async function getValidToken(): Promise<string> {
  return getValidTokenFor(undefined);
}

/** 判断响应是否为 token 无效/过期 */
function isTokenInvalid(data: any): boolean {
  if (!data) return false;
  // 常见 token 无效错误码
  const code = data.code;
  if (code === 20010 || code === 401 || code === 20001 || code === 20002) return true;
  // 错误信息中包含 token 相关关键词
  const msg = (data.message || data.description || '').toLowerCase();
  if (msg.includes('token') || msg.includes('access_token') || msg.includes('无效') || msg.includes('过期')) return true;
  return false;
}

/** 带 token 刷新重试的数据请求 */
async function requestWithTokenRetry(
  url: string,
  token: string,
  params: QueryParams | undefined,
  needsPost: boolean,
  retryOnTokenError = true,
  tokenConfigId?: number
): Promise<{ response: any; duration: number; tokenRefreshed: boolean }> {
  const startTime = Date.now();
  let currentToken = token;
  let tokenRefreshed = false;

  const doRequest = async (tok: string) => {
    if (needsPost && params) {
      const body = buildRequestBody(tok, params);
      return await axios.post(url, body, {
        timeout: 120000,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      // GET 请求：动态注入 token
      const urlObj = new URL(url);
      urlObj.searchParams.set('access_token', tok);
      return await axios.get(urlObj.toString(), { timeout: 120000 });
    }
  };

  try {
    const response = await doRequest(currentToken);
    return { response, duration: Date.now() - startTime, tokenRefreshed: false };
  } catch (error: any) {
    const respData = error.response?.data;
    // 检查是否为 token 失效
    if (retryOnTokenError && isTokenInvalid(respData)) {
      // 用所属 token 配置重新获取 token 并重试
      const newTokenResult = await fetchAccessTokenFor(tokenConfigId);
      if (newTokenResult.success && newTokenResult.token) {
        currentToken = newTokenResult.token;
        tokenRefreshed = true;
        // 重试
        const retryResponse = await doRequest(currentToken);
        return { response: retryResponse, duration: Date.now() - startTime, tokenRefreshed: true };
      }
    }
    throw error;
  }
}

export interface QueryCondition {
  field: string;
  operator: 'eq' | 'like' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'neq';
  value: string;
}

export interface QueryParams {
  conditions: QueryCondition[];
  logic: 'and' | 'or';
  page: number;
  perPage: number;
  orderField: string;
  orderDir: 'asc' | 'desc';
}

/** 从 URL 中移除 access_token，返回干净 URL */
function stripTokenFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.delete('access_token');
    return urlObj.toString();
  } catch {
    return url;
  }
}

function buildRequestBody(token: string, params: QueryParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    access_token: token,
  };

  if (params.page > 0) body.page = params.page;
  if (params.perPage > 0) body.per_page = params.perPage;
  if (params.orderField) body.order = { [params.orderField]: params.orderDir };

  if (params.conditions.length === 0) return body;

  // 比较类运算符:纯数字字符串自动转数值(部分接口的数字字段不接受字符串比较)
  const coerceNum = (v: string): any => {
    const s = (v ?? '').trim();
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
  };

  // 把每个条件转为 API 认识的表达方式
  function condToExpr(c: QueryCondition): Record<string, unknown> {
    switch (c.operator) {
      case 'eq':
        return { [c.field]: c.value };
      case 'like':
        // 模糊查询：%%{keyword}%% → API 自动加上 % 通配符 → LIKE '%keyword%'
        const likeVal = c.value.replace(/%%/g, '');  // 防止用户重复加 %%
        return { [c.field]: '%%' + likeVal + '%%' };
      case 'gt':
        return { [c.field]: { gt: coerceNum(c.value) } };
      case 'gte':
        return { [c.field]: { gte: coerceNum(c.value) } };
      case 'lt':
        return { [c.field]: { lt: coerceNum(c.value) } };
      case 'lte':
        return { [c.field]: { lte: coerceNum(c.value) } };
      case 'between': {
        const parts = c.value.split(',').map(s => s.trim());
        if (parts.length >= 2) {
          return { [c.field]: { gte: coerceNum(parts[0]), lte: coerceNum(parts[1]) } };
        }
        return { [c.field]: c.value };
      }
      case 'in': {
        const items = c.value.split(',').map(s => s.trim());
        return { [c.field]: { in: items } };
      }
      case 'neq':
        return { [c.field]: { neq: c.value } };
      default:
        return { [c.field]: c.value };
    }
  }

  const exprs = params.conditions.map(condToExpr);

  // 单条件直接平铺
  if (exprs.length === 1) {
    Object.assign(body, exprs[0]);
    return body;
  }

  // 多条件 AND 时平铺（API 默认键值对为 AND）
  if (params.logic === 'and') {
    const allSimpleEq = params.conditions.every(c => c.operator === 'eq');
    if (allSimpleEq) {
      // 纯等值条件直接平铺
      for (const c of params.conditions) {
        body[c.field] = c.value;
      }
      return body;
    }
  }

  // 用 or/and 包裹多条件
  body[params.logic] = exprs;
  return body;
}

/** 解析 API 响应数据 */
function parseApiResponse(raw: any): {
  responseData: any;
  dataStruct: Record<string, string> | undefined;
  page: number;
  perPage: number;
  total: number;
  records: any[];
} {
  const responseData = raw.result ?? raw.data?.result ?? raw.data ?? raw;
  const dataStruct: Record<string, string> | undefined = responseData.data_struct;
  const page = responseData.page ?? 1;
  const perPage = responseData.per ?? responseData.per_page ?? 20;
  const total = responseData.total ?? responseData.totalCount ?? responseData.count ?? 0;

  let records: any[] = [];
  if (Array.isArray(responseData.data)) {
    records = responseData.data;
  } else if (Array.isArray(responseData.records)) {
    records = responseData.records;
  } else if (Array.isArray(responseData.list)) {
    records = responseData.list;
  } else if (Array.isArray(responseData.rows)) {
    records = responseData.rows;
  } else if (Array.isArray(responseData.result)) {
    records = responseData.result;
  } else if (Array.isArray(responseData)) {
    records = responseData;
  }

  return { responseData, dataStruct, page, perPage, total, records };
}

export async function fetchDataFromApi(
  queryParams?: QueryParams,
  apiUrlOverride?: string,
  tokenConfigId?: number
): Promise<{
  success: boolean;
  data?: {
    records: any[];
    total: number;
    page: number;
    perPage: number;
    dataStruct?: Record<string, string>;
    rawResponse?: any;
  };
  message: string;
  meta?: { duration: number; recordCount: number; tokenRefreshed?: boolean };
}> {
  const config = await getConfig();
  if (!config) {
    return { success: false, message: '未找到配置信息' };
  }

  // 支持传入自定义 API URL（远程表场景），否则使用全局配置
  const rawUrl = apiUrlOverride || config.data_api_url;
  if (!rawUrl) {
    return { success: false, message: '请先配置数据 API URL' };
  }

  try {
    // 动态获取 token（按所属 token 配置，不从 URL 中取静态 token）
    const token = await getValidTokenFor(tokenConfigId);
    // 清理 URL 中可能残留的 access_token 参数
    const cleanUrl = stripTokenFromUrl(rawUrl);

    const needsPost = !!(queryParams && (
      queryParams.conditions.length > 0 ||
      queryParams.orderField ||
      queryParams.page > 1 ||
      queryParams.perPage !== 20
      ));

    const { response, duration, tokenRefreshed } = await requestWithTokenRetry(
      cleanUrl, token, queryParams, needsPost, true, tokenConfigId
    );

    const raw = response.data;

    // 业务错误码检测:接口返回明确失败码时直接报错(如 20013 查询结果为空 / 99999 参数异常),
    // message 与 description 一并拼入,避免丢失关键诊断信息
    const bizCode = raw && typeof raw === 'object' ? Number(raw.code) : undefined;
    if (bizCode !== undefined && ![10000, 0, 200].includes(bizCode)) {
      const reason = [raw.message, raw.description].filter(Boolean).join(' | ') || '未知业务错误';
      return { success: false, message: `接口返回 ${bizCode}: ${reason}` };
    }

    const { dataStruct, page, perPage, total, records } = parseApiResponse(raw);

    // 去除元数据字段
    const metaKeys = new Set(['page', 'per', 'total', 'max_page', 'data_struct', 'encrypted_field', 'water_mark']);

    const msg = tokenRefreshed ? 'Token 已自动刷新，数据获取成功' : '数据获取成功';

    return {
      success: true,
      data: {
        rawResponse: raw,
        records: records.map((r: any) => {
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            const cleaned: Record<string, unknown> = {};
            for (const k of Object.keys(r)) {
              if (!metaKeys.has(k)) cleaned[k] = r[k];
            }
            return cleaned;
          }
          return r;
        }),
        total,
        page,
        perPage,
        dataStruct,
      },
      message: msg,
      meta: { duration, recordCount: records.length, tokenRefreshed },
    };
  } catch (error: any) {
    const errMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    return { success: false, message: '请求失败: ' + errMsg };
  }
}

// 导出 getValidToken 供其他模块使用
export { getValidToken };

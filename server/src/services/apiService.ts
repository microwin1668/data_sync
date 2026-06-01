import axios from 'axios';
import { getConfig, updateAccessToken } from '../db/sqlite';

export async function fetchAccessToken(): Promise<{ success: boolean; token?: string; message: string }> {
  const config = await getConfig();
  if (!config) {
    return { success: false, message: '未找到配置信息' };
  }

  if (!config.token_url) {
    return { success: false, message: '请先配置 Token URL' };
  }

  try {
    const response = await axios.post(
      config.token_url,
      { key: config.key, secret: config.secret },
      { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
    );
    const data = response.data;

    let accessToken: string | undefined;

    if (data.access_token) {
      accessToken = data.access_token;
    } else if (data.data?.access_token) {
      accessToken = data.data.access_token;
    } else if (data.result?.access_token) {
      accessToken = data.result.access_token;
    } else if (data.data?.result?.access_token) {
      accessToken = data.data.result.access_token;
    }

    const isBizSuccess = data.code === undefined || data.code === 10000 || data.code === 0 || data.code === 200;

    if (accessToken && isBizSuccess) {
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

/** 获取有效 token：优先从 config 取，如果不存在则实时获取 */
async function getValidToken(): Promise<string> {
  const config = await getConfig();
  // 如果已有有效的 access_token，直接返回
  if (config?.access_token) {
    return config.access_token;
  }
  // 否则实时获取
  const result = await fetchAccessToken();
  if (result.success && result.token) {
    await updateAccessToken(result.token);
    return result.token;
  }
  throw new Error('无法获取 access_token: ' + result.message);
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
  retryOnTokenError = true
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
      // 重新获取 token 并重试
      const newTokenResult = await fetchAccessToken();
      if (newTokenResult.success && newTokenResult.token) {
        await updateAccessToken(newTokenResult.token);
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
        return { [c.field]: { gt: c.value } };
      case 'gte':
        return { [c.field]: { gte: c.value } };
      case 'lt':
        return { [c.field]: { lt: c.value } };
      case 'lte':
        return { [c.field]: { lte: c.value } };
      case 'between': {
        const parts = c.value.split(',').map(s => s.trim());
        if (parts.length >= 2) {
          return { [c.field]: { gte: parts[0], lte: parts[1] } };
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
  apiUrlOverride?: string
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
    // 动态获取 token（不从 URL 中取静态 token）
    const token = await getValidToken();
    // 清理 URL 中可能残留的 access_token 参数
    const cleanUrl = stripTokenFromUrl(rawUrl);

    const needsPost = !!(queryParams && (
      queryParams.conditions.length > 0 ||
      queryParams.orderField ||
      queryParams.page > 1 ||
      queryParams.perPage !== 20
      ));

    const { response, duration, tokenRefreshed } = await requestWithTokenRetry(
      cleanUrl, token, queryParams, needsPost
    );

    const raw = response.data;
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

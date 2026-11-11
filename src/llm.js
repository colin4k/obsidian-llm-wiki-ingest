'use strict';
/*
 * llm.js —— 统一的 LLM 调用层：
 *   - resolveEndpoint(): 把用户填的 Base URL 补全成完整接口地址
 *   - LLMClient: 同时支持 OpenAI 与 Anthropic 两种请求/响应格式
 *
 * 请求走 Obsidian 的 requestUrl（Electron 主进程发请求，不受渲染层 CORS 限制）。
 * requestUrl 通过构造函数注入，便于离线测试。
 */

const { sleep } = require('./core.js');

class LLMError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = info.status || 0;
    this.retryable = Boolean(info.retryable);
    this.body = info.body || '';
  }
}

/**
 * 把用户填的 Base URL 补全成完整接口地址。
 * 兼容：https://api.openai.com、https://api.openai.com/v1、
 *      https://api.anthropic.com、https://api.minimaxi.com/anthropic、
 *      http://localhost:11434/v1、https://x.com/api/paas/v4
 */
function resolveEndpoint(baseUrl, format) {
  let b = String(baseUrl || '').trim().replace(/\s+/g, '');
  if (!b) throw new LLMError('未配置接口地址（Base URL）');
  b = b.replace(/\/+$/, '');

  const suffix = format === 'anthropic' ? '/messages' : '/chat/completions';
  if (b.endsWith(suffix)) return b;

  const lastSeg = b.split('/').pop() || '';
  if (/^v\d+[a-z0-9.]*$/i.test(lastSeg)) return b + suffix;

  return b + (format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
}

/** 解析“每行 key: value”形式的自定义请求头 */
function parseHeaderLines(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const i = s.indexOf(':');
    if (i <= 0) return;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

class LLMClient {
  /**
   * @param settings 插件设置（只读使用）
   * @param requestUrl Obsidian 的 requestUrl 函数
   */
  constructor(settings, requestUrl) {
    this.settings = settings;
    this.requestUrl = requestUrl;
    this.calls = 0;
  }

  get format() { return this.settings.apiFormat === 'anthropic' ? 'anthropic' : 'openai'; }

  get endpoint() {
    return resolveEndpoint(this.settings.baseUrl, this.format);
  }

  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const key = String(this.settings.apiKey || '').trim();

    if (this.format === 'openai') {
      if (key) headers['Authorization'] = `Bearer ${key}`;
    } else {
      const mode = this.settings.authMode || 'auto';
      let useX = mode === 'x-api-key' || mode === 'both';
      let useAuth = mode === 'bearer' || mode === 'both';
      if (mode === 'auto') {
        const isOfficial = /(^|\.)anthropic\.com/i.test(this.settings.baseUrl || '');
        useX = isOfficial;
        useAuth = !isOfficial;
      }
      if (key && useX) headers['x-api-key'] = key;
      if (key && useAuth) headers['Authorization'] = `Bearer ${key}`;
      headers['anthropic-version'] = String(this.settings.apiVersion || '2023-06-01');
      // 兼容部分第三方网关：允许浏览器直接调用
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    Object.assign(headers, parseHeaderLines(this.settings.extraHeaders));
    return headers;
  }

  buildBody(system, user, maxTokens) {
    const s = this.settings;
    const model = String(s.model || '').trim();
    if (!model) throw new LLMError('未配置模型（model）');
    const limited = Math.max(256, Number(maxTokens || s.maxOutputTokens || 4096));

    if (this.format === 'openai') {
      const body = {
        model,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') },
        ],
        max_tokens: limited,
        stream: false,
      };
      if (s.sendTemperature !== false) body.temperature = Number(s.temperature ?? 0.3);
      return body;
    }

    const body = {
      model,
      max_tokens: limited,
      system: String(system || ''),
      messages: [{ role: 'user', content: String(user || '') }],
    };
    if (s.sendTemperature !== false) body.temperature = Number(s.temperature ?? 0.3);
    return body;
  }

  /** 从响应体里取纯文本 */
  extractText(data) {
    if (!data || typeof data !== 'object') return '';
    if (this.format === 'openai') {
      const choice = (data.choices && data.choices[0]) || null;
      if (choice) {
        if (choice.message) {
          const c = normalizeContent(choice.message.content);
          if (c) return c;
          if (typeof choice.message.reasoning_content === 'string' &&
            !choice.message.content) {
            // 推理模型偶尔只回 reasoning_content，不作正文使用
            return '';
          }
        }
        if (typeof choice.text === 'string' && choice.text) return choice.text;
      }
      if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
      // Anthropic 风格响应混入 OpenAI 端点时的兜底
      if (Array.isArray(data.content)) return normalizeContent(data.content);
      return '';
    }

    if (Array.isArray(data.content)) {
      const text = data.content
        .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
        .map((part) => part.text || '')
        .join('');
      if (text) return text;
    }
    if (typeof data.completion === 'string') return data.completion;
    if (typeof data.output_text === 'string') return data.output_text;
    // OpenAI 风格响应混入 Anthropic 端点时的兜底
    if (data.choices && data.choices[0]) return normalizeContent(data.choices[0].message?.content);
    return '';
  }

  /**
   * 单轮对话。返回 { text, usage }
   * @param {{system?:string,user:string,maxTokens?:number,label?:string}} args
   */
  async chat(args) {
    const url = this.endpoint;
    const headers = this.buildHeaders();
    const body = this.buildBody(args.system, args.user, args.maxTokens);
    const timeoutMs = Math.max(10, Number(this.settings.timeoutSec || 180)) * 1000;

    let lastErr = null;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const data = await this._send(url, headers, body, timeoutMs);
        const text = this.extractText(data);
        if (!text || !text.trim()) {
          throw new LLMError('LLM 返回空内容（模型可能拒绝或输出被截断）', {
            retryable: false, body: JSON.stringify(data).slice(0, 800),
          });
        }
        this.calls += 1;
        return { text, usage: data.usage || null };
      } catch (err) {
        lastErr = err;
        if (!err.retryable || attempt === maxRetries) throw err;
        await sleep(1500 * Math.pow(2, attempt));
      }
    }
    throw lastErr || new LLMError('LLM 调用失败');
  }

  async _send(url, headers, body, timeoutMs) {
    const payload = {
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false,
    };

    let timer = null;
    let resp;
    try {
      resp = await Promise.race([
        this.requestUrl(payload),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new LLMError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, { retryable: true }));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof LLMError) throw err;
      throw new LLMError('网络请求失败：' + (err && err.message ? err.message : String(err)),
        { retryable: true });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = resp && typeof resp.status === 'number' ? resp.status : 0;
    if (status >= 200 && status < 300) {
      if (resp.json) return resp.json;
      try { return JSON.parse(resp.text || ''); } catch (_) {
        throw new LLMError('接口返回了非 JSON 内容：' + String(resp.text || '').slice(0, 300),
          { status });
      }
    }

    const errText = (resp && (resp.text ||
      (resp.json ? JSON.stringify(resp.json) : ''))) || '';
    const retryable = status === 429 || status >= 500 || status === 408 || status === 0;
    let hint = '';
    if (status === 401 || status === 403) hint = '（鉴权失败：检查 API Key）';
    else if (status === 404) hint = '（接口不存在：检查 Base URL 是否需要带 /v1 等版本段）';
    else if (status === 429) hint = '（限流或额度不足）';
    else if (status === 0) hint = '（无响应状态码）';

    throw new LLMError(`接口返回 ${status}${hint}：${String(errText).slice(0, 500)}`,
      { status, retryable, body: errText });
  }
}

module.exports = {
  LLMError,
  LLMClient,
  resolveEndpoint,
  parseHeaderLines,
  normalizeContent,
};

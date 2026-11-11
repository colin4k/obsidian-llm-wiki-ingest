'use strict';
/*
 * core.js —— 与 Obsidian UI 解耦的底层：
 *   常量（主题体系）、纯函数工具、Vault 文件读写适配、路径解析、台账存储。
 *
 * 只依赖 Node 内置模块；Obsidian 的 DataAdapter 由外部注入，便于离线测试。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 主题体系（与 Wiki/_scripts/pipeline.py 的 TOPICS 保持同步）
// 顺序即优先级：先匹配到的优先，用于规则初判（LLM 可覆盖）
// ---------------------------------------------------------------------------
const TOPICS = [
  ['稳定币与RWA', ['稳定币', 'RWA', 'USDT', 'USDC', '代币化', 'xStocks', 'BUIDL', 'Pendle',
    '收益代币', '港元稳定币', '稳定币条例', '资产上链', '代币基金']],
  ['支付与金融', ['支付', '跨境', '清算', '结算', '银行', '风控', '信用卡', '收单', '通道',
    '账基', '资金流', '手续费', '合规', '牌照', 'MSB', 'KYT', 'KYC', 'AML',
    '金融科技', '利息', '保险', '券商', 'IPO', '营收']],
  ['量化交易', ['量化', '套利', '策略', '网格', '因子', '回测', '订单流', 'orderbook',
    '做市', '高频', '限价订单', 'TradingView', 'Qlib', '期货', '永续']],
  ['加密货币投资', ['比特币', '以太坊', '币圈', '出金', '交易所', '山寨币', '合约交易',
    '钱包', '空投', 'MEME', 'Solana', '挖矿', '质押', 'DeFi']],
  ['区块链与Web3', ['区块链', 'Web3', '智能合约', 'Solidity', 'EVM', 'Layer2', 'Rollup',
    'Rust 重写', '链上', '共识', 'ERC', 'NFT', 'MPC', 'TSS', '审计']],
  ['AI-Agent', ['Agent', '智能体', 'MCP', '工作流', '多智能体', 'LangGraph', 'RAG',
    '编排', 'AutoGen', 'ADK', 'Skill', '上下文工程', 'Context']],
  ['大模型与提示词', ['提示词', 'Prompt', '大模型', 'LLM', '微调', 'Token', '推理',
    'Gemini', 'GPT', 'Claude', 'DeepSeek', 'Qwen', 'embedding', '向量']],
  ['AI工具与开源', ['开源', 'Star', '神器', '工具', '插件', '部署', '本地', '免费',
    'ComfyUI', 'TTS', '语音', '视频生成', '图片', 'OCR', '浏览器']],
  ['软件测试', ['测试', 'QA', '自动化测试', '用例', 'Playwright', '缺陷', '漏测', 'TestHub']],
  ['技术开发', ['代码', '架构', '设计模式', '前端', '后端', '数据库', 'Python', 'Java',
    'API', '部署', '运维', 'Linux', '脚本', '性能', '网关', 'GitLab', 'Git']],
  ['内容创作与运营', ['公众号', '小红书', '写文', '爆款', '涨粉', '自媒体', '流量',
    '选题', '短视频', '抖音', '文案', '变现', '副业', '知乎', '运营']],
  ['SEO与出海', ['SEO', '收录', '独立站', '出海', '谷歌', 'Google', '关键词', '外链',
    '联盟', '建站', '网站']],
  ['知识管理', ['Obsidian', '笔记', '知识库', '知识管理', '双链', 'NotebookLM', '剪藏',
    '收藏', '整理', 'Wiki', '卡片']],
  ['历史与人文', ['历史', '地理', '三国', '突厥', '帝国', '文明', '哲学', '文学', '小说']],
  ['个人成长', ['成长', '思考', '认知', '学习', '习惯', '复盘', '人生', '职业规划', '效率']],
];

const DEFAULT_TOPIC = '其他';
const TOPIC_NAMES = TOPICS.map((t) => t[0]).concat([DEFAULT_TOPIC]);

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/** 统一 vault 内路径：去反斜杠、折叠多余斜杠、去首尾斜杠与 "./"。 */
function normalizeVaultPath(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').trim();
  s = s.replace(/\/{2,}/g, '/');
  s = s.replace(/^\.\//, '');
  while (s.startsWith('/')) s = s.slice(1);
  while (s.endsWith('/') && s.length > 1) s = s.slice(0, -1);
  return s;
}

function joinVaultPath(...parts) {
  return normalizeVaultPath(parts.filter((x) => x != null && x !== '').join('/'));
}

function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 清洗文件名：去零宽字符、去换行、替换 macOS/Obsidian 非法字符、限长 120。
 * 注意：不压缩连续空格 —— frontmatter 里的 raw/source 记录的是原始文件名，
 * 压缩空格会让双链断掉（这是 pipeline.py 踩过的坑）。
 */
function cleanName(name) {
  let s = String(name == null ? '' : name).normalize('NFC')
    .replace(/[\u200b\u200c\u200d\ufeff\u2060]/g, '');
  s = s.replace(/[\r\n\t]/g, ' ');
  s = s.replace(/[\\/:*?"<>|]/g, '-');
  s = s.replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(0, 120);
  return s || 'untitled';
}

/** 从文件名推导标题（去扩展名与前后空白）。 */
function normTitle(name) {
  const base = path.parse(String(name)).name;
  return cleanName(base).trim();
}

/** 规则初判主题：标题命中关键词即归入该主题。 */
function guessTopic(text) {
  const hay = String(text || '').toLowerCase();
  for (const [topic, kws] of TOPICS) {
    for (const kw of kws) {
      if (hay.includes(kw.toLowerCase())) return topic;
    }
  }
  return DEFAULT_TOPIC;
}

function md5Of(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

/**
 * 按「前 80% + 后 20%」截断超长文本，和 AGENTS.md 对超大文件的骨架式摘要策略一致。
 * 返回 { text, truncated, originalLength }
 */
function truncateText(text, maxChars) {
  const s = String(text || '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || s.length <= maxChars) {
    return { text: s, truncated: false, originalLength: s.length };
  }
  const head = Math.floor(maxChars * 0.8);
  const tail = Math.max(0, maxChars - head);
  const omitted = s.length - maxChars;
  const middle = `\n\n<!-- 原文共 ${s.length} 字，此处省略中间约 ${omitted} 字 -->\n\n`;
  return {
    text: s.slice(0, head) + middle + (tail > 0 ? s.slice(s.length - tail) : ''),
    truncated: true,
    originalLength: s.length,
  };
}

/** 拆分 frontmatter：返回 { fm, body }（fm 不含分隔线）。 */
function splitFrontmatter(text) {
  const s = String(text || '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: '', body: s };
  return { fm: m[1], body: s.slice(m[0].length) };
}

/** 宽松 JSON 解析：容忍 ```json 围栏、前后说明文字、尾随逗号。 */
function parseJsonLoose(text) {
  if (!text || !String(text).trim()) throw new Error('LLM 返回空内容');
  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch (_) { /* 继续尝试 */ }

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('LLM 返回的内容不是 JSON：' + s.slice(0, 160));
  }
  let body = s.slice(start, end + 1);
  try { return JSON.parse(body); } catch (_) { /* 继续尝试 */ }

  body = body.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(body); } catch (_) { /* 放弃 */ }

  throw new Error('LLM 返回的 JSON 无法解析：' + body.slice(0, 200));
}

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/** 绝对路径判断（POSIX 或 Windows 盘符）。 */
function isAbsolutePath(p) {
  return typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p));
}

function toUnix(p) {
  return String(p).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// VaultFS —— 用 Obsidian DataAdapter 包装 vault 内的读写（也接受测试用的假实现）
// ---------------------------------------------------------------------------
class VaultFS {
  /**
   * @param adapter 具备 exists/read/write/mkdir/remove/rename 的 DataAdapter
   * @param basePath 本地绝对根目录（FileSystemAdapter.getBasePath()），可为空
   */
  constructor(adapter, basePath) {
    this.adapter = adapter;
    this.basePath = basePath || null;
  }

  abs(rel) {
    const r = normalizeVaultPath(rel);
    if (!this.basePath) return null;
    return path.join(this.basePath, r);
  }

  async exists(rel) {
    const p = normalizeVaultPath(rel);
    if (!p) return false;
    try { return await this.adapter.exists(p); } catch (_) { return false; }
  }

  async read(rel) {
    return await this.adapter.read(normalizeVaultPath(rel));
  }

  async ensureDir(relDir) {
    const parts = normalizeVaultPath(relDir).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (await this.exists(cur)) continue;
      try { await this.adapter.mkdir(cur); } catch (_) { /* 可能被并发创建 */ }
    }
  }

  async ensureParent(relFile) {
    const parent = normalizeVaultPath(relFile).split('/').slice(0, -1).join('/');
    if (parent) await this.ensureDir(parent);
  }

  async write(rel, text) {
    const p = normalizeVaultPath(rel);
    await this.ensureParent(p);
    await this.adapter.write(p, String(text));
  }

  async append(rel, text) {
    const p = normalizeVaultPath(rel);
    const prev = (await this.exists(p)) ? await this.read(p) : '';
    await this.write(p, prev + text);
  }

  async remove(rel) {
    const p = normalizeVaultPath(rel);
    if (!(await this.exists(p))) return;
    await this.adapter.remove(p);
  }

  /** 递归列出目录下的文件（跳过隐藏文件与临时文件）。返回 [{ rel, name, size }] */
  listFiles(relDir) {
    const root = normalizeVaultPath(relDir);
    const out = [];
    if (!this.basePath) {
      // 无本地路径时退化为 adapter 逐层列举（少见）
      const walk = (dir) => {
        const list = this.adapter.list ? this.adapter.list(dir) : null;
        if (!list || typeof list.then !== 'function') return;
      };
      return out;
    }
    const startAbs = path.join(this.basePath, root);
    if (!fs.existsSync(startAbs)) return out;
    const walk = (dirAbs) => {
      let entries;
      try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        const name = ent.name;
        if (name.startsWith('.')) continue;
        if (name.startsWith('~$') || name.endsWith('.tmp')) continue;
        const absPath = path.join(dirAbs, name);
        if (ent.isDirectory()) { walk(absPath); continue; }
        if (!ent.isFile()) continue;
        let size = 0;
        try { size = fs.statSync(absPath).size; } catch (_) { /* ignore */ }
        out.push({
          rel: toUnix(path.relative(this.basePath, absPath)),
          name,
          size,
        });
      }
    };
    walk(startAbs);
    out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
    return out;
  }

  listMarkdown(relDir) {
    return this.listFiles(relDir).filter((f) => /\.md$/i.test(f.name));
  }
}

// ---------------------------------------------------------------------------
// WikiPaths —— 设置里的路径 → 绝对路径 / vault 相对路径
// ---------------------------------------------------------------------------
class WikiPaths {
  constructor(settings, vfs) {
    this.s = settings;
    this.vfs = vfs;
  }

  get inboxDir() { return normalizeVaultPath(this.s.inboxFolder); }
  get wikiRoot() { return normalizeVaultPath(this.s.wikiRoot) || 'Wiki'; }
  get wikiDir() { return normalizeVaultPath(this.s.wikiFolder) || joinVaultPath(this.wikiRoot, 'Wiki'); }
  get conceptsDir() { return normalizeVaultPath(this.s.conceptsFolder) || joinVaultPath(this.wikiRoot, 'Concepts'); }
  get rawDir() { return normalizeVaultPath(this.s.rawFolder) || joinVaultPath(this.wikiRoot, 'raw'); }
  get stateDir() { return normalizeVaultPath(this.s.stateFolder) || joinVaultPath(this.wikiRoot, '_state'); }
  get indexPath() { return joinVaultPath(this.wikiRoot, '_index.md'); }
  get logPath() { return joinVaultPath(this.wikiRoot, '_log.md'); }
  get manifestPath() { return joinVaultPath(this.stateDir, 'manifest.json'); }

  /** 归档根目录的绝对路径（支持 vault 外置盘，也支持 vault 内相对路径）。 */
  archiveRootAbs() {
    const raw = String(this.s.archiveFolder || '').trim();
    if (!raw) return null;
    if (isAbsolutePath(raw)) return path.normalize(raw);
    const abs = this.vfs.abs(raw);
    return abs ? path.normalize(abs) : null;
  }

  /** vault 相对路径 → 绝对路径 */
  vaultAbs(rel) { return this.vfs.abs(rel); }

  /** 绝对路径 → vault 相对路径（不在 vault 内返回 null） */
  toVaultRel(abs) {
    if (!this.vfs.basePath || !abs) return null;
    const base = path.normalize(this.vfs.basePath);
    const target = path.normalize(abs);
    if (target === base) return '';
    if (!target.startsWith(base + path.sep)) return null;
    return toUnix(path.relative(base, target));
  }

  isInVault(abs) { return this.toVaultRel(abs) !== null; }

  /** vault 相对路径 → 相对 Wiki 根（manifest 里的 wiki/raw 字段用这个口径） */
  toWikiRel(vaultRel) {
    const root = this.wikiRoot;
    const p = normalizeVaultPath(vaultRel);
    if (p === root) return '';
    if (p.startsWith(root + '/')) return p.slice(root.length + 1);
    return p;
  }

  fromWikiRel(wikiRel) {
    const p = normalizeVaultPath(wikiRel);
    if (!p) return this.wikiRoot;
    if (p.startsWith(this.wikiRoot + '/')) return p;
    return joinVaultPath(this.wikiRoot, p);
  }

  /** 归档日期子目录（archiveByDate 关闭时直接用根目录） */
  archiveDateDir(dateStr) {
    const root = this.archiveRootAbs();
    if (!root) return null;
    return this.s.archiveByDate && dateStr ? path.join(root, dateStr) : root;
  }
}

// ---------------------------------------------------------------------------
// ManifestStore —— _state/manifest.json 台账（与 pipeline.py 结构兼容）
// ---------------------------------------------------------------------------
class ManifestStore {
  constructor(vfs, manifestPath) {
    this.vfs = vfs;
    this.manifestPath = manifestPath;
    this._chain = Promise.resolve();
    this.data = { done: {} };
  }

  async load() {
    if (await this.vfs.exists(this.manifestPath)) {
      try {
        const text = await this.vfs.read(this.manifestPath);
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && parsed.done && typeof parsed.done === 'object') {
          this.data = parsed;
          return this.data;
        }
      } catch (_) { /* 损坏则重建 */ }
    }
    this.data = { done: {} };
    return this.data;
  }

  has(hash) {
    return Object.values(this.data.done || {}).some((v) => v && v.hash === hash);
  }

  entryFor(src) { return (this.data.done || {})[src] || null; }

  /** 串行写入，避免并发处理时覆盖台账 */
  set(src, entry) {
    this.data.done = this.data.done || {};
    this.data.done[src] = entry;
    this._chain = this._chain.then(() => this._write());
    return this._chain;
  }

  async flush() {
    this._chain = this._chain.then(() => this._write());
    return this._chain;
  }

  async _write() {
    await this.vfs.write(this.manifestPath, JSON.stringify(this.data, null, 2));
  }
}

module.exports = {
  TOPICS,
  TOPIC_NAMES,
  DEFAULT_TOPIC,
  normalizeVaultPath,
  joinVaultPath,
  nowIso,
  todayStr,
  sleep,
  cleanName,
  normTitle,
  guessTopic,
  md5Of,
  truncateText,
  splitFrontmatter,
  parseJsonLoose,
  humanBytes,
  isAbsolutePath,
  toUnix,
  VaultFS,
  WikiPaths,
  ManifestStore,
};

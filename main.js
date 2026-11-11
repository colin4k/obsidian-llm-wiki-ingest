/* eslint-disable */
/* LLM Wiki Ingest —— 单文件构建产物（由 build.js 从 src/ 生成，勿直接修改） */
/* 构建时间：2026-11-11T08:13:43.430Z */

(function () {
  'use strict';
  var __defs = {};
  var __cache = {};

  function __define(id, fn) { __defs[id] = fn; }

  function __req(fromId, name) {
    if (name.charAt(0) !== '.') return require(name);
    var base = fromId.indexOf('/') === -1 ? '' : fromId.slice(0, fromId.lastIndexOf('/'));
    var id = normalize(base, name);
    return __load(id);
  }

  function normalize(base, name) {
    var joined = (base ? base + '/' : '') + name;
    var parts = joined.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    var id = out.join('/');
    if (id.slice(-3) !== '.js') id += '.js';
    return id;
  }

  function __load(id) {
    if (__cache[id]) return __cache[id].exports;
    if (!__defs[id]) throw new Error('模块未找到：' + id);
    var m = { exports: {} };
    __cache[id] = m;
    __defs[id](m, m.exports, function (name) { return __req(id, name); });
    return m.exports;
  }

  __define("core.js", function (module, exports, require) {
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

  });

  __define("engine.js", function (module, exports, require) {
'use strict';
/*
 * engine.js —— 摄入流水线本体（对应 Wiki/AGENTS.md 的 Ingest 五步）：
 *
 *   Step 1 扫描     listInboxFiles / discover
 *   Step 2 分诊     triage()：New / Update / Disputed / No material
 *   Step 3 编译     compile()：产出 Wiki 文章 + 概念页
 *   Step 4 级联     updateConceptPages()：概念页补充要点
 *   Step 5 记账     写 raw、移归档、更新 manifest、追加 _log、重建 _index
 *
 * 与 Wiki/_scripts/pipeline.py 的职责边界一致：脚本/插件管“搬东西和记账”，
 * LLM 管“读懂和写作”。这里没有 LLM 的自主文件操作，所有写盘都由本文件决定。
 */

const fs = require('fs');
const path = require('path');

const core = require('./core.js');
const prompts = require('./prompts.js');
const { LLMClient } = require('./llm.js');

const {
  TOPIC_NAMES,
  DEFAULT_TOPIC,
  normalizeVaultPath,
  joinVaultPath,
  nowIso,
  todayStr,
  cleanName,
  normTitle,
  guessTopic,
  md5Of,
  truncateText,
  splitFrontmatter,
  parseJsonLoose,
} = core;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function clipText(s, max) {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (v.length <= max) return v;
  return v.slice(0, max);
}

function parseFrontmatterSimple(fmText) {
  const out = {};
  if (!fmText) return out;
  for (const rawLine of String(fmText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('- ')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function firstParagraph(body) {
  for (const block of String(body || '').split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.startsWith('#') || b.startsWith('>') || b.startsWith('-') || b.startsWith('|')) continue;
    return clipText(b.replace(/[#*`[\]]/g, ''), 70);
  }
  return '';
}

function normalizeArticleBody(article) {
  let body = String(article == null ? '' : article).trim();
  // 去掉模型偶尔带上的 ``` 围栏
  const fence = body.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) body = fence[1].trim();
  // 去掉模型偶尔带上的 frontmatter
  const { body: stripped } = splitFrontmatter(body);
  if (stripped !== body && /^\s*(title|topic|status)\s*:/.test(splitFrontmatter(body).fm)) {
    body = stripped.trim();
  }
  return body;
}

function yamlString(v) {
  // JSON 字符串同时是合法 YAML 双引号标量，能安全容纳冒号、引号、中文
  return JSON.stringify(String(v == null ? '' : v));
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------
class IngestEngine {
  /**
   * @param {object} opts
   * @param {object} opts.settings
   * @param {core.VaultFS} opts.vfs
   * @param {core.WikiPaths} opts.paths
   * @param {core.ManifestStore} opts.manifest
   * @param {LLMClient} [opts.client]
   * @param {(rel:string)=>Promise<void>} [opts.removeVaultFile]
   * @param {(fromRel:string,toRel:string)=>Promise<void>} [opts.renameVaultFile]
   */
  constructor(opts) {
    this.settings = opts.settings;
    this.vfs = opts.vfs;
    this.paths = opts.paths;
    this.manifest = opts.manifest;
    this.client = opts.client || new LLMClient(this.settings, opts.requestUrl);
    this.removeVaultFile = opts.removeVaultFile || ((rel) => this.vfs.remove(rel));
    this.renameVaultFile = opts.renameVaultFile ||
      ((fromRel, toRel) => this.vfs.adapter.rename(fromRel, toRel));

    this.cancelled = false;
    this._context = null;
    // 并发命名占位：并发的两篇若算出同一个目标文件名，必须只有一个能落盘
    this._claimed = new Set();
    this._claimedRaw = new Set();
    this._conceptChain = Promise.resolve();
    this.batchId = 'ui-' + nowIso().replace(/[-:]/g, '').slice(0, 13);
    this.batchDate = todayStr();
    this.stats = { compiled: 0, updated: 0, skip: 0, already: 0, error: 0 };
    this.failures = [];
  }

  cancel() { this.cancelled = true; }

  // -------------------------------------------------------------------------
  // 目录 / 扫描
  // -------------------------------------------------------------------------
  async ensureDirs() {
    const list = [
      this.paths.wikiDir,
      this.paths.conceptsDir,
      this.paths.rawDir,
      this.paths.stateDir,
    ];
    for (const d of list) {
      if (d) await this.vfs.ensureDir(d);
    }
  }

  /** 收件箱内所有可处理的 Markdown（含子目录，跳过隐藏/临时文件） */
  listInboxFiles() {
    const dir = this.paths.inboxDir;
    if (!dir) return [];
    return this.vfs.listFiles(dir).filter((f) => /\.md$/i.test(f.name));
  }

  /** 扫描已有知识，作为分诊与编译的上下文 */
  async collectKnowledge() {
    const articles = [];
    const summaryByStem = new Map();
    for (const v of Object.values((this.manifest.data && this.manifest.data.done) || {})) {
      if (v && v.wiki) summaryByStem.set(path.parse(v.wiki).name, v.summary || '');
    }

    for (const f of this.vfs.listMarkdown(this.paths.wikiDir)) {
      let text = '';
      try { text = await this.vfs.read(f.rel); } catch (_) { continue; }
      const { fm, body } = splitFrontmatter(text.slice(0, 6000));
      const meta = parseFrontmatterSimple(fm);
      const stem = path.parse(f.name).name;
      const parent = path.posix.basename(path.posix.dirname(f.rel)) ||
        path.posix.basename(normalizeVaultPath(this.paths.wikiDir));
      articles.push({
        topic: meta.topic || parent,
        title: meta.title || stem,
        wikiRel: this.paths.toWikiRel(f.rel),
        summary: summaryByStem.get(stem) || firstParagraph(body),
      });
    }
    articles.sort((a, b) => a.wikiRel.localeCompare(b.wikiRel, 'zh'));

    const concepts = this.vfs.listMarkdown(this.paths.conceptsDir)
      .map((f) => path.parse(f.name).name)
      .sort((a, b) => a.localeCompare(b, 'zh'));

    this._context = { articles, concepts };
    return this._context;
  }

  // -------------------------------------------------------------------------
  // LLM 两次调用
  // -------------------------------------------------------------------------
  /** 把设置里的“补充指令”拼到系统提示词末尾 */
  systemPrompt(base) {
    const extra = String(this.settings.extraInstructions || '').trim();
    return extra ? `${base}\n\n【补充要求】\n${extra}` : base;
  }

  async triage(articleText, fileName, ctx) {
    const res = await this.client.chat({
      system: this.systemPrompt(prompts.TRIAGE_SYSTEM),
      user: prompts.buildTriageUser({
        articleText,
        fileName,
        topicNames: TOPIC_NAMES,
        articles: ctx.articles,
        concepts: ctx.concepts,
      }),
      maxTokens: 1200,
      label: '分诊',
    });
    const data = parseJsonLoose(res.text);
    return {
      status: String(data.status || 'ok').toLowerCase() === 'skip' ? 'skip' : 'ok',
      topic: String(data.topic || '').trim(),
      title: String(data.title || '').trim(),
      summary: clipText(data.summary || '', 40),
      concepts: Array.isArray(data.concepts) ? data.concepts.filter((x) => typeof x === 'string') : [],
      mergeTarget: String(data.merge_target || '').trim(),
      disputed: Boolean(data.disputed),
      reason: String(data.reason || '').trim(),
    };
  }

  async compile(articleText, opts) {
    const res = await this.client.chat({
      system: this.systemPrompt(prompts.COMPILE_SYSTEM),
      user: prompts.buildCompileUser(opts),
      maxTokens: Math.max(2048, Number(this.settings.maxOutputTokens || 8192)),
      label: '编译',
    });
    const data = parseJsonLoose(res.text);
    const body = normalizeArticleBody(data.article);
    return {
      body,
      concepts: Array.isArray(data.concepts) ? data.concepts.filter((x) => typeof x === 'string') : [],
      conceptPages: Array.isArray(data.concept_pages) ? data.concept_pages : [],
    };
  }

  /**
   * 并发前置判重：按内容 md5 与本批内重复项直接判 already。
   * 空文件不参与判重（否则多份空文件会被当成“重复”而不归档）。
   * @returns {{skip: Map<string,string>, errors: Map<string,string>}}
   */
  async prescan(list) {
    const skip = new Map();
    const errors = new Map();
    if (!this.settings.skipDuplicates) return { skip, errors };
    const seen = new Set();
    for (const rel of list) {
      if (!(await this.vfs.exists(rel))) {
        errors.set(rel, '文件不存在（可能已被移动或删除）');
        continue;
      }
      let text;
      try { text = await this.vfs.read(rel); } catch (err) {
        errors.set(rel, err && err.message ? err.message : String(err));
        continue;
      }
      if (!String(text).trim()) continue; // 空文件交给 processOne 走归档分支
      const hash = md5Of(text);
      if (this.manifest.has(hash)) {
        skip.set(rel, '内容与台账中已处理文章相同（md5 相同）');
        continue;
      }
      if (seen.has(hash)) {
        skip.set(rel, '与本批其他文件内容相同（md5 相同）');
        continue;
      }
      seen.add(hash);
    }
    return { skip, errors };
  }

  // -------------------------------------------------------------------------
  // 批量
  // -------------------------------------------------------------------------
  /**
   * @param {string[]} relPaths vault 相对路径数组
   * @param {{onStart?:(rel,i)=>void,onDone?:(res,i)=>void,onLog?:(line)=>void}} hooks
   */
  async processAll(relPaths, hooks = {}) {
    const s = this.settings;
    const list = Array.from(new Set(relPaths || [])).filter(Boolean);
    const total = list.length;
    if (!total) return [];

    this.cancelled = false;
    this.batchDate = todayStr();
    this._claimed = new Set();
    this._claimedRaw = new Set();
    this._conceptChain = Promise.resolve();
    this.stats = { compiled: 0, updated: 0, skip: 0, already: 0, error: 0 };
    this.failures = [];

    await this.ensureDirs();
    await this.manifest.load();
    await this.collectKnowledge();

    // 判重必须在并发之前做完：否则同一批里内容相同的两份会被同时编译
    const prescan = await this.prescan(list);

    const concurrency = Math.max(1, Math.min(8, Number(s.maxConcurrency) || 3));
    const results = new Array(total);
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        if (this.cancelled) return;
        const i = cursor;
        cursor += 1;
        if (i >= total) return;
        const rel = list[i];
        if (hooks.onStart) hooks.onStart(rel, i);

        let res;
        try {
          if (prescan.skip.has(rel)) {
            res = { src: rel, ok: true, status: 'already', message: prescan.skip.get(rel) };
          } else if (prescan.errors.has(rel)) {
            res = { src: rel, ok: false, status: 'error', error: prescan.errors.get(rel) };
            this.stats.error += 1;
            this.failures.push({ src: rel, error: res.error });
          } else {
            res = await this.processOne(rel, { dateStr: this.batchDate });
          }
        } catch (err) {
          res = {
            src: rel,
            ok: false,
            status: 'error',
            error: err && err.message ? err.message : String(err),
          };
          this.stats.error += 1;
          this.failures.push({ src: rel, error: res.error });
        }

        if (res && res.status === 'compiled') this.stats.compiled += 1;
        else if (res.status === 'updated') this.stats.updated += 1;
        else if (res.status === 'skip') this.stats.skip += 1;
        else if (res.status === 'already') this.stats.already += 1;

        results[i] = res;
        if (hooks.onDone) hooks.onDone(res, i);
      }
    };

    const workers = [];
    for (let k = 0; k < Math.min(concurrency, total); k++) workers.push(worker());
    await Promise.all(workers);

    try {
      await this.manifest.flush();
      if (s.rebuildIndex) await this.rebuildIndex();
    } catch (err) {
      this.failures.push({ src: '(索引)', error: err.message });
    }

    return results.filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // 单篇
  // -------------------------------------------------------------------------
  async processOne(rel, { dateStr } = {}) {
    const s = this.settings;
    const started = Date.now();
    const fileName = path.posix.basename(rel);
    const day = dateStr || this.batchDate || todayStr();

    if (this.cancelled) return { src: rel, ok: false, status: 'cancelled' };

    if (!(await this.vfs.exists(rel))) {
      return { src: rel, ok: false, status: 'error', error: '文件不存在（可能已被移动或删除）' };
    }

    const rawText = await this.vfs.read(rel);
    const hash = md5Of(rawText);
    const size = Buffer.byteLength(rawText, 'utf8');

    // 空文件：只归档
    if (!rawText.trim()) {
      const archived = await this.archiveSource(rel, { dateStr: day });
      await this.recordSkip(rel, {
        hash, reason: '空文件，无内容', archived, dateStr: day, summary: '空文件',
      });
      return { src: rel, ok: true, status: 'skip', message: '空文件：仅归档', ms: Date.now() - started };
    }

    // 台账判重
    const prev = this.manifest.entryFor(rel);
    if (prev && prev.hash === hash) {
      return {
        src: rel, ok: true, status: 'already',
        message: '台账里已记录过同样内容，未重复编译',
        ms: Date.now() - started,
      };
    }
    if (s.skipDuplicates && this.manifest.has(hash)) {
      return {
        src: rel, ok: true, status: 'already',
        message: '内容 md5 与已处理文章相同（改名重投），已跳过',
        ms: Date.now() - started,
      };
    }

    // ---- Step 2 分诊 ----
    const ctx = this._context || await this.collectKnowledge();
    const triage = await this.triage(rawText, fileName, ctx);

    const topic = TOPIC_NAMES.includes(triage.topic)
      ? triage.topic
      : guessTopic(`${fileName} ${rawText.slice(0, 3000)}`);

    if (triage.status === 'skip') {
      const archived = await this.archiveSource(rel, { dateStr: day });
      await this.recordSkip(rel, {
        hash, reason: triage.reason || '无实质内容', archived, dateStr: day,
        summary: triage.summary || '无实质内容，仅归档',
      });
      return {
        src: rel, ok: true, status: 'skip', topic,
        message: triage.reason || '无实质内容：仅归档',
        ms: Date.now() - started,
      };
    }

    // ---- 合并目标 ----
    let mergeRel = null;
    let mergeBody = '';
    let mergeTitle = '';
    if (triage.mergeTarget) {
      const resolved = await this.resolveWikiRel(triage.mergeTarget);
      if (resolved) {
        mergeRel = resolved;
        const text = await this.vfs.read(resolved);
        mergeBody = splitFrontmatter(text).body;
        mergeTitle = parseFrontmatterSimple(splitFrontmatter(text).fm).title ||
          path.parse(resolved).name;
      }
    }

    // ---- Step 3 编译 ----
    const truncated = truncateText(rawText, Number(s.maxArticleChars) || 60000);
    const compiled = await this.compile(truncated.text, {
      articleText: truncated.text,
      fileName,
      topic,
      title: triage.title || normTitle(fileName),
      summary: triage.summary,
      mergeBody,
      mergeTitle,
      articleTruncated: truncated.truncated,
    });

    if (!compiled.body || compiled.body.length < 120) {
      throw new Error(`编译结果过短（${compiled.body ? compiled.body.length : 0} 字），已中止，原文未移动`);
    }

    const title = cleanName(triage.title || normTitle(fileName)).slice(0, 80) || normTitle(fileName);
    const summary = triage.summary || firstParagraph(compiled.body);
    const concepts = (compiled.concepts.length ? compiled.concepts : triage.concepts)
      .map((c) => String(c).trim()).filter(Boolean);

    // ---- 原文存档 raw/ ----
    const rawRel = await this.writeRaw(rawText, topic, rel);

    // ---- 目标 Wiki 路径 ----
    const wikiRel = mergeRel || await this.uniqueWikiPath(topic, title);

    // ---- 写 Wiki 文章（先写，后移动，避免移动后写入失败丢内容） ----
    const meta = {
      title,
      topic,
      rawRel,
      status: mergeRel ? (triage.disputed ? 'disputed' : 'updated') : 'ok',
      concepts,
      dateStr: day,
      sourceAbs: this.paths.vaultAbs(rel),
      generated: await this.existingGenerated(wikiRel) || day,
    };
    await this.writeWikiPage(wikiRel, meta, compiled.body);

    // ---- 归档移动 ----
    let archivedAbs = null;
    if (this.shouldMoveSource(rel)) {
      archivedAbs = await this.archiveSource(rel, { dateStr: day });
      if (archivedAbs) await this.rewriteSourceField(wikiRel, archivedAbs);
    }

    // ---- Step 4 概念页 ----
    if (s.updateConcepts && compiled.conceptPages.length) {
      await this.updateConceptPages(compiled.conceptPages, day);
    }

    // ---- Step 5 记账 ----
    await this.manifest.set(rel, {
      hash,
      title,
      topic,
      wiki: this.paths.toWikiRel(wikiRel),
      concepts,
      summary,
      archived_to: archivedAbs || '',
      raw: this.paths.toWikiRel(rawRel),
      processed_at: nowIso(),
      batch: this.batchId,
      size,
    });

    // 让同批次后续文章也能看到这篇新产出
    if (this._context) {
      this._context.articles.push({
        topic, title, wikiRel: this.paths.toWikiRel(wikiRel), summary,
      });
    }

    await this.appendLog(
      `- ${nowIso().slice(0, 16).replace('T', ' ')} **ingest**: [[${title}]] ` +
      `→ ${this.paths.toWikiRel(wikiRel)} · 原文 \`${archivedAbs || rel}\`\n`,
    );

    return {
      src: rel,
      ok: true,
      status: mergeRel ? 'updated' : 'compiled',
      topic,
      title,
      wikiRel,
      archivedTo: archivedAbs,
      message: summary,
      ms: Date.now() - started,
    };
  }

  // -------------------------------------------------------------------------
  // 文件写入
  // -------------------------------------------------------------------------
  async writeRaw(rawText, topic, srcRel) {
    const topicDir = cleanName(topic) || DEFAULT_TOPIC;
    const baseName = cleanName(path.posix.basename(srcRel));
    const stem = path.parse(baseName).name;
    for (let n = 0; n < 200; n += 1) {
      const candidate = joinVaultPath(this.paths.rawDir, topicDir, n === 0 ? baseName : `${stem}-${n}.md`);
      if (this._claimedRaw.has(candidate)) continue;
      this._claimedRaw.add(candidate);
      // eslint-disable-next-line no-await-in-loop
      const taken = await this.vfs.exists(candidate);
      if (!taken) {
        await this.vfs.write(candidate, rawText);
        return candidate;
      }
      this._claimedRaw.delete(candidate);
    }
    throw new Error('无法为原文分配存档文件名（同名文件过多）');
  }

  async uniqueWikiPath(topic, title) {
    const dir = joinVaultPath(this.paths.wikiDir, cleanName(topic) || DEFAULT_TOPIC);
    for (let n = 0; n < 100; n += 1) {
      const candidate = joinVaultPath(dir, n === 0 ? `${title}.md` : `${title}-${n}.md`);
      if (this._claimed.has(candidate)) continue; // 本批次已被别的任务占用
      this._claimed.add(candidate);               // 同步占位，消灭检查与写入之间的竞态
      // eslint-disable-next-line no-await-in-loop
      const taken = await this.vfs.exists(candidate);
      if (!taken) return candidate;
      this._claimed.delete(candidate);            // 历史文件占用，换下一个
    }
    const fallback = joinVaultPath(dir, `${title}-${Date.now()}.md`);
    this._claimed.add(fallback);
    return fallback;
  }

  async existingGenerated(wikiRel) {
    if (!(await this.vfs.exists(wikiRel))) return null;
    try {
      const text = await this.vfs.read(wikiRel);
      const meta = parseFrontmatterSimple(splitFrontmatter(text).fm);
      return meta.generated || null;
    } catch (_) {
      return null;
    }
  }

  buildFrontmatter(meta, { sourceValue }) {
    const lines = ['---'];
    lines.push(`title: ${yamlString(meta.title)}`);
    lines.push(`topic: ${yamlString(meta.topic)}`);
    lines.push(`source: ${sourceValue.startsWith('[[') ? sourceValue : yamlString(sourceValue)}`);
    lines.push(`raw: ${yamlString(`[[${meta.rawRel}]]`)}`);
    lines.push(`generated: ${meta.generated || meta.dateStr}`);
    if (meta.status === 'updated' || meta.status === 'disputed') {
      lines.push(`updated: ${meta.dateStr}`);
    }
    lines.push(`status: ${meta.status}`);
    lines.push(`concepts: ${JSON.stringify(meta.concepts || [])}`);
    lines.push('---', '');
    return lines.join('\n');
  }

  async writeWikiPage(wikiRel, meta, body) {
    const absSrc = meta.sourceAbs || '';
    const sourceValue = absSrc || '';
    const fm = this.buildFrontmatter(meta, { sourceValue });
    await this.vfs.write(wikiRel, fm + String(body || '').trim() + '\n');
  }

  async rewriteSourceField(wikiRel, absPath) {
    try {
      const text = await this.vfs.read(wikiRel);
      const next = text.replace(/^source:.*$/m, `source: ${yamlString(absPath)}`);
      if (next !== text) await this.vfs.write(wikiRel, next);
    } catch (_) { /* 回填失败不影响主流程 */ }
  }

  // -------------------------------------------------------------------------
  // 归档
  // -------------------------------------------------------------------------
  shouldMoveSource(rel) {
    const inbox = this.paths.inboxDir;
    const inInbox = inbox && (rel === inbox || rel.startsWith(inbox + '/'));
    if (inInbox) return this.settings.moveInboxSource !== false;
    return Boolean(this.settings.moveOutsideInboxSource);
  }

  /** 归档目标（不移动）：返回 { destDir, destAbs } */
  archivePlan(rel) {
    const rootAbs = this.paths.archiveRootAbs();
    if (!rootAbs) throw new Error('未配置归档路径（设置 → 路径 → 归档目录）');
    const destDir = this.settings.archiveByDate
      ? path.join(rootAbs, this.batchDate || todayStr())
      : rootAbs;
    const absSrc = this.paths.vaultAbs(rel);
    if (!absSrc) throw new Error('无法解析 vault 本地路径，归档功能需要桌面端文件系统');
    const baseName = path.basename(absSrc);
    const stem = path.parse(baseName).name;
    const ext = path.parse(baseName).ext;
    let destAbs = path.join(destDir, baseName);
    let n = 1;
    while (fs.existsSync(destAbs)) {
      destAbs = path.join(destDir, `${stem}-${n}${ext}`);
      n += 1;
      if (n > 500) break;
    }
    return { destDir, destAbs, absSrc };
  }

  async archiveSource(rel, { dateStr } = {}) {
    if (dateStr) this.batchDate = dateStr;
    const { destDir, destAbs, absSrc } = this.archivePlan(rel);

    // 外置卷未挂载时拒绝执行，避免把数据写到错误位置（与 pipeline.py 行为一致）
    if (destDir.startsWith('/Volumes/')) {
      const volume = destDir.split('/').slice(0, 3).join('/');
      if (!fs.existsSync(volume)) {
        throw new Error(`外置磁盘未挂载：${volume} 不存在，已中止归档`);
      }
    }

    fs.mkdirSync(destDir, { recursive: true });

    const destInVault = this.paths.isInVault(destAbs);
    if (destInVault) {
      const destRel = this.paths.toVaultRel(destAbs);
      await this.vfs.ensureParent(destRel);
      try {
        await this.renameVaultFile(rel, destRel);
      } catch (_) {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(absSrc, destAbs);
        await this.removeSourceFile(rel, absSrc);
      }
      if (fs.existsSync(destAbs)) return destAbs;
      throw new Error('归档移动失败：目标文件不存在');
    }

    // vault 外：复制 → 校验大小 → 删除源
    fs.copyFileSync(absSrc, destAbs);
    const srcSize = fs.statSync(absSrc).size;
    const dstSize = fs.statSync(destAbs).size;
    if (srcSize !== dstSize) {
      try { fs.unlinkSync(destAbs); } catch (_) { /* ignore */ }
      throw new Error('归档复制校验失败（源与目标大小不一致），已中止并保留原文');
    }
    await this.removeSourceFile(rel, absSrc);
    return destAbs;
  }

  async removeSourceFile(rel, absSrc) {
    try {
      await this.removeVaultFile(rel);
    } catch (_) { /* 交给下面的兜底 */ }
    if (absSrc && fs.existsSync(absSrc)) {
      try { fs.unlinkSync(absSrc); } catch (_) { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // 概念页
  // -------------------------------------------------------------------------
  updateConceptPages(conceptPages, dateStr) {
    // 概念页是共享文件，并发“读-改-写”会丢要点，这里排队执行
    const run = () => this._updateConceptPages(conceptPages, dateStr);
    this._conceptChain = this._conceptChain.then(run, run);
    return this._conceptChain;
  }

  async _updateConceptPages(conceptPages, dateStr) {
    const dir = this.paths.conceptsDir;
    const existing = new Map();
    for (const f of this.vfs.listMarkdown(dir)) {
      existing.set(path.parse(f.name).name.toLowerCase(), f.rel);
    }

    for (const cp of conceptPages) {
      if (!cp || typeof cp !== 'object') continue;
      const name = cleanName(String(cp.name || '').trim());
      if (!name) continue;
      const key = name.toLowerCase();
      const definition = clipText(cp.definition || '', 400);
      const points = Array.isArray(cp.points) ? cp.points.map((x) => String(x).trim()).filter(Boolean) : [];
      const related = Array.isArray(cp.related) ? cp.related.map((x) => String(x).trim()).filter(Boolean) : [];
      const aliases = Array.isArray(cp.aliases) ? cp.aliases.map((x) => String(x).trim()).filter(Boolean) : [];

      const existingRel = existing.get(key);
      if (existingRel) {
        const text = await this.vfs.read(existingRel);
        const merged = mergeConceptPage(text, { points, related, definition });
        if (merged !== text) await this.vfs.write(existingRel, merged);
        continue;
      }

      const rel = joinVaultPath(dir, `${name}.md`);
      if (await this.vfs.exists(rel)) continue;
      await this.vfs.write(rel, renderConceptPage({
        name, aliases, definition, points, related, dateStr,
      }));
      existing.set(key, rel);
    }
  }

  // -------------------------------------------------------------------------
  // 台账 / 日志 / 索引
  // -------------------------------------------------------------------------
  async recordSkip(rel, { hash, reason, archived, summary, dateStr }) {
    await this.manifest.set(rel, {
      hash,
      title: normTitle(path.posix.basename(rel)),
      topic: DEFAULT_TOPIC,
      wiki: '',
      concepts: [],
      summary: summary || reason || '无实质内容，仅归档',
      archived_to: archived || '',
      raw: '',
      processed_at: nowIso(),
      batch: this.batchId,
    });
    await this.appendLog(
      `- ${nowIso().slice(0, 16).replace('T', ' ')} **skip**: \`${rel}\` ` +
      `(${reason || '无实质内容'})${archived ? ` · 归档 \`${archived}\`` : ''}\n`,
    );
  }

  async appendLog(text) {
    if (this.settings.appendLog === false) return;
    const p = this.paths.logPath;
    if (!(await this.vfs.exists(p))) {
      await this.vfs.write(p, '# Wiki Activity Log\n\n');
    }
    await this.vfs.append(p, text);
  }

  async rebuildIndex() {
    const wikiDir = this.paths.wikiDir;
    const files = this.vfs.listMarkdown(wikiDir);
    const summaryByStem = new Map();
    for (const v of Object.values((this.manifest.data && this.manifest.data.done) || {})) {
      if (v && v.wiki) summaryByStem.set(path.parse(v.wiki).name, v.summary || '');
    }

    const groups = new Map();
    for (const f of files) {
      const parent = path.posix.dirname(f.rel);
      if (parent === normalizeVaultPath(wikiDir)) continue; // 根目录零散文件不进索引
      let text = '';
      try { text = await this.vfs.read(f.rel); } catch (_) { continue; }
      const { fm, body } = splitFrontmatter(text.slice(0, 8000));
      const meta = parseFrontmatterSimple(fm);
      const stem = path.parse(f.name).name;
      const topic = meta.topic || path.posix.basename(parent) || DEFAULT_TOPIC;
      if (!groups.has(topic)) groups.set(topic, []);
      groups.get(topic).push({
        stem,
        title: meta.title || stem,
        summary: summaryByStem.get(stem) || firstParagraph(body),
        date: (meta.generated || '').trim(),
        status: meta.status || '',
      });
    }

    const total = Array.from(groups.values()).reduce((n, arr) => n + arr.length, 0);
    const lines = [
      '# Wiki Index',
      '',
      `> 由 LLM Wiki Ingest 插件重建 · 共 ${total} 篇文章 · ${groups.size} 个主题 · ` +
      `更新于 ${nowIso().slice(0, 16).replace('T', ' ')}`,
      '',
    ];

    const sortedTopics = Array.from(groups.keys()).sort((a, b) => {
      const d = groups.get(b).length - groups.get(a).length;
      return d !== 0 ? d : a.localeCompare(b, 'zh');
    });

    for (const topic of sortedTopics) {
      const items = groups.get(topic).sort((a, b) => {
        const da = a.date || '';
        const db = b.date || '';
        return db.localeCompare(da) || a.stem.localeCompare(b.stem, 'zh');
      });
      lines.push(`## ${topic}（${items.length}）`, '');
      for (const v of items) {
        const badge = v.status === 'disputed' ? ' ⚠️ 争议' : '';
        lines.push(`- [[${v.stem}]]${badge} — ${v.summary} \`${v.date}\``);
      }
      lines.push('');
    }

    await this.vfs.write(this.paths.indexPath, lines.join('\n'));
    return { total, topics: groups.size };
  }

  async readStats() {
    const manifest = this.manifest.data || { done: {} };
    const done = Object.values(manifest.done || {});
    const topics = new Map();
    for (const v of done) {
      const t = (v && v.topic) || DEFAULT_TOPIC;
      topics.set(t, (topics.get(t) || 0) + 1);
    }
    let wikiPages = 0;
    let concepts = 0;
    try { wikiPages = this.vfs.listMarkdown(this.paths.wikiDir).length; } catch (_) { /* ignore */ }
    try { concepts = this.vfs.listMarkdown(this.paths.conceptsDir).length; } catch (_) { /* ignore */ }
    return {
      processed: done.length,
      inbox: this.listInboxFiles().length,
      wikiPages,
      concepts,
      topics: Array.from(topics.entries()).sort((a, b) => b[1] - a[1]),
    };
  }

  async resolveWikiRel(value) {
    let v = String(value || '').trim();
    v = v.replace(/^\[\[|\]\]$/g, '').trim();
    v = normalizeVaultPath(v);
    if (!v) return null;
    const tries = [
      joinVaultPath(this.paths.wikiRoot, v),
      v,
      joinVaultPath(this.paths.wikiDir, v),
    ];
    for (const t of tries) {
      if (t && await this.vfs.exists(t)) return t;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 概念页渲染 / 合并
// ---------------------------------------------------------------------------
function renderConceptPage({ name, aliases, definition, points, related, dateStr }) {
  const lines = ['---', 'type: concept'];
  lines.push(`title: ${yamlString(name)}`);
  lines.push(`aliases: ${JSON.stringify(aliases || [])}`);
  lines.push(`generated: ${dateStr || todayStr()}`);
  lines.push('---', '');
  lines.push(`# ${name}`, '');
  lines.push('## 定义', '');
  lines.push(definition || '（待补充）', '');
  lines.push('## 要点', '');
  for (const p of points || []) lines.push(`- ${p}`);
  lines.push('', '## 相关', '');
  for (const r of related || []) lines.push(`- ${r.startsWith('[[') ? r : `[[${r}]]`}`);
  lines.push('');
  return lines.join('\n');
}

/** 向已有概念页补充要点（去重）与相关链接；定义不覆盖 */
function mergeConceptPage(text, { points = [], related = [] }) {
  let out = String(text || '');
  const have = out.toLowerCase();

  // 要点
  const newPoints = points.filter((p) => {
    const norm = p.replace(/^[-*]\s*/, '').trim().toLowerCase();
    if (!norm) return false;
    return !have.includes(norm.slice(0, Math.min(24, norm.length)));
  });

  // 相关链接
  const newRelated = related
    .map((r) => (r.startsWith('[[') ? r : `[[${r}]]`))
    .filter((r) => !have.includes(r.toLowerCase()));

  const hasPointsSection = /##\s*要点/.test(out);
  const hasRelatedSection = /##\s*相关/.test(out);

  if (newPoints.length) {
    if (hasPointsSection) {
      const idx = out.search(/##\s*要点/);
      const after = out.indexOf('\n## ', idx + 4);
      const end = after === -1 ? out.length : after;
      out = out.slice(0, end).replace(/\n*$/, '\n') +
        newPoints.map((p) => `- ${p}`).join('\n') + '\n' + out.slice(end);
    } else {
      out = out.replace(/\s*$/, '\n') + '\n## 要点\n' + newPoints.map((p) => `- ${p}`).join('\n') + '\n';
    }
  }

  if (newRelated.length) {
    if (hasRelatedSection) {
      const idx = out.search(/##\s*相关/);
      const after = out.indexOf('\n## ', idx + 4);
      const end = after === -1 ? out.length : after;
      out = out.slice(0, end).replace(/\n*$/, '\n') +
        newRelated.map((r) => `- ${r}`).join('\n') + '\n' + out.slice(end);
    } else {
      out = out.replace(/\s*$/, '\n') + '\n## 相关\n' + newRelated.map((r) => `- ${r}`).join('\n') + '\n';
    }
  }

  return out;
}

module.exports = {
  IngestEngine,
  renderConceptPage,
  mergeConceptPage,
  parseFrontmatterSimple,
  firstParagraph,
  normalizeArticleBody,
};

  });

  __define("llm.js", function (module, exports, require) {
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

  });

  __define("main.js", function (module, exports, require) {
'use strict';
/*
 * main.js —— LLM Wiki Ingest（Obsidian 插件入口）
 *
 * 功能：
 *   1. 阅读某篇文章时，一键编译并归档（Ribbon / 命令 / 右键菜单）
 *   2. 手动勾选多篇文章，逐一处理
 *   3. 选中一个目录，处理该目录下所有文章
 *   4. 可配置 OpenAI / Anthropic 两种接口格式
 *   5. 可配置归档目录与编译后 Wiki 文章目录
 *
 * 流水线实现在 engine.js，规范对齐 Wiki/AGENTS.md。
 */

const obsidian = require('obsidian');
const {
  Plugin, PluginSettingTab, Setting, Notice, Modal,
  TFile, TFolder, requestUrl,
} = obsidian;

const core = require('./core.js');
const { IngestEngine } = require('./engine.js');
const { LLMClient, resolveEndpoint } = require('./llm.js');

const DEFAULT_SETTINGS = {
  // ---- LLM 接入 ----
  apiFormat: 'openai',            // openai | anthropic
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  apiVersion: '2023-06-01',       // 仅 Anthropic
  authMode: 'auto',               // auto | x-api-key | bearer | both
  extraHeaders: '',
  temperature: 0.3,
  sendTemperature: true,
  maxOutputTokens: 8192,
  timeoutSec: 180,
  maxConcurrency: 3,
  extraInstructions: '',

  // ---- 路径 ----
  inboxFolder: 'wallabag',
  wikiRoot: 'Wiki',
  wikiFolder: 'Wiki/Wiki',
  conceptsFolder: 'Wiki/Concepts',
  rawFolder: 'Wiki/raw',
  stateFolder: 'Wiki/_state',
  archiveFolder: '/Volumes/YSS-3/Wallabag-Archived',
  archiveByDate: true,

  // ---- 行为 ----
  skipDuplicates: true,
  moveInboxSource: true,
  moveOutsideInboxSource: false,
  updateConcepts: true,
  rebuildIndex: true,
  appendLog: true,
  maxArticleChars: 60000,
};

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------
class LLMWikiIngestPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.running = false;
    this.activeEngine = null;

    // 状态栏
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('mod-clickable');
    this.statusBarEl.setText('LLM Wiki');
    this.statusBarEl.setAttribute('aria-label', 'LLM Wiki 摄取：点击查看统计');
    this.registerDomEvent(this.statusBarEl, 'click', () => this.showStats());

    // Ribbon
    this.addRibbonIcon('book-up', 'LLM Wiki：编译并归档当前文章', () => this.compileActiveFile());

    // 命令
    this.addCommand({
      id: 'compile-active',
      name: '编译并归档当前文章',
      callback: () => this.compileActiveFile(),
    });
    this.addCommand({
      id: 'compile-picker',
      name: '选择多篇文章编译',
      callback: () => this.openPicker(),
    });
    this.addCommand({
      id: 'compile-folder',
      name: '编译当前文章所在目录',
      callback: () => this.compileActiveFolder(),
    });
    this.addCommand({
      id: 'compile-inbox',
      name: '编译整个收件箱',
      callback: () => this.compileInbox(),
    });
    this.addCommand({
      id: 'show-stats',
      name: '查看摄取统计',
      callback: () => this.showStats(),
    });
    this.addCommand({
      id: 'rebuild-index',
      name: '重建 Wiki 索引（_index.md）',
      callback: () => this.rebuildIndexNow(),
    });

    // 右键菜单
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem((item) => item
          .setTitle('LLM Wiki：编译并归档')
          .setIcon('book-up')
          .onClick(() => this.runBatch([file.path])));
      }
      if (file instanceof TFolder) {
        menu.addItem((item) => item
          .setTitle('LLM Wiki：编译此目录')
          .setIcon('folder-open')
          .onClick(() => this.compileFolder(file)));
      }
    }));

    this.addSettingTab(new LLMWikiIngestSettingTab(this.app, this));
  }

  onunload() {
    if (this.activeEngine) this.activeEngine.cancel();
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------
  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getBasePath() {
    const adapter = this.app.vault.adapter;
    if (!adapter) return null;
    if (typeof adapter.getBasePath === 'function') {
      try { return adapter.getBasePath(); } catch (_) { /* ignore */ }
    }
    return adapter.basePath || null;
  }

  buildEngine() {
    const vfs = new core.VaultFS(this.app.vault.adapter, this.getBasePath());
    const paths = new core.WikiPaths(this.settings, vfs);
    const manifest = new core.ManifestStore(vfs, paths.manifestPath);
    return new IngestEngine({
      settings: this.settings,
      vfs,
      paths,
      manifest,
      requestUrl: (opts) => requestUrl(opts),
      removeVaultFile: async (rel) => {
        const af = this.app.vault.getAbstractFileByPath(rel);
        if (af) {
          await this.app.vault.delete(af);
        } else {
          await this.app.vault.adapter.remove(rel);
        }
      },
      renameVaultFile: async (from, to) => {
        const af = this.app.vault.getAbstractFileByPath(from);
        if (af) {
          await this.app.fileManager.renameFile(af, to);
        } else {
          await this.app.vault.adapter.rename(from, to);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------
  async compileActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('请先打开一篇文章'); return; }
    if (file.extension !== 'md') { new Notice('只处理 Markdown 文件'); return; }
    await this.runBatch([file.path]);
  }

  compileActiveFolder() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('请先打开一篇文章，以定位所在目录'); return; }
    const folder = file.parent;
    if (!folder || folder.isRoot?.()) {
      new Notice('当前文件不在子目录里');
      return;
    }
    this.compileFolder(folder);
  }

  compileFolder(folder) {
    const files = [];
    const walk = (node) => {
      if (node instanceof TFile) {
        if (node.extension === 'md') files.push(node.path);
        return;
      }
      if (node instanceof TFolder) node.children.forEach(walk);
    };
    walk(folder);
    if (!files.length) {
      new Notice(`目录「${folder.name}」下没有 Markdown 文件`);
      return;
    }
    new Notice(`准备处理「${folder.name}」下的 ${files.length} 篇文章`);
    this.runBatch(files);
  }

  compileInbox() {
    const engine = this.buildEngine();
    const files = engine.listInboxFiles().map((f) => f.rel);
    if (!files.length) {
      new Notice(`收件箱（${this.settings.inboxFolder}）里没有 Markdown 文件`);
      return;
    }
    this.runBatch(files);
  }

  openPicker() {
    const engine = this.buildEngine();
    const files = engine.listInboxFiles();
    if (!files.length) {
      new Notice(`收件箱（${this.settings.inboxFolder}）里没有 Markdown 文件`);
      return;
    }
    new LWIPickerModal(this.app, files, this.settings.inboxFolder, (selected) => {
      this.runBatch(selected);
    }).open();
  }

  async showStats() {
    const engine = this.buildEngine();
    try {
      await engine.ensureDirs();
      await engine.manifest.load();
      const st = await engine.readStats();
      const lines = [
        `已处理：${st.processed} 篇`,
        `收件箱剩余：${st.inbox} 篇`,
        `Wiki 文章：${st.wikiPages} 篇`,
        `概念页：${st.concepts} 个`,
      ];
      if (st.topics.length) {
        lines.push('主题分布：' + st.topics.slice(0, 5)
          .map(([t, c]) => `${t} ${c}`).join(' · '));
      }
      new Notice(lines.join('\n'), 10000);
    } catch (err) {
      new Notice('读取统计失败：' + err.message, 8000);
    }
  }

  async rebuildIndexNow() {
    const engine = this.buildEngine();
    try {
      await engine.ensureDirs();
      await engine.manifest.load();
      const r = await engine.rebuildIndex();
      new Notice(`索引已重建：${r.total} 篇 / ${r.topics} 个主题`, 6000);
    } catch (err) {
      new Notice('重建索引失败：' + err.message, 8000);
    }
  }

  // -------------------------------------------------------------------------
  // 批处理主循环
  // -------------------------------------------------------------------------
  async runBatch(relPaths) {
    if (this.running) {
      new Notice('已有任务在运行，请等待完成或取消');
      return;
    }
    const list = Array.from(new Set((relPaths || []).filter((p) => typeof p === 'string' && p)));
    if (!list.length) { new Notice('没有选中任何文章'); return; }

    this.running = true;
    this.statusBarEl.setText(`LLM Wiki：0/${list.length}`);

    const modal = new LWIProgressModal(this.app, list.length);
    const engine = this.buildEngine();
    this.activeEngine = engine;
    modal.onCancelCb = () => {
      engine.cancel();
      new Notice('已请求取消，当前正在编译的文章会跑完');
    };
    modal.open();

    try {
      await engine.processAll(list, {
        onStart: (rel) => {
          modal.itemStart(rel);
          this.statusBarEl.setText(`LLM Wiki：${modal.doneCount()}/${list.length}`);
        },
        onDone: (res) => {
          modal.itemDone(res);
          this.statusBarEl.setText(`LLM Wiki：${modal.doneCount()}/${list.length}`);
        },
      });

      const s = engine.stats;
      modal.finish(s, engine.cancelled, {
        // 等本批次 finally 把 running 复位后再开新一批
        onRetry: (paths) => { setTimeout(() => { this.runBatch(paths); }, 0); },
      });
      new Notice(
        `LLM Wiki 完成：新编译 ${s.compiled} · 合并更新 ${s.updated} · 跳过 ${s.skip} · ` +
        `重复 ${s.already} · 失败 ${s.error}`,
        10000,
      );
    } catch (err) {
      modal.fail(err && err.message ? err.message : String(err));
      new Notice('LLM Wiki 处理失败：' + (err && err.message ? err.message : err), 12000);
    } finally {
      this.running = false;
      this.activeEngine = null;
      this.statusBarEl.setText('LLM Wiki');
    }
  }
}

// ---------------------------------------------------------------------------
// 文件选择器
// ---------------------------------------------------------------------------
class LWIPickerModal extends Modal {
  constructor(app, files, inboxLabel, onSubmit) {
    super(app);
    this.files = files;
    this.inboxLabel = inboxLabel;
    this.onSubmit = onSubmit;
    this.selected = new Set();
    this.rows = [];
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    contentEl.addClass('llm-wiki-picker');
    titleEl.setText(`选择要处理的文章（${this.files.length} 篇 · 收件箱 ${this.inboxLabel}）`);

    const toolbar = contentEl.createDiv({ cls: 'lwi-toolbar' });
    this.searchEl = toolbar.createEl('input', {
      cls: 'lwi-search',
      type: 'text',
      placeholder: '搜索文件名…',
    });
    this.searchEl.oninput = () => this.renderList();

    const selAll = toolbar.createEl('button', { text: '全选' });
    selAll.onclick = () => {
      this.visibleFiles().forEach((f) => this.selected.add(f.rel));
      this.renderList();
    };
    const selNone = toolbar.createEl('button', { text: '全不选' });
    selNone.onclick = () => {
      this.selected.clear();
      this.renderList();
    };

    this.listEl = contentEl.createDiv({ cls: 'lwi-list' });

    const footer = contentEl.createDiv({ cls: 'lwi-footer' });
    this.countEl = footer.createSpan({ cls: 'lwi-count' });
    const go = footer.createEl('button', { cls: 'mod-cta', text: '开始编译' });
    go.onclick = () => {
      const picked = this.files.filter((f) => this.selected.has(f.rel)).map((f) => f.rel);
      if (!picked.length) { new Notice('还没有选择任何文章'); return; }
      this.close();
      this.onSubmit(picked);
    };

    this.renderList();
    this.searchEl.focus();
  }

  visibleFiles() {
    const q = String(this.searchEl ? this.searchEl.value : '').trim().toLowerCase();
    if (!q) return this.files;
    return this.files.filter((f) => f.rel.toLowerCase().includes(q) ||
      String(f.name || '').toLowerCase().includes(q));
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    const files = this.visibleFiles();
    if (!files.length) {
      this.listEl.createDiv({ cls: 'lwi-item lwi-skip', text: '没有匹配的文件' });
    }
    for (const f of files) {
      const row = this.listEl.createEl('label', { cls: 'lwi-item' });
      const cb = row.createEl('input', { type: 'checkbox' });
      cb.checked = this.selected.has(f.rel);
      cb.onchange = () => {
        if (cb.checked) this.selected.add(f.rel);
        else this.selected.delete(f.rel);
        this.updateCount();
      };
      row.createSpan({ cls: 'lwi-item-name', text: f.rel });
      row.createSpan({ cls: 'lwi-item-meta', text: core.humanBytes(f.size) });
    }
    this.updateCount();
  }

  updateCount() {
    if (this.countEl) this.countEl.setText(`已选 ${this.selected.size} / ${this.files.length}`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// 进度面板
// ---------------------------------------------------------------------------
class LWIProgressModal extends Modal {
  constructor(app, total) {
    super(app);
    this.total = total;
    this.done = 0;
    this.rowBySrc = new Map();
    this.failed = [];
    this.onCancelCb = null;
    this.cancelled = false;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    contentEl.addClass('llm-wiki-ingest-progress');
    titleEl.setText(`编译并归档（共 ${this.total} 篇）`);

    this.summaryEl = contentEl.createDiv({ cls: 'lwi-summary', text: `0 / ${this.total}` });
    const bar = contentEl.createDiv({ cls: 'lwi-bar' });
    this.barInner = bar.createDiv({ cls: 'lwi-bar-inner' });
    this.logEl = contentEl.createDiv({ cls: 'lwi-log' });

    this.footer = contentEl.createDiv({ cls: 'lwi-footer' });
    const footer = this.footer;
    this.cancelBtn = footer.createEl('button', { text: '取消' });
    this.cancelBtn.onclick = () => {
      this.cancelled = true;
      this.cancelBtn.disabled = true;
      this.cancelBtn.setText('正在取消…');
      if (this.onCancelCb) this.onCancelCb();
    };
    this.closeBtn = footer.createEl('button', { cls: 'mod-cta', text: '后台运行' });
    this.closeBtn.onclick = () => this.close();
  }

  doneCount() { return this.done; }

  itemStart(rel) {
    if (!this.logEl) return;
    const line = this.logEl.createDiv({ cls: 'lwi-line lwi-run', text: `⏳ ${rel}` });
    this.rowBySrc.set(rel, line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  itemDone(res) {
    this.done += 1;
    const src = res && res.src ? res.src : '(未知)';
    if (res && (res.ok === false || res.status === 'error')) {
      this.failed.push({ src, error: res.error || res.message || '未知错误' });
    }
    let line = this.rowBySrc.get(src);
    if (!line && this.logEl) {
      line = this.logEl.createDiv({ cls: 'lwi-line' });
      this.rowBySrc.set(src, line);
    }
    if (line) {
      const st = res ? res.status : 'error';
      if (st === 'compiled') {
        line.setText(`✅ ${src} → ${res.wikiRel}`);
        line.className = 'lwi-line lwi-ok';
      } else if (st === 'updated') {
        line.setText(`🔀 ${src} → 合并进 ${res.wikiRel}`);
        line.className = 'lwi-line lwi-ok';
      } else if (st === 'skip') {
        line.setText(`⏭️ ${src}（跳过编译）${res.message ? '：' + res.message : ''}`);
        line.className = 'lwi-line lwi-skip';
      } else if (st === 'already') {
        line.setText(`♻️ ${src}（${res.message || '已处理过'}）`);
        line.className = 'lwi-line lwi-skip';
      } else if (st === 'cancelled') {
        line.setText(`⏹️ ${src}（已取消）`);
        line.className = 'lwi-line lwi-skip';
      } else {
        line.setText(`❌ ${src}：${res && res.error ? res.error : '未知错误'}`);
        line.className = 'lwi-line lwi-err';
      }
    }
    const pct = this.total ? Math.round((this.done / this.total) * 100) : 100;
    if (this.barInner) this.barInner.style.width = pct + '%';
    if (this.summaryEl) this.summaryEl.setText(`${this.done} / ${this.total}（${pct}%）`);
    if (this.logEl) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  finish(stats, wasCancelled, opts = {}) {
    if (!this.summaryEl) return;
    const s = stats || {};
    const tail = wasCancelled ? ' · 已取消' : '';
    this.summaryEl.setText(
      `完成${tail}：编译 ${s.compiled || 0} · 合并 ${s.updated || 0} · 跳过 ${s.skip || 0} · ` +
      `重复 ${s.already || 0} · 失败 ${s.error || 0}`,
    );
    if (this.cancelBtn) this.cancelBtn.remove();
    if (this.closeBtn) {
      this.closeBtn.setText('关闭');
      this.closeBtn.onclick = () => this.close();
    }
    if (this.barInner) this.barInner.style.width = '100%';

    // 失败项重试：只重跑出错的那几篇，跳过与已成功的不会重复消耗 token
    const failed = this.failed || [];
    if (failed.length && this.footer && typeof opts.onRetry === 'function') {
      const retryBtn = this.footer.createEl('button', {
        cls: 'mod-warning',
        text: `重试失败的 ${failed.length} 篇`,
      });
      retryBtn.setAttribute('title', failed.map((f) => f.src).join('\n'));
      retryBtn.onclick = () => {
        const paths = failed.map((f) => f.src).filter(Boolean);
        this.close();
        if (paths.length) opts.onRetry(paths);
      };
      if (this.closeBtn) this.footer.insertBefore(retryBtn, this.closeBtn);
      this.retryBtn = retryBtn;
    }
  }

  fail(message) {
    if (this.summaryEl) this.summaryEl.setText('处理失败：' + message);
    if (this.cancelBtn) this.cancelBtn.remove();
    if (this.closeBtn) {
      this.closeBtn.setText('关闭');
      this.closeBtn.onclick = () => this.close();
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// 设置页
// ---------------------------------------------------------------------------
class LLMWikiIngestSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };

    // ===== LLM 接入 =====
    new Setting(containerEl).setName('LLM 接入').setHeading();

    new Setting(containerEl)
      .setName('接口格式')
      .setDesc('OpenAI 兼容（/chat/completions）或 Anthropic（/messages）')
      .addDropdown((dd) => dd
        .addOption('openai', 'OpenAI 格式')
        .addOption('anthropic', 'Anthropic 格式')
        .setValue(s.apiFormat)
        .onChange(async (v) => {
          s.apiFormat = v;
          if (v === 'anthropic' && /api\.openai\.com/.test(s.baseUrl)) {
            s.baseUrl = 'https://api.anthropic.com';
          } else if (v === 'openai' && /api\.anthropic\.com/.test(s.baseUrl)) {
            s.baseUrl = 'https://api.openai.com/v1';
          }
          await save();
          this.display();
        }));

    new Setting(containerEl)
      .setName('接口地址（Base URL）')
      .setDesc('填到域名、/v1 或完整端点都可以；下方会显示实际请求地址')
      .addText((t) => t
        .setPlaceholder(s.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
        .setValue(s.baseUrl)
        .onChange(async (v) => {
          s.baseUrl = v.trim();
          await save();
          this.refreshEndpointHint();
        }));
    this.endpointHintEl = containerEl.createEl('div', { cls: 'setting-item-description' });
    this.refreshEndpointHint();

    let keyInputEl = null;
    new Setting(containerEl)
      .setName('API Key')
      .setDesc('保存在插件 data.json 中（与其他 Obsidian 插件一致，注意备份安全）')
      .addText((t) => {
        keyInputEl = t.inputEl;
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-…')
          .setValue(s.apiKey)
          .onChange(async (v) => {
            s.apiKey = v.trim();
            await save();
          });
      })
      .addExtraButton((b) => b
        .setIcon('eye')
        .setTooltip('显示 / 隐藏')
        .onClick(() => {
          if (!keyInputEl) return;
          keyInputEl.type = keyInputEl.type === 'password' ? 'text' : 'password';
        }));

    new Setting(containerEl)
      .setName('模型')
      .setDesc('例如 gpt-4o / claude-sonnet-4-5 / MiniMax-M2 等')
      .addText((t) => t
        .setPlaceholder('gpt-4o')
        .setValue(s.model)
        .onChange(async (v) => { s.model = v.trim(); await save(); }));

    if (s.apiFormat === 'anthropic') {
      new Setting(containerEl)
        .setName('Anthropic 版本头')
        .setDesc('anthropic-version 请求头，一般保持默认')
        .addText((t) => t
          .setValue(s.apiVersion)
          .onChange(async (v) => { s.apiVersion = v.trim(); await save(); }));

      new Setting(containerEl)
        .setName('鉴权方式')
        .setDesc('官方端点用 x-api-key；多数第三方兼容网关用 Bearer')
        .addDropdown((dd) => dd
          .addOption('auto', '自动')
          .addOption('x-api-key', 'x-api-key')
          .addOption('bearer', 'Authorization: Bearer')
          .addOption('both', '两者都发')
          .setValue(s.authMode)
          .onChange(async (v) => { s.authMode = v; await save(); }));
    }

    new Setting(containerEl)
      .setName('最大输出 tokens')
      .setDesc('单次编译的 max_tokens，建议 ≥ 8192（800–2500 字正文需要足够额度）')
      .addText((t) => t
        .setValue(String(s.maxOutputTokens))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) { s.maxOutputTokens = n; await save(); }
        }));

    new Setting(containerEl)
      .setName('温度')
      .setDesc('0–1；编译类任务建议 0.2–0.4')
      .addSlider((sl) => sl
        .setLimits(0, 1, 0.05)
        .setValue(Number(s.temperature) || 0)
        .setDynamicTooltip()
        .onChange(async (v) => { s.temperature = v; await save(); }));

    new Setting(containerEl)
      .setName('发送 temperature 参数')
      .setDesc('部分推理模型（o1 / o3 等）不接受该参数，遇到 400 可关闭')
      .addToggle((t) => t
        .setValue(s.sendTemperature !== false)
        .onChange(async (v) => { s.sendTemperature = v; await save(); }));

    new Setting(containerEl)
      .setName('并发数')
      .setDesc('同时编译的篇数，1–8。块耗时主要由最慢一篇决定，建议 3–5')
      .addSlider((sl) => sl
        .setLimits(1, 8, 1)
        .setValue(Math.min(8, Math.max(1, Number(s.maxConcurrency) || 3)))
        .setDynamicTooltip()
        .onChange(async (v) => { s.maxConcurrency = v; await save(); }));

    new Setting(containerEl)
      .setName('单次请求超时（秒）')
      .setDesc('长文编译可能需要 2–4 分钟')
      .addText((t) => t
        .setValue(String(s.timeoutSec))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 10) { s.timeoutSec = n; await save(); }
        }));

    new Setting(containerEl)
      .setName('自定义请求头')
      .setDesc('每行一个 key: value，例如 X-Org-Id: abc')
      .addTextArea((t) => {
        t.setValue(s.extraHeaders || '')
          .setPlaceholder('X-Org-Id: abc')
          .onChange(async (v) => { s.extraHeaders = v; await save(); });
        t.inputEl.rows = 3;
      });

    new Setting(containerEl)
      .setName('补充指令')
      .setDesc('追加到分诊与编译提示词末尾，用来固定写作口味或术语表')
      .addTextArea((t) => {
        t.setValue(s.extraInstructions || '')
          .setPlaceholder('例如：术语统一用「稳定币」而非「数币」')
          .onChange(async (v) => { s.extraInstructions = v; await save(); });
        t.inputEl.rows = 3;
      });

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('发一条最小请求，验证地址、Key、模型名')
      .addButton((b) => b
        .setButtonText('测试')
        .onClick(async () => {
          b.setButtonText('测试中…');
          b.setDisabled(true);
          try {
            const client = new LLMClient(s, (o) => requestUrl(o));
            const r = await client.chat({
              system: '你是一个连通性测试端点。',
              user: '只回复两个字符：OK',
              maxTokens: 16,
            });
            new Notice('连接成功：' + String(r.text).trim().slice(0, 80), 8000);
          } catch (err) {
            new Notice('连接失败：' + err.message, 15000);
          } finally {
            b.setButtonText('测试');
            b.setDisabled(false);
          }
        }));

    // ===== 路径 =====
    new Setting(containerEl).setName('路径').setHeading();

    const pathSetting = (name, desc, key, placeholder) => new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((t) => t
        .setPlaceholder(placeholder || '')
        .setValue(s[key] || '')
        .onChange(async (v) => { s[key] = v.trim(); await save(); }));

    pathSetting('收件箱目录', '待处理剪藏的目录（含子目录一起扫描）', 'inboxFolder', 'wallabag');
    pathSetting('Wiki 知识库根目录', 'raw / Concepts / _state / _index / _log 都放在这里', 'wikiRoot', 'Wiki');
    pathSetting('编译后文章目录', '编译产出的 Wiki 文章保存位置', 'wikiFolder', 'Wiki/Wiki');
    pathSetting('概念页目录', '原子概念页保存位置', 'conceptsFolder', 'Wiki/Concepts');
    pathSetting('原文存档目录', '不可变的原文副本（事实核验依据）', 'rawFolder', 'Wiki/raw');
    pathSetting('状态目录', 'manifest.json 台账所在目录', 'stateFolder', 'Wiki/_state');

    new Setting(containerEl)
      .setName('归档目录')
      .setDesc('处理完的原文移动到这里。可填 vault 内相对路径，也可填绝对路径（如外置盘 /Volumes/YSS-3/Wallabag-Archived）')
      .addText((t) => t
        .setPlaceholder('/Volumes/YSS-3/Wallabag-Archived')
        .setValue(s.archiveFolder || '')
        .onChange(async (v) => { s.archiveFolder = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName('归档按日期分文件夹')
      .setDesc('开启后归档到 <归档目录>/YYYY-MM-DD/')
      .addToggle((t) => t
        .setValue(s.archiveByDate !== false)
        .onChange(async (v) => { s.archiveByDate = v; await save(); }));

    // ===== 行为 =====
    new Setting(containerEl).setName('行为').setHeading();

    new Setting(containerEl)
      .setName('跳过重复内容')
      .setDesc('按 md5 判重，同内容改名重投不会重复编译')
      .addToggle((t) => t
        .setValue(s.skipDuplicates !== false)
        .onChange(async (v) => { s.skipDuplicates = v; await save(); }));

    new Setting(containerEl)
      .setName('处理完移动收件箱里的原文')
      .setDesc('关闭后只编译不移动，原文留在收件箱')
      .addToggle((t) => t
        .setValue(s.moveInboxSource !== false)
        .onChange(async (v) => { s.moveInboxSource = v; await save(); }));

    new Setting(containerEl)
      .setName('收件箱之外的文件也移动归档')
      .setDesc('默认关闭：在普通笔记上右键编译时，不会把笔记挪走')
      .addToggle((t) => t
        .setValue(Boolean(s.moveOutsideInboxSource))
        .onChange(async (v) => { s.moveOutsideInboxSource = v; await save(); }));

    new Setting(containerEl)
      .setName('更新概念页')
      .setDesc('把编译结果里的概念要点并入 Concepts/')
      .addToggle((t) => t
        .setValue(s.updateConcepts !== false)
        .onChange(async (v) => { s.updateConcepts = v; await save(); }));

    new Setting(containerEl)
      .setName('完成后重建索引')
      .setDesc('重建 _index.md（按主题分组）')
      .addToggle((t) => t
        .setValue(s.rebuildIndex !== false)
        .onChange(async (v) => { s.rebuildIndex = v; await save(); }));

    new Setting(containerEl)
      .setName('追加操作日志')
      .setDesc('写入 _log.md')
      .addToggle((t) => t
        .setValue(s.appendLog !== false)
        .onChange(async (v) => { s.appendLog = v; await save(); }));

    new Setting(containerEl)
      .setName('单篇最大读取字符数')
      .setDesc('超出部分按「前 80% + 后 20%」截断，做骨架式摘要')
      .addText((t) => t
        .setValue(String(s.maxArticleChars))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 2000) { s.maxArticleChars = n; await save(); }
        }));

    // ===== 诊断 =====
    new Setting(containerEl).setName('诊断').setHeading();

    new Setting(containerEl)
      .setName('查看统计')
      .setDesc('已处理、收件箱剩余、Wiki 篇数、概念页数')
      .addButton((b) => b.setButtonText('查看').onClick(() => this.plugin.showStats()));

    new Setting(containerEl)
      .setName('重建索引')
      .setDesc('按文件系统重写 _index.md')
      .addButton((b) => b.setButtonText('重建').onClick(() => this.plugin.rebuildIndexNow()));
  }

  refreshEndpointHint() {
    if (!this.endpointHintEl) return;
    const s = this.plugin.settings;
    try {
      const url = resolveEndpoint(s.baseUrl, s.apiFormat === 'anthropic' ? 'anthropic' : 'openai');
      this.endpointHintEl.setText(`实际请求地址：${url}`);
    } catch (err) {
      this.endpointHintEl.setText('实际请求地址：' + err.message);
    }
  }
}

module.exports = LLMWikiIngestPlugin;
module.exports.default = LLMWikiIngestPlugin;

  });

  __define("prompts.js", function (module, exports, require) {
'use strict';
/*
 * prompts.js —— 与 Wiki/AGENTS.md 规范对齐的两段式提示词。
 *
 * 分诊（triage）先判定：新建 / 合并 / 跳过；
 * 编译（compile）再产出真正的 Wiki 文章与概念页。
 * 拆成两次调用是为了让 LLM 在写作前先看到「已有知识」，
 * 避免重复建页、也避免把 update 写成一篇孤立的新文。
 */

const TRIAGE_SYSTEM = `你是「LLM Wiki」的摄入分诊员。

LLM Wiki 的核心做法：摄入时一次性把剪藏编译成结构化知识文章，知识持续累加；
而不是每次提问都去检索原文碎片。你的职责只是分诊，不写作。

对给定的原文做判定，只输出一个 JSON 对象，不要解释、不要 markdown 围栏。

JSON 字段：
- status: "ok" 或 "skip"
- topic: 必须从【主题列表】里原样取一个
- title: 编译后文章标题，用概念/论点命名，不照抄剪藏标题；去掉「！」「绝了」「保姆级」「手把手」「喂饭级」这类营销词；不超过 40 字
- summary: 一句话摘要，不超过 40 字，会写进总索引
- concepts: 原文中出现的、有跨文章复用价值的稳定概念名（协议 / 公司 / 法规 / 技术名词 / 人物），2–8 个
- merge_target: 若与【已有文章】中某篇是同一核心论点，填那篇文章的路径（必须逐字来自列表）；否则空字符串
- disputed: 原文结论与已有文章矛盾时为 true，否则 false
- reason: 一句话说明判定理由

status 判定标准：
- "skip"：纯广告、课程推销、活动预告、目录页、无正文、或除复述已有观点外没有任何新信息
- "ok"：引入新概念/新实体/新数据/新案例，能产出有价值的 Wiki 文章

硬性约束：
- topic 只能从给定列表选，不得自造主题
- 原文没出现的数字不要写进 title / summary
- 宁可判 skip，也不要为凑数而判 ok`;

const COMPILE_SYSTEM = `你是「LLM Wiki」的编译者：把一篇剪藏编译成结构化的中文知识文章。

只输出一个 JSON 对象，不要解释、不要 markdown 围栏：

{
  "article": "Markdown 正文（从 ## 概述 开始，不含 frontmatter，不含 \`\`\` 围栏）",
  "concepts": ["概念名"],
  "concept_pages": [
    {
      "name": "概念名",
      "aliases": ["别名"],
      "definition": "1–2 句定义",
      "points": ["要点"],
      "related": ["[[相关概念]]"]
    }
  ]
}

文章结构必须依次出现：
## 概述
（3–5 句：这篇在说什么、结论是什么）
## 核心论点 / 机制
（用 ### 分小节展开）
## 关键数据
（列表；每条数据后用括号注明原文的说法）
## 与已有知识的关联
（连到哪些概念/文章，冲突点在哪）
## See Also
（[[双链]] 列表）

硬性要求：
1. 是编译不是摘抄：提炼、重组、下结论。目标 800–2500 字，原文很长可到 4000 字。
2. 事实溯源：每个数字、金额、日期、人名、直接引语必须在原文中逐字存在。
   原文写「42K」就写「42K」，不要换算成「42,000」。定位不到的数就宁可不写，也不要给精确的假数字。
   派生值（加总、增速）必须写明组成项。
3. 正文里出现的稳定概念/实体，用 [[双链]] 包住，让 Obsidian 图谱连起来。
4. 中文正文；专有名词与术语保留英文原词（如 payfi、TEE）。
5. 若给了【已有文章】，就在它的基础上合并重写：旧结论保留；
   新事实推翻旧结论时标 > [!warning] Status: Disputed（写明冲突双方出处）；
   被判为过时的标 > [!info] Status: Outdated（附新来源）。不要直接删掉旧文。
6. 不要输出 frontmatter（--- 块），不要输出 \`\`\` 包裹的整篇文章。
7. concept_pages 只给有跨文章复用价值的稳定概念写页：
   definition 1–2 句；points 3–6 条；related 用 [[ ]]；不要写成文章摘要。`;

function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n（…原文后续约 ${s.length - max} 字未展示…）`;
}

/**
 * @param {{articleText:string, fileName:string, topicNames:string[],
 *          articles:Array<{topic:string,title:string,wikiRel:string,summary:string}>,
 *          concepts:string[]}} p
 */
function buildTriageUser(p) {
  const lines = [];

  lines.push('【主题列表】');
  lines.push((p.topicNames || []).join('、'));
  lines.push('');

  const articles = p.articles || [];
  lines.push(`【已有文章】（共 ${articles.length} 篇${articles.length > 240 ? '，仅列最近 240 篇' : ''}）`);
  if (!articles.length) {
    lines.push('（暂无，这是第一篇文章）');
  } else {
    const byTopic = new Map();
    for (const a of articles.slice(-240)) {
      const t = a.topic || '其他';
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t).push(a);
    }
    for (const [topic, items] of byTopic) {
      lines.push(`- ${topic}`);
      for (const a of items) {
        const summary = a.summary ? ` — ${clip(a.summary, 60)}` : '';
        lines.push(`  - 《${a.title}》 · ${a.wikiRel}${summary}`);
      }
    }
  }
  lines.push('');

  const concepts = p.concepts || [];
  lines.push(`【已有概念页】（${concepts.length} 个）`);
  lines.push(concepts.length ? clip(concepts.join('、'), 4000) : '（暂无）');
  lines.push('');

  lines.push(`【原文：${p.fileName}，共 ${String(p.articleText || '').length} 字】`);
  lines.push(clip(p.articleText, 15000));

  return lines.join('\n');
}

/**
 * @param {{articleText:string, fileName:string, topic:string, title:string, summary:string,
 *          mergeBody:string, mergeTitle:string, articleTruncated:boolean}} p
 */
function buildCompileUser(p) {
  const lines = [];
  lines.push('【主题】' + (p.topic || '其他'));
  lines.push('【计划标题】' + (p.title || ''));
  if (p.summary) lines.push('【一句话摘要】' + p.summary);
  lines.push('');

  if (p.mergeBody) {
    lines.push(`【已有文章（合并目标）：${p.mergeTitle || ''}】`);
    lines.push(clip(p.mergeBody, 12000));
    lines.push('');
  }

  lines.push(`【原文：${p.fileName}，共 ${String(p.articleText || '').length} 字${p.articleTruncated ? '（超长，已截断）' : ''}】`);
  lines.push(p.articleText);
  return lines.join('\n');
}

module.exports = {
  TRIAGE_SYSTEM,
  COMPILE_SYSTEM,
  buildTriageUser,
  buildCompileUser,
};

  });

  module.exports = __load("main.js");
})();

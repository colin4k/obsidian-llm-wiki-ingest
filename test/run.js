'use strict';
/*
 * 离线测试：用一个真实的临时目录当 vault，注入假的 DataAdapter 与假的 LLM，
 * 跑通「分诊 → 编译 → 存档 raw → 写 Wiki → 归档移动 → 台账 → 索引 → 日志」。
 *
 * 运行：node test/run.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../src/core.js');
const { IngestEngine } = require('../src/engine.js');
const { LLMClient, resolveEndpoint, parseHeaderLines } = require('../src/llm.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed += 1; }
  else { failed += 1; failures.push(msg); console.error('  ✗ ' + msg); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

// ---------------------------------------------------------------------------
// 假的 Obsidian DataAdapter（直通本地文件系统）
// ---------------------------------------------------------------------------
class FakeAdapter {
  constructor(basePath) { this.basePath = basePath; }
  _p(rel) { return path.join(this.basePath, core.normalizeVaultPath(rel)); }
  async exists(rel) { return fs.existsSync(this._p(rel)); }
  async read(rel) { return fs.readFileSync(this._p(rel), 'utf8'); }
  async write(rel, data) {
    const p = this._p(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, 'utf8');
  }
  async mkdir(rel) { fs.mkdirSync(this._p(rel)); }
  async remove(rel) { fs.rmSync(this._p(rel), { recursive: true, force: true }); }
  async rename(from, to) {
    const b = this._p(to);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(this._p(from), b);
  }
  async stat(rel) {
    const s = fs.statSync(this._p(rel));
    return { type: s.isDirectory() ? 'folder' : 'file', size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
  }
  async list(rel) {
    const dir = this._p(rel);
    if (!fs.existsSync(dir)) return { files: [], folders: [] };
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return {
      files: entries.filter((e) => e.isFile()).map((e) => core.joinVaultPath(rel, e.name)),
      folders: entries.filter((e) => e.isDirectory()).map((e) => core.joinVaultPath(rel, e.name)),
    };
  }
}

// ---------------------------------------------------------------------------
// 假的 LLM：按 system 提示词区分分诊 / 编译
// ---------------------------------------------------------------------------
const ARTICLE_BODY = [
  '## 概述',
  '这篇讲的是 USDC 的清算路径与 Circle 的上市披露。核心结论：USDC 的链上流通量在 2026 年达到 60B，',
  'Circle 的收入结构从储备利息转向 API 服务费，这是一次实质性的商业模式变化。',
  '',
  '## 核心论点 / 机制',
  '### 储备利率的传导',
  'USDC 的储备以短债为主，利率下行会直接压缩 Circle 的利息收入。原文披露 2026 年 Q1 利息收入占比从 92% 降至 61%。',
  '',
  '## 关键数据',
  '- 链上流通量 60B（原文写「60B」，未做换算）',
  '- Q1 利息收入占比 61%（原文写「61%」）',
  '',
  '## 与已有知识的关联',
  '与 [[稳定币]]、[[Circle]] 相连；与已有文章《RWA规模叙事》在「规模口径」上存在差异，已在对应页面标注。',
  '',
  '## See Also',
  '- [[USDC]]',
  '- [[Circle]]',
].join('\n');

const CONCEPT_USDC = {
  name: 'USDC',
  aliases: ['USD Coin'],
  definition: 'Circle 发行的美元稳定币，1:1 以美元及短债储备支撑。',
  points: ['储备以现⾦与短期美债为主', '利息收入是主要利润来源'],
  related: ['[[Circle]]', '[[稳定币]]'],
};

const requests = [];

function mockRequestUrl(payload) {
  const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
  requests.push({ url: payload.url, headers: payload.headers, body });
  const parsed = JSON.parse(body);
  const sys = parsed.system || (parsed.messages && parsed.messages[0] && parsed.messages[0].content) || '';
  const user = parsed.messages && parsed.messages.length
    ? parsed.messages[parsed.messages.length - 1].content
    : '';

  const reply = (obj) => ({ status: 200, json: obj, text: JSON.stringify(obj) });

  if (sys.includes('分诊员')) {
    if (user.includes('限时优惠') || user.includes('扫码加微信')) {
      const data = {
        status: 'skip',
        topic: '其他',
        title: '课程广告',
        summary: '纯课程推销，无实质内容',
        concepts: [],
        merge_target: '',
        disputed: false,
        reason: '纯广告',
      };
      return reply({
        choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(data) + '\n```' } }],
      });
    }
    const data = {
      status: 'ok',
      topic: '稳定币与RWA',
      title: 'USDC 清算路径与 Circle 收入结构',
      summary: 'USDC 流通量 60B，Circle 收入从利息转向服务费',
      concepts: ['USDC', 'Circle'],
      merge_target: '',
      disputed: false,
      reason: '有新的披露数据',
    };
    return reply({ choices: [{ message: { role: 'assistant', content: JSON.stringify(data) } }] });
  }

  // 编译
  const data = {
    article: ARTICLE_BODY,
    concepts: ['USDC', 'Circle'],
    concept_pages: [CONCEPT_USDC],
  };
  return reply({ choices: [{ message: { role: 'assistant', content: JSON.stringify(data) } }] });
}

// ---------------------------------------------------------------------------
// 环境搭建
// ---------------------------------------------------------------------------
function makeSettings(overrides = {}) {
  return Object.assign({
    apiFormat: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o',
    apiVersion: '2023-06-01',
    authMode: 'auto',
    extraHeaders: '',
    temperature: 0.3,
    sendTemperature: true,
    maxOutputTokens: 8192,
    timeoutSec: 30,
    maxConcurrency: 2,
    extraInstructions: '',
    inboxFolder: 'wallabag',
    wikiRoot: 'Wiki',
    wikiFolder: 'Wiki/Wiki',
    conceptsFolder: 'Wiki/Concepts',
    rawFolder: 'Wiki/raw',
    stateFolder: 'Wiki/_state',
    archiveFolder: '',
    archiveByDate: true,
    skipDuplicates: true,
    moveInboxSource: true,
    moveOutsideInboxSource: false,
    updateConcepts: true,
    rebuildIndex: true,
    appendLog: true,
    maxArticleChars: 60000,
  }, overrides);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwi-test-'));
  const vaultDir = path.join(root, 'vault');
  const archiveDir = path.join(root, 'archive');
  fs.mkdirSync(vaultDir, { recursive: true });

  const adapter = new FakeAdapter(vaultDir);
  const settings = makeSettings({ archiveFolder: archiveDir });
  const vfs = new core.VaultFS(adapter, vaultDir);
  const paths = new core.WikiPaths(settings, vfs);
  const manifest = new core.ManifestStore(vfs, paths.manifestPath);
  const client = new LLMClient(settings, mockRequestUrl);

  // 收件箱素材
  const inbox = path.join(vaultDir, 'wallabag');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(inbox, '子目录'), { recursive: true });

  const goodArticle = [
    '---', 'title: 某篇文章', '---', '',
    '# USDC 与 Circle', '',
    '2026 年 Q1，USDC 链上流通量达到 60B，Circle 在 IPO 披露中给出利息收入占比 61%。',
    '正文略。'.repeat(50),
  ].join('\n');
  fs.writeFileSync(path.join(inbox, 'USDC 与 Circle.md'), goodArticle, 'utf8');

  const adArticle = '# 限时优惠\n\n扫码加微信，原价 999 元课程现在只要 9.9 元。\n';
  fs.writeFileSync(path.join(inbox, '子目录', '课程广告.md'), adArticle, 'utf8');

  // 与 goodArticle 内容相同的重名文件（测 md5 判重）
  fs.writeFileSync(path.join(inbox, 'USDC 与 Circle（副本）.md'), goodArticle, 'utf8');

  // 空文件
  fs.writeFileSync(path.join(inbox, '空文件.md'), '', 'utf8');

  const engine = new IngestEngine({ settings, vfs, paths, manifest, client });

  // 收集回调
  const started = [];
  const done = [];
  const res = await engine.processAll(
    ['wallabag/USDC 与 Circle.md', 'wallabag/子目录/课程广告.md', 'wallabag/USDC 与 Circle（副本）.md'],
    {
      onStart: (rel) => started.push(rel),
      onDone: (r) => done.push(r),
    },
  );

  // -------------------------------------------------------------------------
  // 断言：基础流程
  // -------------------------------------------------------------------------
  eq(res.length, 3, '处理了 3 篇');
  eq(started.length, 3, 'onStart 回调 3 次');
  eq(done.length, 3, 'onDone 回调 3 次');

  const bySrc = new Map(res.map((r) => [r.src, r]));
  eq(bySrc.get('wallabag/USDC 与 Circle.md').status, 'compiled', '正常文章被编译');
  eq(bySrc.get('wallabag/子目录/课程广告.md').status, 'skip', '广告被跳过');
  eq(bySrc.get('wallabag/USDC 与 Circle（副本）.md').status, 'already', '重复内容被跳过');

  // 归档：按日期分子目录
  const dateStr = core.todayStr();
  const archivedPath = path.join(archiveDir, dateStr, 'USDC 与 Circle.md');
  ok(fs.existsSync(archivedPath), '原文已归档到 <归档>/<日期>/');
  eq(fs.readFileSync(archivedPath, 'utf8'), goodArticle, '归档内容与原文一致');
  ok(!fs.existsSync(path.join(inbox, 'USDC 与 Circle.md')), '收件箱里的原文已移走');
  ok(fs.existsSync(path.join(archiveDir, dateStr, '课程广告.md')), '广告也被归档');
  ok(fs.existsSync(path.join(inbox, 'USDC 与 Circle（副本）.md')), '重复文件留在收件箱（未误删）');

  // 编译产物
  const wikiRel = bySrc.get('wallabag/USDC 与 Circle.md').wikiRel;
  const wikiAbs = path.join(vaultDir, wikiRel);
  ok(fs.existsSync(wikiAbs), `Wiki 文章已生成：${wikiRel}`);
  ok(wikiRel.startsWith('Wiki/Wiki/稳定币与RWA/'), '文章落在 <编译目录>/<主题>/ 下');

  const wikiText = fs.readFileSync(wikiAbs, 'utf8');
  ok(wikiText.startsWith('---\n'), '文章带 frontmatter');
  ok(wikiText.includes('title: "USDC 清算路径与 Circle 收入结构"'), 'frontmatter.title 正确');
  ok(wikiText.includes('topic: "稳定币与RWA"'), 'frontmatter.topic 正确');
  ok(wikiText.includes(`source: "${archivedPath}"`), 'frontmatter.source 指向归档后的绝对路径');
  ok(wikiText.includes('raw: "[[Wiki/raw/稳定币与RWA/USDC 与 Circle.md]]"'), 'frontmatter.raw 是 vault 内双链');
  ok(wikiText.includes('status: ok'), 'frontmatter.status = ok');
  ok(wikiText.includes('## 概述') && wikiText.includes('See Also'), '正文结构完整');

  // raw 存档
  const rawAbs = path.join(vaultDir, 'Wiki/raw/稳定币与RWA/USDC 与 Circle.md');
  ok(fs.existsSync(rawAbs), 'raw 原文存档已写入');
  eq(fs.readFileSync(rawAbs, 'utf8'), goodArticle, 'raw 存档内容与原文逐字一致');

  // 概念页
  const conceptAbs = path.join(vaultDir, 'Wiki/Concepts/USDC.md');
  ok(fs.existsSync(conceptAbs), '概念页已创建');
  const conceptText = fs.readFileSync(conceptAbs, 'utf8');
  ok(conceptText.includes('type: concept'), '概念页带 type: concept');
  ok(conceptText.includes('## 要点'), '概念页有要点段');
  ok(conceptText.includes('[[Circle]]'), '概念页有相关双链');

  // 台账
  const manifestText = fs.readFileSync(path.join(vaultDir, 'Wiki/_state/manifest.json'), 'utf8');
  const manifestData = JSON.parse(manifestText);
  ok(manifestData.done['wallabag/USDC 与 Circle.md'], 'manifest 记录了处理项');
  const entry = manifestData.done['wallabag/USDC 与 Circle.md'];
  eq(entry.topic, '稳定币与RWA', 'manifest.topic 正确');
  eq(entry.wiki, wikiRel.replace('Wiki/', ''), 'manifest.wiki 用相对 Wiki 根的口径');
  eq(entry.raw, 'raw/稳定币与RWA/USDC 与 Circle.md', 'manifest.raw 用相对 Wiki 根的口径');
  ok(entry.hash && entry.hash.length === 32, 'manifest 记录了 md5');
  ok(entry.archived_to === archivedPath, 'manifest.archived_to 记录归档绝对路径');
  ok(manifestData.done['wallabag/子目录/课程广告.md'], '跳过项也记账');

  // 索引
  const indexText = fs.readFileSync(path.join(vaultDir, 'Wiki/_index.md'), 'utf8');
  ok(indexText.includes('# Wiki Index'), '索引已生成');
  ok(indexText.includes('## 稳定币与RWA（1）'), '索引按主题分组');
  ok(indexText.includes('[[USDC 清算路径与 Circle 收入结构]]'), '索引里有文章双链');

  // 日志
  const logText = fs.readFileSync(path.join(vaultDir, 'Wiki/_log.md'), 'utf8');
  ok(logText.includes('**ingest**'), '日志记录 ingest');
  ok(logText.includes('**skip**'), '日志记录 skip');

  // -------------------------------------------------------------------------
  // 第二篇相同主题文章 → 走 update（mock 不返回 merge_target，走新建 + 后缀）
  // -------------------------------------------------------------------------
  fs.writeFileSync(path.join(inbox, 'USDC 另一篇.md'),
    '# 另一篇\n\n2026 年 USDC 储备构成变化。\n', 'utf8');
  const engine2 = new IngestEngine({ settings, vfs, paths, manifest, client });
  await engine2.manifest.load();
  const r2 = await engine2.processOne('wallabag/USDC 另一篇.md');
  eq(r2.status, 'compiled', '新文章编译成功');
  ok(fs.existsSync(path.join(vaultDir, r2.wikiRel)), '第二篇也落盘');
  ok(r2.wikiRel.endsWith('USDC 清算路径与 Circle 收入结构-1.md'), '同名文章自动加后缀，不覆盖旧文');

  // 概念页应被合并（要点去重 + 追加相关）
  const conceptText2 = fs.readFileSync(conceptAbs, 'utf8');
  const pointCount = (conceptText2.match(/^- 储备以现/gm) || []).length;
  eq(pointCount, 1, '概念页要点去重（未重复追加同一要点）');

  // -------------------------------------------------------------------------
  // 空文件 → 仅归档
  // -------------------------------------------------------------------------
  const engine3 = new IngestEngine({ settings, vfs, paths, manifest, client });
  await engine3.manifest.load();
  const r3 = await engine3.processOne('wallabag/空文件.md');
  eq(r3.status, 'skip', '空文件被判 skip');
  ok(fs.existsSync(path.join(archiveDir, dateStr, '空文件.md')), '空文件被归档');
  ok(!fs.existsSync(path.join(inbox, '空文件.md')), '空文件已移走');

  // -------------------------------------------------------------------------
  // 收件箱之外的文件：默认不移动
  // -------------------------------------------------------------------------
  const noteRel = '笔记/普通笔记.md';
  fs.mkdirSync(path.join(vaultDir, '笔记'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, noteRel), '# 普通笔记\n\nUSDC 相关笔记正文。\n', 'utf8');
  const engine4 = new IngestEngine({ settings, vfs, paths, manifest, client });
  await engine4.manifest.load();
  const r4 = await engine4.processOne(noteRel);
  eq(r4.status, 'compiled', '收件箱外的笔记也能编译');
  eq(r4.moved, false, '返回值标注「原文未移动」');
  ok(fs.existsSync(path.join(vaultDir, noteRel)), '默认不移动收件箱之外的文件');
  const wiki4 = fs.readFileSync(path.join(vaultDir, r4.wikiRel), 'utf8');
  ok(wiki4.includes(`source: "${path.join(vaultDir, noteRel)}"`), 'source 指向原文件绝对路径');

  // -------------------------------------------------------------------------
  // 收件箱外被跳过的文章：记账但不移动（回归用例：skip 分支曾绕过开关）
  // -------------------------------------------------------------------------
  fs.mkdirSync(path.join(vaultDir, '外部'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '外部', '外部广告.md'),
    '# 限时优惠\n\n扫码加微信，课程只要 9.9 元。\n', 'utf8');
  const engine6 = new IngestEngine({ settings, vfs, paths, manifest, client });
  await engine6.manifest.load();
  const r6 = await engine6.processOne('外部/外部广告.md');
  eq(r6.status, 'skip', '收件箱外的广告被判 skip');
  eq(r6.moved, false, '跳过时同样不移动收件箱外的原文');
  ok(fs.existsSync(path.join(vaultDir, '外部', '外部广告.md')), '被跳过的外部原文仍在原处');
  ok(!fs.existsSync(path.join(archiveDir, dateStr, '外部广告.md')), '外部广告没有被搬进归档');

  // -------------------------------------------------------------------------
  // Anthropic 格式的请求构造
  // -------------------------------------------------------------------------
  const anthropicSettings = makeSettings({
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    authMode: 'auto',
    archiveFolder: archiveDir,
  });
  const anthropicClient = new LLMClient(anthropicSettings, mockRequestUrl);
  requests.length = 0;
  const ar = await anthropicClient.chat({ system: '分诊员测试', user: '你好', maxTokens: 100 });
  ok(typeof ar.text === 'string' && ar.text.length > 0, 'Anthropic 客户端能解析 content 数组');
  const lastReq = requests[requests.length - 1];
  eq(lastReq.url, 'https://api.anthropic.com/v1/messages', 'Anthropic 端点拼接正确');
  eq(lastReq.headers['x-api-key'], 'sk-test', 'Anthropic 用 x-api-key');
  eq(lastReq.headers['anthropic-version'], '2023-06-01', 'Anthropic 版本头');
  const arBody = JSON.parse(lastReq.body);
  ok(typeof arBody.system === 'string', 'Anthropic 请求体把 system 提升到顶层');
  eq(arBody.messages.length, 1, 'Anthropic 请求体只有一条 user 消息');

  // -------------------------------------------------------------------------
  // OpenAI 格式的请求构造
  // -------------------------------------------------------------------------
  const openaiSettings = makeSettings({ archiveFolder: archiveDir });
  const openaiClient = new LLMClient(openaiSettings, mockRequestUrl);
  requests.length = 0;
  await openaiClient.chat({ system: '分诊员测试', user: '你好', maxTokens: 100 });
  const oReq = requests[requests.length - 1];
  eq(oReq.url, 'https://api.openai.com/v1/chat/completions', 'OpenAI 端点拼接正确');
  eq(oReq.headers['Authorization'], 'Bearer sk-test', 'OpenAI 用 Bearer');
  const oBody = JSON.parse(oReq.body);
  eq(oBody.messages[0].role, 'system', 'OpenAI 请求体包含 system 消息');

  // -------------------------------------------------------------------------
  // 并发同名冲突：三篇内容不同但计划标题相同的文章必须各自落盘
  // -------------------------------------------------------------------------
  for (let i = 0; i < 3; i += 1) {
    fs.writeFileSync(path.join(inbox, `并发${i}.md`), `# 并发${i}\n\n独有的正文内容 ${i} ` + 'x'.repeat(200), 'utf8');
  }
  const engine5 = new IngestEngine({ settings, vfs, paths, manifest, client });
  const r5 = await engine5.processAll(['wallabag/并发0.md', 'wallabag/并发1.md', 'wallabag/并发2.md']);
  const wikiPaths = r5.map((r) => r.wikiRel);
  eq(new Set(wikiPaths).size, 3, '并发同名时三篇分配到三个不同路径');
  ok(wikiPaths.every((p) => p && fs.existsSync(path.join(vaultDir, p))), '三篇都真实落盘');
  ok(wikiPaths.filter((p) => /-\d+\.md$/.test(p)).length >= 2, '重名时自动加数字后缀');

  // -------------------------------------------------------------------------
  // 纯函数单测
  // -------------------------------------------------------------------------
  eq(resolveEndpoint('https://api.openai.com', 'openai'), 'https://api.openai.com/v1/chat/completions', 'endpoint: 裸域名');
  eq(resolveEndpoint('https://api.openai.com/v1/', 'openai'), 'https://api.openai.com/v1/chat/completions', 'endpoint: 带 /v1 与尾斜杠');
  eq(resolveEndpoint('https://api.anthropic.com', 'anthropic'), 'https://api.anthropic.com/v1/messages', 'endpoint: Anthropic 裸域名');
  eq(resolveEndpoint('https://api.minimaxi.com/anthropic', 'anthropic'), 'https://api.minimaxi.com/anthropic/v1/messages', 'endpoint: 第三方 anthropic 路径');
  eq(resolveEndpoint('http://localhost:11434/v1', 'openai'), 'http://localhost:11434/v1/chat/completions', 'endpoint: 本地 Ollama');
  eq(resolveEndpoint('https://x.com/api/paas/v4', 'openai'), 'https://x.com/api/paas/v4/chat/completions', 'endpoint: v4 路径');
  eq(resolveEndpoint('https://x.com/v1/chat/completions', 'openai'), 'https://x.com/v1/chat/completions', 'endpoint: 已是完整端点');
  eq(JSON.stringify(parseHeaderLines('X-A: 1\nX-B: 2\n# 注释\nbadline')), JSON.stringify({ 'X-A': '1', 'X-B': '2' }), '自定义请求头解析');

  // 文件名清洗与主题初判
  eq(core.cleanName('a/b:c*d?"e|.md'), 'a-b-c-d--e-.md', 'cleanName 替换非法字符');
  eq(core.cleanName('  trailing.  '), '  trailing', 'cleanName 只去尾部点与空格');
  eq(core.cleanName(''), 'untitled', 'cleanName 空名兜底');
  eq(core.cleanName('保留  连续空格.md'), '保留  连续空格.md', 'cleanName 不压缩连续空格');
  eq(core.guessTopic('稳定币监管新规'), '稳定币与RWA', '主题初判：稳定币');
  eq(core.guessTopic('完全无关的内容'), '其他', '主题初判：兜底其他');

  // JSON 宽松解析
  eq(core.parseJsonLoose('```json\n{"a":1}\n```').a, 1, 'parseJsonLoose 去围栏');
  eq(core.parseJsonLoose('说明文字 {"a":2} 结尾').a, 2, 'parseJsonLoose 截取大括号');
  eq(core.parseJsonLoose('{"a":1,}').a, 1, 'parseJsonLoose 修复尾逗号');

  // 截断
  const long = 'x'.repeat(1000);
  const t = core.truncateText(long, 100);
  ok(t.truncated && t.text.length < 300, 'truncateText 截断生效');
  eq(core.truncateText('short', 100).truncated, false, 'truncateText 短文本不截断');

  // 概念页合并
  const merged = require('../src/engine.js').mergeConceptPage(
    '# USDC\n\n## 要点\n- 已有要点一\n\n## 相关\n- [[Circle]]\n',
    { points: ['已有要点一', '新增要点二'], related: ['[[Circle]]', '[[Tether]]'] },
  );
  ok(merged.includes('新增要点二'), '概念页合并追加新要点');
  ok(!/新增要点二[\s\S]*新增要点二/.test(merged), '概念页合并不重复追加');
  ok(merged.includes('[[Tether]]'), '概念页合并追加新相关');
  ok((merged.match(/\[\[Circle\]\]/g) || []).length === 1, '概念页合并不重复相关链接');

  // -------------------------------------------------------------------------
  // 汇总
  // -------------------------------------------------------------------------
  console.log('');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log(' - ' + f));
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(2);
});

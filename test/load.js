'use strict';
/*
 * 加载测试：用 obsidian 桩加载打包产物 main.js，
 * 验证插件能初始化、渲染设置页、跑一次批处理、打开文件选择器。
 *
 * 运行：node test/load.js（需先 node build.js）
 */

// 把 require('obsidian') 指向本地测试桩（插件目录里没有真的 obsidian 包）
const Module = require('module');
const __origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'obsidian') {
    // 兼容两种放置方式：test/node_modules（插件目录内）与项目根 node_modules（开发目录）
    for (const candidate of [
      './stubs/obsidian.js',
      './node_modules/obsidian/index.js',
      '../node_modules/obsidian/index.js',
    ]) {
      try { return __origLoad.call(this, candidate, module, false); } catch (_) { /* 换下一个 */ }
    }
    throw new Error('找不到 obsidian 测试桩');
  }
  return __origLoad.call(this, request, parent, isMain);
};

const fs = require('fs');
const os = require('os');
const path = require('path');

const obsidian = require('obsidian');
const core = require('../src/core.js');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`); }

class FakeAdapter {
  constructor(basePath) { this.basePath = basePath; }
  getBasePath() { return this.basePath; }
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
    return { type: s.isDirectory() ? 'folder' : 'file', size: s.size, mtime: s.mtimeMs };
  }
}

const TRIAGE = {
  status: 'ok',
  topic: 'AI-Agent',
  title: '插件加载测试文章',
  summary: '验证插件装配与批处理',
  concepts: ['MCP'],
  merge_target: '',
  disputed: false,
  reason: '测试',
};
const COMPILE = {
  article: [
    '## 概述',
    '这是一篇用于验证 Obsidian 插件装配链路的测试文章，正文长度需要超过一百二十个字符，',
    '因此这里补充一些说明性文字，确保引擎不会把它判定为「编译结果过短」而中止。',
    '',
    '## 关键数据',
    '- 测试数据 1（原文写「1」）',
    '',
    '## 与已有知识的关联',
    '与 [[MCP]] 相连。',
    '',
    '## See Also',
    '- [[MCP]]',
  ].join('\n'),
  concepts: ['MCP'],
  concept_pages: [{
    name: 'MCP',
    aliases: ['Model Context Protocol'],
    definition: '连接模型与外部工具的开放协议。',
    points: ['通过 server 暴露工具'],
    related: ['[[AI-Agent]]'],
  }],
};

let failCompile = false;

function mockRequestUrl(payload) {
  const parsed = JSON.parse(payload.body);
  const sys = parsed.system || (parsed.messages && parsed.messages[0] && parsed.messages[0].content) || '';
  if (failCompile && !sys.includes('分诊员')) {
    // 复现真实故障：模型把原文片段当成了回复
    return Promise.resolve({
      status: 200,
      json: { choices: [{ message: { role: 'assistant', content: 'properties\nrepeat.standalone.mode=false\nbroadcaster.record.url=http://127.0.0.1:8001/facade/api/record/save' } }] },
      text: '',
    });
  }
  const data = sys.includes('分诊员') ? TRIAGE : COMPILE;
  return Promise.resolve({
    status: 200,
    json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(data) } }] },
    text: '',
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwi-load-'));
  const vaultDir = path.join(root, 'vault');
  const inbox = path.join(vaultDir, 'wallabag');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, '测试文章.md'),
    '# 测试文章\n\n这是一篇用于测试的文章正文，包含 MCP 相关内容。\n', 'utf8');

  const adapter = new FakeAdapter(vaultDir);
  const listMarkdownFiles = () => {
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        if (!ent.name.endsWith('.md')) continue;
        const rel = path.relative(vaultDir, full).split(path.sep).join('/');
        const f = new obsidian.TFile(rel);
        const st = fs.statSync(full);
        f.stat = { mtime: st.mtimeMs, size: st.size };
        out.push(f);
      }
    };
    walk(vaultDir);
    return out;
  };
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: () => null,
      getMarkdownFiles: listMarkdownFiles,
    },
    workspace: {
      on: () => ({ id: 'ref' }),
      getActiveFile: () => null,
    },
    fileManager: {
      renameFile: async () => {},
    },
  };

  obsidian.setRequestUrlImpl(mockRequestUrl);

  // ---- 1. 加载打包产物 ----
  const PluginClass = require('../main.js');
  ok(typeof PluginClass === 'function', 'main.js 导出插件类');
  ok(PluginClass.prototype instanceof obsidian.Plugin, '插件类继承 Plugin');

  const plugin = new PluginClass(app, { id: 'llm-wiki-ingest' });
  await plugin.onload();
  ok(true, 'onload 执行无异常');

  // ---- 2. 注册项 ----
  eq(plugin.commands.length, 5, '注册 5 条命令');
  const ids = plugin.commands.map((c) => c.id);
  ok(ids.includes('compile-active'), '有「编译当前文章」命令');
  ok(ids.includes('compile-picker'), '有「多选编译」命令');
  ok(ids.includes('compile-folder'), '有「编译目录」命令');
  ok(ids.includes('show-stats'), '有「统计」命令');
  ok(ids.includes('rebuild-index'), '有「重建索引」命令');
  eq(plugin.ribbons.length, 1, '注册 1 个 Ribbon 按钮');
  eq(plugin.settingTabs.length, 1, '注册设置页');
  ok(plugin._statusEl && plugin._statusEl.textContent === 'LLM Wiki', '状态栏已初始化');

  // ---- 3. 设置页可渲染 ----
  const tab = plugin.settingTabs[0];
  tab.display();
  ok(tab.containerEl.children.length > 0, '设置页渲染出内容');
  ok(tab.containerEl.children.length > 20, '设置项数量合理');

  // ---- 4. 默认设置生效 ----
  eq(plugin.settings.wikiRoot, 'Wiki', '默认 Wiki 根为 Wiki');
  eq(plugin.settings.wikiFolder, 'Wiki/Wiki', '默认编译目录为 Wiki/Wiki');
  eq(plugin.settings.apiFormat, 'openai', '默认 OpenAI 格式');

  // ---- 5. buildEngine 装配 ----
  plugin.settings.archiveFolder = path.join(root, 'archive');
  plugin.settings.maxConcurrency = 2;
  const engine = plugin.buildEngine();
  ok(engine && typeof engine.processAll === 'function', 'buildEngine 返回引擎');

  // ---- 6. 跑一次批处理 ----
  const before = obsidian.Notice.log.length;
  await plugin.runBatch(['wallabag/测试文章.md']);
  const notices = obsidian.Notice.log.slice(before);
  ok(notices.some((n) => n.includes('完成')), '批处理结束有完成提示：' + notices.join(' | '));

  const wikiRel = 'Wiki/Wiki/AI-Agent/插件加载测试文章.md';
  ok(fs.existsSync(path.join(vaultDir, wikiRel)), 'Wiki 文章已生成');
  ok(!fs.existsSync(path.join(inbox, '测试文章.md')), '收件箱原文已归档移走');
  ok(fs.existsSync(path.join(root, 'archive', ...core.todayStr().split('-'), '测试文章.md')), '归档文件存在');
  ok(fs.existsSync(path.join(vaultDir, 'Wiki/Concepts/MCP.md')), '概念页已生成');
  ok(fs.existsSync(path.join(vaultDir, 'Wiki/_index.md')), '索引已重建');
  const manifestData = JSON.parse(fs.readFileSync(path.join(vaultDir, 'Wiki/_state/manifest.json'), 'utf8'));
  ok(manifestData.done['wallabag/测试文章.md'], '台账已记录');
  ok(manifestData.done['wallabag/测试文章.md'].wiki === 'Wiki/AI-Agent/插件加载测试文章.md',
    '台账 wiki 字段口径正确');

  // ---- 7. 文件选择器可打开 ----
  fs.writeFileSync(path.join(inbox, '待选文章甲.md'), '# 甲\n\n正文\n', 'utf8');
  fs.writeFileSync(path.join(inbox, '待选文章乙.md'), '# 乙\n\n正文\n', 'utf8');
  obsidian.Notice.log.length = 0;
  const modalBefore = obsidian.Modal.instances.length;
  plugin.openPicker();
  eq(obsidian.Modal.instances.length, modalBefore + 1, '选择器 Modal 已创建');
  const picker = obsidian.Modal.instances[obsidian.Modal.instances.length - 1];
  ok(picker.opened, '选择器已打开');
  ok(picker.contentEl.children.length >= 3, '选择器渲染了搜索框、列表与底部栏');

  // ---- 8. 统计 ----
  obsidian.Notice.log.length = 0;
  await plugin.showStats();
  ok(obsidian.Notice.log.some((n) => n.includes('已处理')), '统计接口可用');

  // ---- 9. 重建索引 ----
  await plugin.rebuildIndexNow();
  ok(fs.existsSync(path.join(vaultDir, 'Wiki/_index.md')), '重建索引成功');

  // ---- 9.5 编译失败：记录失败项、给出重试入口、原文不被移动 ----
  fs.writeFileSync(path.join(inbox, '会失败的文章.md'), '# 会失败\n\n正文内容。\n', 'utf8');
  failCompile = true;
  const noticeBeforeFail = obsidian.Notice.log.length;
  await plugin.runBatch(['wallabag/会失败的文章.md']);
  const failModal = obsidian.Modal.instances[obsidian.Modal.instances.length - 1];
  eq(failModal.failed.length, 1, '失败项被记录');
  ok(failModal.retryBtn, '结果面板出现重试按钮');
  ok(String(failModal.retryBtn.textContent).includes('重试失败的 1 篇'), '重试按钮文案正确');
  ok(typeof failModal.retryBtn.onclick === 'function', '重试按钮可点击');
  ok(fs.existsSync(path.join(inbox, '会失败的文章.md')), '失败后原文仍在收件箱（未被移动）');
  ok(obsidian.Notice.log.slice(noticeBeforeFail).some((n) => n.includes('失败 1')), '完成提示里显示失败数');

  // 重试：只重跑失败项，这次让模型正常返回
  failCompile = false;
  await plugin.runBatch(['wallabag/会失败的文章.md']);
  const retryModal = obsidian.Modal.instances[obsidian.Modal.instances.length - 1];
  eq(retryModal.failed.length, 0, '重试成功后没有失败项');
  ok(!retryModal.retryBtn, '全部成功时不出现重试按钮');
  ok(fs.existsSync(path.join(vaultDir, 'Wiki/Wiki/AI-Agent/插件加载测试文章.md')), '重试产出了 Wiki 页面');
  ok(!fs.existsSync(path.join(inbox, '会失败的文章.md')), '重试成功后原文已归档');

  // ---- 10. 活动文件缺失时的保护 ----
  obsidian.Notice.log.length = 0;
  await plugin.compileActiveFile();
  ok(obsidian.Notice.log.some((n) => n.includes('请先打开一篇文章')), '无活动文件时给出提示');


  console.log('');
  console.log(`加载测试：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log(' - ' + f));
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('加载测试崩溃：', err);
  process.exit(2);
});

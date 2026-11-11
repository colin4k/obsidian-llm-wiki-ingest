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

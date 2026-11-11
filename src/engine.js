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

    // 空文件：只归档（同样遵守“是否移动收件箱外的原文”）
    if (!rawText.trim()) {
      const archived = this.shouldMoveSource(rel)
        ? await this.archiveSource(rel, { dateStr: day })
        : null;
      await this.recordSkip(rel, {
        hash, reason: '空文件，无内容', archived, dateStr: day, summary: '空文件',
      });
      return {
        src: rel,
        ok: true,
        status: 'skip',
        moved: Boolean(archived),
        message: archived ? '空文件：仅归档' : '空文件：已记账，原文未移动（不在收件箱）',
        ms: Date.now() - started,
      };
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
      const archived = this.shouldMoveSource(rel)
        ? await this.archiveSource(rel, { dateStr: day })
        : null;
      await this.recordSkip(rel, {
        hash, reason: triage.reason || '无实质内容', archived, dateStr: day,
        summary: triage.summary || '无实质内容，仅归档',
      });
      return {
        src: rel,
        ok: true,
        status: 'skip',
        topic,
        moved: Boolean(archived),
        message: archived
          ? (triage.reason || '无实质内容：仅归档')
          : `${triage.reason || '无实质内容'}；原文未移动（不在收件箱）`,
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

    const whereMoved = archivedAbs
      ? `原文 \`${archivedAbs}\``
      : '原文未移动（不在收件箱，见设置「收件箱之外的文件也移动归档」）';
    await this.appendLog(
      `- ${nowIso().slice(0, 16).replace('T', ' ')} **ingest**: [[${title}]] ` +
      `→ ${this.paths.toWikiRel(wikiRel)} · ${whereMoved}\n`,
    );

    return {
      src: rel,
      ok: true,
      status: mergeRel ? 'updated' : 'compiled',
      topic,
      title,
      wikiRel,
      archivedTo: archivedAbs,
      moved: Boolean(archivedAbs),
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
      `(${reason || '无实质内容'})` +
      `${archived ? ` · 归档 \`${archived}\`` : ' · 原文未移动（不在收件箱）'}\n`,
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

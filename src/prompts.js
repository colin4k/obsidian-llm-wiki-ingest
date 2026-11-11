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

# LLM Wiki Ingest

Obsidian 插件：把剪藏文章**编译进 LLM Wiki 并归档**，流程对齐 `Wiki/AGENTS.md`
（Karpathy 的 LLM Wiki pattern —— 「Obsidian 是 IDE，LLM 是程序员，wiki 是代码库」）。

和仓库里 `Wiki/_scripts/pipeline.py` 的分工一致：**插件管搬东西和记账，LLM 管读懂和写作**。

---

## 功能

- **单篇**：阅读某篇文章时，Ribbon 图标 / 命令 / 右键菜单一键「编译并归档」
- **多篇**：命令面板「选择多篇文章编译」，勾选后逐一处理
- **整目录**：右键文件夹 →「LLM Wiki：编译此目录」，或命令「编译当前文章所在目录」
- **LLM 接入**：OpenAI 与 Anthropic 两种接口格式，Base URL / Key / 模型 / 温度 / 超时 /
  并发 / 自定义请求头都可配，带「测试连接」
- **路径可配**：归档目录（支持 vault 外置盘绝对路径）、Wiki 知识库根、编译文章目录、
  概念页目录、raw 原文目录、状态目录
- **台账兼容**：读写同一个 `_state/manifest.json`，与定时任务不会重复处理同一篇
- **失败可重试**：结果面板列出失败项，点「重试失败的 N 篇」只重跑出错的那几篇；
  失败时原文不会被移动，raw / Wiki 也不会留下半成品

一篇的处理流程（对应 AGENTS.md 的 Ingest 五步）：

```
原文 → md5 判重 → LLM 分诊（New/Update/Disputed/Skip）
     → LLM 编译（Wiki 文章 + 概念页）
     → 写 raw/ 原文存档 → 写 Wiki/<主题>/<标题>.md
     → 概念页补充要点 → 原文移入归档目录
     → 更新 manifest 台账 → 追加 _log.md → 重建 _index.md
```

---

## 安装

```bash
git clone git@github.com:colin4k/obsidian-llm-wiki-ingest.git
cd obsidian-llm-wiki-ingest

node build.js      # 从 src/ 生成单文件 main.js
./install.sh       # 复制到 <Vault>/.obsidian/plugins/llm-wiki-ingest/
```

`install.sh` 默认安装到
`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/ColinVault`，
可用环境变量覆盖：`OBSIDIAN_VAULT=/path/to/Vault ./install.sh`。

然后在 `<Vault>/.obsidian/community-plugins.json` 里加入 `"llm-wiki-ingest"`，
重启 Obsidian（或「重新加载应用」），在 **设置 → 第三方插件** 里确认已启用。

首次使用前，到 **设置 → LLM Wiki Ingest** 配好接口参数，点「测试连接」。

---

## 配置要点

### LLM 接入

| 字段 | 说明 |
|---|---|
| 接口格式 | `OpenAI 格式`（`/chat/completions`）或 `Anthropic 格式`（`/messages`） |
| 接口地址 | 填域名、`/v1`，或完整端点都行；下方实时显示「实际请求地址」 |
| API Key | 保存在本插件 `data.json` |
| 模型 | 例如 `gpt-4o`、`claude-sonnet-4-5`、`MiniMax-M2.7-highspeed` |
| 鉴权方式（仅 Anthropic） | 官方用 `x-api-key`；多数第三方兼容网关用 `Bearer`，`auto` 会按域名判断 |
| 最大输出 tokens | 编译正文 800–2500 字，建议 ≥ 8192 |
| 并发数 | 1–8。块耗时主要由最慢一篇决定，3–5 比较划算 |
| 补充指令 | 追加到分诊/编译提示词末尾，可用来固定术语表或写作口味 |

地址补全规则：末段是版本号（`v1`/`v4` 等）就直接接端点，否则补 `/v1/...`。
例如 `https://api.openai.com` → `https://api.openai.com/v1/chat/completions`。

### 路径

| 字段 | 默认 | 说明 |
|---|---|---|
| 收件箱目录 | `wallabag` | 待处理剪藏，含子目录一起扫描 |
| Wiki 知识库根 | `Wiki` | `raw/`、`Concepts/`、`_state/`、`_index`、`_log` 都在这下面 |
| 编译后文章目录 | `Wiki/Wiki` | 编译产出的文章保存位置 |
| 概念页目录 | `Wiki/Concepts` | 原子概念页 |
| 原文存档目录 | `Wiki/raw` | 不可变原文副本（事实核验依据） |
| 状态目录 | `Wiki/_state` | `manifest.json` 台账 |
| 归档目录 | `/Volumes/YSS-3/Wallabag-Archived` | 处理完的原文移动到这里；可填 vault 内相对路径 |
| 按日期分文件夹 | 开 | 归档到 `<归档目录>/YYYY-MM-DD/` |

> 归档目录若在 `/Volumes/...` 下且磁盘未挂载，插件会**直接报错中止**，
> 不会把文件写到错误位置（与 `pipeline.py` 行为一致）。

### 行为

- **跳过重复内容**：按 md5 判重，改名重投不会重复编译
- **处理完移动收件箱原文**：关闭后只编译不移动
- **收件箱之外的文件也移动归档**：默认关闭。在普通笔记上右键编译时，笔记不会被挪走
- **更新概念页 / 重建索引 / 追加日志**：可分别关闭

---

## 与定时任务的关系

插件和定时任务共用 `_state/manifest.json`：

- 台账里有同内容（md5 相同）的文章，插件直接判「重复」跳过，不会重复编译；
- 反之定时任务的 `discover` 也会跳过插件处理过的内容；
- 两边同时跑时，可能有一方遇到「源文件不存在」——不会重复处理，只是那一条会报错。

想彻底避免，可只保留一种方式（插件手动处理，或定时任务后台跑）。

---

## 目录结构

```
obsidian-llm-wiki-ingest/
├── manifest.json     插件清单
├── main.js           单文件构建产物（Obsidian 加载的就是它）
├── styles.css
├── build.js          打包脚本：node build.js
├── install.sh        安装到 Obsidian 插件目录
├── src/              源码（改这里，然后重新 build）
│   ├── core.js       常量 / 工具 / VaultFS / 路径 / 台账
│   ├── llm.js        OpenAI + Anthropic 客户端
│   ├── prompts.js    分诊与编译提示词
│   ├── engine.js     摄入流水线
│   └── main.js       插件入口 + UI
└── test/
    ├── run.js           引擎离线测试（假 adapter + 假 LLM）
    ├── load.js          加载/装配测试
    └── stubs/obsidian.js  obsidian API 桩（仅测试用）
```

改源码后：

```bash
node build.js        # 生成 main.js
node test/run.js     # 引擎测试
node test/load.js    # 加载测试
```

`test/`、`build.js`、`install.sh` 不参与运行时，删掉也不影响插件。

---

## 设计取舍

- **两段式调用**：先分诊再编译。分诊时把「已有文章 + 已有概念页」喂给模型，
  它才能判断是新建还是合并；一次调用做不到这件事。
- **frontmatter 由程序写**：`title/topic/source/raw/generated/status/concepts`
  都由插件生成，避免模型写错路径或漏字段。模型只负责 `article` 正文。
- **先写后移**：raw 存档、Wiki 文章都写成功后，才移动原文；
  任何一步失败原文都还在原处，可以重试。
- **规范化文件名**：与 `pipeline.py` 的 `clean_name` 一致（不压缩连续空格，
  否则 frontmatter 里的 `raw` 双链会断）。

# AI 侧边栏：现状盘点与 GitHub 借鉴清单

> 调研日期：2026-11-26。星数与许可证取自 GitHub API 当日数据。

## 一句话结论

这个侧栏在「阅读场景 + 已读边界」这件事上已经比绝大多数开源阅读器做得细；
真正缺的不是功能数量，而是**答案可信度的闭环**（引用只校验了 id，没校验话是不是原文说的）、
**检索的第二条腿**（现在强依赖用户自配 embedding），以及**消息级交互**（不能复制/重问/追问）。

## 一、现状盘点

### 已经能打的
- 已读前沿由代码夹住，不靠提示词（`aiAgent.ts` 头注释、`aiEvidenceRetrieval.ts`）。
- 双通道问答：`agent`（多轮、自己调工具）与 `evidence`（单轮、结论绑定引用），边界清晰。
- 预算前置：发送前给章/段/字数/token 估算，超预算要确认（`AiBudgetConfirm.vue`、`aiBudget.ts`）。
- 记忆可纠错：单条改说明、标记不准确、从来源章重建、存疑标签（`Reader.vue` 记忆页签）。
- 结果落盘失败有重试态；正文变了给 `stale` 提示；自动整理有月度 token 上限。
- 划词提问能定位回原文区间，并把回答存成该段批注（`askSelectedText` / `saveAnswerAsSelectionNote`）。

### 缺口（按影响排序）
1. **引用只验坐标，不验内容**。`parseEvidenceAnswer` 只保证 citationIds 在白名单里；
   模型完全可能给出「结论 A + 一段其实不支持 A 的原文」。页面上写着「引用位置已校验」，
   读者会误以为内容也校验过。
2. **没有 embedding 就没有语义检索**。`semanticSearch.ts` 要求用户自己配向量服务地址/模型/Key；
   没配时只能走关键词/索引，长书「找原文」体验断崖。
3. **消息级操作缺失**。没有复制、重问、编辑重发、分支、单条删除；流式过程只有一行工具活动文字。
4. **一本书只有一个会话**。`ai.getChat(bookId)` + 「清空聊天」，不能同时开「人物线」「这条伏笔」两个线程。
5. **引用不是内联角标**。结论下面是按钮列表，正文里没有 `[1]`，长回答要来回对照。
6. **侧栏是固定 420px**，不能拖；页签之上又叠了一块「现在可以做什么」工作台，入口重复。
7. **记忆只有列表/时间线，没有关系图**。人物关系是数据结构里现成的，但没有可视出口。
8. **前情提要是平铺摘要**，长篇到后期，「整本前情」的 token 与信息密度会同时失控。

## 二、值得借鉴的项目

### A. 同题不同解（最该先看）

| 项目 | 星 | 许可 | 抄什么 |
|---|---|---|---|
| [Jatin-Roopchandani/LORE](https://github.com/Jatin-Roopchandani/LORE) | 56 | MIT | 和你几乎同一个命题：每句引用原文、绝不超过已读章。它的问答是 8 步流水线：检索 → 图遍历 → 拼证据（按相关度、封顶 12000 字）→ 生成 claims（每条带**逐字引文**）→ **代码校验引文确实在该段** → **一次批量 judge 判断该段是否支持该结论** → 不支持就删，全删就拒答。另外它明确区分 4 种回答模式（graph / vector-fallback / empty / baseline），降级要**说出来**。消歧也值得抄：一个简称同时对上多个人时，**分组提问 + 允许答 none**，不做两两判断（它实测两两会把父亲并进两个儿子）。 |
| [readest/readest](https://github.com/readest/readest) | 26.7k | AGPL-3.0 | 阅读器侧栏的信息密度与「翻译/摘要」入口摆法；只看交互，别贴代码。 |
| [koodo-reader/koodo-reader](https://github.com/koodo-reader/koodo-reader) | 29.0k | AGPL-3.0 | 同上，它的 AI 翻译/词典/摘要/百科四个动作的组织方式。 |
| [edrlab/thorium-reader](https://github.com/edrlab/thorium-reader) | 3.0k | BSD-3-Clause | 许可友好，Readium 系阅读器的标注/朗读/目录实现可以直接读。 |

### B. 检索与记忆

| 项目 | 星 | 许可 | 抄什么 |
|---|---|---|---|
| [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) | 40.8k | MIT | **无向量库的推理式检索**：给文档建层级树索引，让模型在树上「翻目录」找该读哪节，再给行级引用。你的书本来就有章/卷结构，天生适配；可作为 embedding 未配置时的兜底，也常常比相似度更准（相似 ≠ 相关）。 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 33.1k | Apache-2.0 | 带时间有效性的知识图谱：边有 `valid_at / invalid_at`。伏笔、人物状态、关系都能变成「第 X 章起成立、第 Y 章失效」，比现在的平铺时间线更可查。 |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | 40.9k | MIT | 图谱 + 向量双层的工程实现，比微软 GraphRAG 轻得多，适合本地跑。 |
| [parthsarthi03/raptor](https://github.com/parthsarthi03/raptor) | 1.8k | MIT | 层级摘要树：章摘要 → 卷摘要 → 全书摘要，递归聚类再摘要。正解「整本前情」的 token 爆炸。 |
| [booknlp/booknlp](https://github.com/booknlp/booknlp) | 951 | MIT | 小说专用 NLP：人物识别、别名归并、共指、引语归属。拿它对照你的记忆抽取 prompt，能补「谁说的这句话」这类目前抽不出来的字段。 |
| [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern) | 36.1k | AGPL-3.0 | lorebook / world info 的注入机制：关键词触发、指定插入深浅、递归触发、token 预算裁剪。你的「人物/伏笔」目前是整包给模型，可以改成按问题触发、按预算裁剪。 |

### C. 侧栏交互（Vue 生态直接能参照）

| 项目 | 星 | 许可 | 抄什么 |
|---|---|---|---|
| [wzc520pyfm/ant-design-x-vue](https://github.com/wzc520pyfm/ant-design-x-vue) | 1.8k | MIT | Ant Design X 的 Vue 移植。Bubble / Sender / 思考链 / 来源卡片这套对话原子，正好补你缺的消息级交互。用 naive-ui 也不冲突，照结构自己写即可。 |
| [element-plus-x/Element-Plus-X](https://github.com/element-plus-x/Element-Plus-X) | 1.5k | MIT | 同类，组件化更激进（气泡列表、打字机、附件、会话列表）。 |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | 13.4k | MIT | React 库，但**设计规格**最完整：消息动作、工具调用 UI、审批卡片、分支。抄形态不抄码。 |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) | 39.0k | MIT | 应用内 copilot 的「上下文挂载 + 可交互 UI」范式。 |
| [continuedev/continue](https://github.com/continuedev/continue) | 36.6k | Apache-2.0 | `@` 上下文提供者的交互范式：把「本章 / 某人物 / 我的批注 / 记忆条目」做成可挂载的 context chip，而不是靠模型猜。 |
| [n4ze3m/page-assist](https://github.com/n4ze3m/page-assist) | 8.4k | MIT | 网页内 AI 侧栏：当前页上下文注入、选区动作、本地模型。和你的内置浏览器场景高度重合。 |
| [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook) | 42.2k | MIT | NotebookLM 的开源实现：资料 / 笔记 / 生成物三段式信息架构，引用回到源、笔记是一等公民。你的「前情/记忆/问答/笔记/输出」可以照它的层级重排。 |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | 68.6k | MIT | 引用开关、引用密度、来源预览这些「可信度旋钮」的产品化。 |

### D. 平台级参考（看架构，不落地）

[RAGFlow](https://github.com/infiniflow/ragflow) 94.7k / Apache-2.0、[kotaemon](https://github.com/Cinnamon/kotaemon) 25.9k / Apache-2.0、[open-webui](https://github.com/open-webui/open-webui) 159.5k、[LibreChat](https://github.com/LibreChat-AI/LibreChat) 47.5k / MIT、[Dify](https://github.com/langgenius/dify) 161.9k。
前两个看「文档问答 + 引用到页/段」的检索编排与 UI；后几个看会话管理、多模型、MCP 工具面板的边界。

## 三、按性价比排的改法

1. **消息级操作条**（小）：复制、重问、编辑重发、单条删除；流式期把工具调用做成可折叠的思考链。纯前端，最快见效。
2. **引用内联角标**（小）：结论里的 `[1]` 可点，滚动到原文并高亮该段；列表保留在下方。
3. **答案忠实度二次校验**（中，收益最大）：生成时要求每条结论附**逐字引文**，代码校验引文存在于该段，再用一次批量 judge 判「这段是否支持这条结论」，不支持就删；judge 失败要说「未运行校验」，不能假装通过。照 LORE 的第 7、8 步。
4. **上下文 chips**（中）：输入框上方挂「@本章 / @某人物 / @我的批注 / @记忆」，显式告诉模型看什么，省 token 也更准。
5. **章节树检索兜底**（中高）：用 PageIndex 思路给每本书建「卷 → 章 → 段」树，embedding 没配或相似度太低时，让模型在树上推理选章。
6. **前情摘要树**（中高）：卷级摘要复用章摘要生成，刷新前情只读「卷摘要 + 最近 N 章」，长篇不再线性膨胀。
7. **人物关系图 + 时间轴**（中高）：记忆里已有 relations，做力导向图（或复用现有 maplibre 画布），点节点看「第几章起成立」，边带 valid 区间。
8. **侧栏可拖宽 + 页签收敛**（小）：去掉与页签重复的「工作台」，把配额/用法收进折叠区（现在已经折了一部分）。

## 四、别抄的

- 不要把 150 个 MCP 频道铺进侧栏。你的设计文档已经把它们放在 agent 侧，侧栏只该暴露 5 个以内的高频动作。
- 不要做多模型并排对比。阅读场景里这是噪声，不是决策依据。
- 不要引入 AGPL 代码（koodo、readest、SillyTavern、obsidian-copilot）。看交互与架构可以，复制实现会把整个项目拖进 AGPL。
- 不要为了「像 Cursor」而加聊天式补全。这本书的正文不是代码，行内 ghost text 没意义。

## 五、许可证速查

- 可直接借鉴实现：LORE、PageIndex、LightRAG、RAPTOR、booknlp、graphiti、Assistant UI、Ant Design X Vue、Element-Plus-X、Continue、page-assist、open-notebook、AnythingLLM、kotaemon、RAGFlow、LibreChat（MIT / Apache-2.0）。
- 只可看思路：koodo-reader、readest、SillyTavern、obsidian-copilot（AGPL-3.0）；thorium-reader 是 BSD-3，可以看代码。

## 六、划词工具栏 × 侧边栏：交接设计

### 现状
- `readerSelection.ts` 定义 11 个动作，默认钉 `ask / translate / chat`，菜单里有分隔线（文稿类 / AI 类）和模型选择器。
- `readerInlineAsk.ts` 做了「行内一问一答 → 在侧边栏继续」的交接，走 `agent` 通道，卡片不落盘。这就是 Sider 那套。
- 交接时只搬 `question / answer` 两段文本（`handOff` 里 flatMap 成 user/assistant），**选区坐标没进对话**。
- `askSelectedText` 走另一条路：把引文拼进 `chatInput`（`问题 + 「excerpt」`），`selectionNoteTarget` 只保一轮。
- `AiEvidenceChatMessage` 只有 `role / content / citations / claims / uptoChapterId / stopped`，没有上下文锚点；侧栏也没有「正在讨论哪一段」的状态条。

### 结论
缺的不是入口，是**上下文对象**这一层。现在选区是以「文本」形态流动的：
可被用户误删、发出去就丢坐标、追问时锚点已经没了。

### 参考

| 参考 | 许可 | 抄什么 |
|---|---|---|
| [continuedev/continue](https://github.com/continuedev/continue) | Apache-2.0 | 选区进 composer 是 **context item**（带文件 + 行区间，可单独删除），不是一段粘贴文本；`@` 挂载各类上下文；内联编辑出 diff 再应用。 |
| [glowingjade/obsidian-smart-composer](https://github.com/glowingjade/obsidian-smart-composer) | MIT | 上下文 badge + AI 编辑结果以 diff 呈现，Apply / Discard；「一键编辑」与对话共用同一套上下文。 |
| [logancyang/obsidian-copilot](https://github.com/logancyang/obsidian-copilot) | AGPL-3.0 | Quick Ask 浮层与聊天面板的衔接方式（只看交互）。 |
| [MuiseDestiny/zotero-gpt](https://github.com/MuiseDestiny/zotero-gpt) | AGPL-3.0 | 文献阅读器里「段落/页码坐标 + 侧栏追问」的范式，和你的章/段坐标最像。 |
| [chatboxai/chatbox](https://github.com/chatboxai/chatbox) | GPL-3.0 | 引用历史消息成 quote 条再追问，追问链不丢上下文。 |
| Notion AI / Readwise Ghostreader | 商业 | 选区在面板里变成固定的引用块，追问始终锚在它上面，并提供「回到原处」。 |

### 动作分工（三层，别都进侧栏）

| 层 | 判据 | 举例 | 落点 |
|---|---|---|---|
| 就地 | 答案只依赖选中这几行、1 屏内 | 复制、朗读、词典、单句翻译 | 浮层 |
| 预览写回 | 要改正文，必须先看结果 | 整段翻译替换、清正文、润色 | 浮层里 diff → 应用（进 undo） |
| 侧栏 | 要跨章检索、要给引用、要多轮、要花预算 | 询问 AI（追问）、解释这段、这个人物是谁、之前发生了什么 | 抽屉 |

判据一句话：**答案可能引用别处 → 侧栏；只依赖选区 → 就地。**

### 改法（按顺序）

**1. 加一层 context item，随消息落盘**

```ts
export interface ChatContextItem {
  kind: 'selection' | 'chapter' | 'memory' | 'note'
  chapterId: string
  chapterTitle: string
  start?: number      // 仅 selection：规范化正文字符区间
  end?: number
  excerpt?: string    // 仅 selection：发送时重算段号
  label: string       // 气泡里显示「第 12 章 · 第 3 段」
}

export interface AiEvidenceChatMessage {
  role: 'user' | 'assistant'
  content: string
  context?: ChatContextItem[]   // 新增
  // ...原有字段
}
```

输入框上方渲染成可删 chips；发送时把 items 拼成独立的 system 块（带坐标与章名），
`content` 只留用户真正说的话。这样历史恢复时锚点还在，点 chip 能跳回原文。

**2. 侧栏状态条**
抽屉顶部一条：`正在讨论 · 第 12 章第 3 段「……」` ＋ `回到选区` ＋ `×`。
换选区时要么替换锚点，要么提示「另开一个问题」，别静默覆盖。

**3. handoff 带上 item**
`handOff(turns, contextItem)`：行内卡转侧栏时把选区一并交接，而不是只搬文本。

**4. 引用点击后能「就这段继续问」**
现在点引用只跳原文。补一个浮层/按钮：以该段为锚点开新追问——读者从答案回到原文后，往往正想问下一句。

**5. 写回闭环补全**
已有「存为这段的批注」。可再加：`替换选区`（翻译/清正文，先 diff）、`并入本章笔记`（带出处）。

**6. 快捷键**
`Alt+1..3` 直接执行钉住的三个动作；`Esc` 关浮层；浮层里 `Enter` 发送。

### 坑
- 别把引文拼进 `content`：模型会把它当读者说的话，用户也能误改，改完坐标对不上。
- 坐标别缓存太久：换字号、清正文、重排都会让 `start/end` 失效，发送时按规范化正文重算。
- 行内卡不要长出多轮对话，否则就是第二个侧栏。
- 「解释这段」「这个人物是谁」「之前发生了什么」应共用一种上下文格式，否则三条路径三种行为，测试也难写。

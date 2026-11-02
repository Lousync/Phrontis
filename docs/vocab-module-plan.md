# 背单词模块（v3.17.0）实施方案

> 目标：把 qwerty-learner 的打字背单词体验集成进 Phrontis，并让全局 AI 助手能读取「今天 + 近 7 天错词」进行造句复习。
> 决策：内置模块 + 独立 `vocab://` 协议 + 静态构建 iframe；Vault JSON 主账本 + IndexedDB 明细缓存。
> 本文是落地前的唯一方案文档；实现完成后再补验收记录。

## 1. 需求边界

### 要做

- 左侧书签「背单词」+ 桌面磁贴 + 命令面板入口。
- 嵌入 qwerty-learner 的完整打字背单词体验（词库 / 跟打 / 默写 / 错题本 / 统计）。
- 每章结束把「今天背了哪些词、释义、错次、词库/章节」写入 Vault。
- 全局 AI 助手可自然语言查询这些词并造句复习：
  - 范围：今天背过的词 + 近 7 天错词。
  - 默认题型：中译英造句 + 填空各一半，一组 5 题；先出题，用户作答后再批改。
- 所有数据本地；不引入云端依赖，不保留 qwerty-learner 的 mixpanel / Vercel Analytics 上报。

### 不做（本期）

- 不把 qwerty-learner 的 Dexie 明细（逐字母时序 / 图表）搬进 Vault。
- 不重写 qwerty-learner 为 React 19 / Tailwind 4 原生模块。
- 不做插件版（插件 iframe 是 opaque origin，localStorage/IndexedDB 不可用）。
- 不做移动端适配（沿用上游桌面端体验）。

## 2. 总体结构

```
┌──────────────────────────────────────────────────────────────┐
│ Phrontis 渲染层                                              │
│  src/modules/vocab/index.tsx                                 │
│   ├─ <iframe sandbox="allow-scripts allow-same-origin ..."   │
│   │        src="vocab://app/index.html?embed=1&nonce=...">    │
│   └─ postMessage 桥：ready / session / init                  │
└──────────────────────────┬───────────────────────────────────┘
                           │ window.api.vocab.*
┌──────────────────────────▼───────────────────────────────────┐
│ 主进程                                                       │
│  electron/database/repositories/vocabRepo.ts                 │
│   └─ phrontis-core/src/kbStore/vocabVaultRepo.ts             │
│        └─ .knowbase/modules/vocab/days/YYYY-MM-DD.json       │
│  electron/lib/builtinTools.ts → builtin.vocab.words          │
└──────────────────────────────────────────────────────────────┘
```

qwerty-learner 静态构建产物由 `scripts/build-vocab.mjs` 生成到 `resources/vocab/`，打包时经 `extraResources` 落到 `process.resourcesPath/vocab`。

## 3. Vault 数据

### 3.1 目录

```
.knowbase/modules/vocab/
  days/2026-11-02.json
  meta.json
```

本期不做 `words.json` 累计索引：AI 查询只读最近 7 天日文件，量小且天然幂等。后续需要全量统计时再加派生索引。

### 3.2 日文件

```json
{
  "date": "2026-11-02",
  "sessions": [
    {
      "id": "cet4:3:1762000000",
      "dict": "cet4",
      "dictName": "CET-4",
      "chapter": 3,
      "startedAt": "2026-11-02T09:12:00+08:00",
      "finishedAt": "2026-11-02T09:15:30+08:00",
      "wordCount": 20,
      "correctCount": 18,
      "wrongCount": 2,
      "durationSec": 210,
      "words": [
        {
          "word": "abandon",
          "trans": "v. 放弃；抛弃",
          "phonetic": "/əˈbændən/",
          "dict": "cet4",
          "chapter": 3,
          "correctCount": 2,
          "wrongCount": 1
        }
      ]
    }
  ],
  "words": [
    {
      "word": "abandon",
      "trans": "v. 放弃；抛弃",
      "phonetic": "/əˈbændən/",
      "dict": "cet4",
      "chapter": 3,
      "correctCount": 2,
      "wrongCount": 1,
      "firstSeenAt": "2026-11-02T09:12:30+08:00",
      "lastSeenAt": "2026-11-02T09:15:20+08:00"
    }
  ],
  "updatedAt": "2026-11-02T09:15:31+08:00"
}
```

- `sessions[].words` 保留每个会话的单词增量；`words` 由所有 session 重新聚合。
- 写盘时先替换同 id 的 session，再全量重算 `words` ⇒ 重复发送同一会话天然幂等。
- 单词聚合键 = `${dict}::${word}`；`trans`/`phonetic` 取最新非空值；`chapter` 取最新会话；`firstSeenAt` 取最早，`lastSeenAt` 取最晚。

### 3.3 写入规则

- 用 `writeJsonOrThrow`，写失败必须抛错，不能静默。
- 写后 `broadcastDataChanged('vocab')`。
- `date` 必须是 `YYYY-MM-DD`；非法输入直接拒绝。

## 4. 渲染层模块

### 4.1 入口注册

- `src/types/index.ts`：`TabName` 加 `'vocab'`。
- `src/lib/appModules.ts`：`{ id: 'vocab', label: '背单词', bar: false, tile: true, palette: true }`，排在 `accounting` 后。
- `src/lib/workbenchLayout.ts`：
  - `RailModule` 加 `'vocab'`；
  - `WORKBENCH_BOOKMARKS` 加 `{ key: 'vocab', label: '背单词', tab: 'vocab' }`；
  - `BOOKMARK_COLORS` 加青绿色；
  - `RAIL_FOLLOW_MAP` 加 `vocab: 'vocab'`。
- `WorkbenchLeftPanel` / `WorkbenchPageBar` / `desktop/tiles.tsx` 补图标与描述。
- `App.tsx` 加 `VocabModule` 的 import 与 `case 'vocab'`。

### 4.2 iframe 壳

`src/modules/vocab/index.tsx`：

- 生成一次性 `nonce`，拼进 `vocab://app/index.html?embed=1&nonce=...&theme=dark|light`。
- `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"`，**不加** `allow-top-navigation`。
- 监听 `message`：
  - 校验 `event.source === iframe.contentWindow` + `nonce`；
  - `ready` → 回 `init`（主题、今日数据）；
  - `session` → `vocabRecordSession`，成功后更新本地状态；失败 Toast。
- `useDataChanged('vocab', refresh)`。
- `registerAssistantContext` 上报今日词表，供全局助手「边看边问」。
- 模块保活：iframe 首次挂载后常驻，切走 `display:none` 不卸载。

## 5. qwerty-learner 构建与补丁

### 5.1 构建脚本

`scripts/build-vocab.mjs`：

1. 浅克隆 `https://github.com/RealKai42/qwerty-learner.git` 到 `vendor/qwerty-learner`（已存在则 `git fetch --depth 1 && git reset --hard origin/master`）。
2. 运行 `scripts/vocab/patch-upstream.mjs` 做字符串级补丁（失败即中止并指出文件/片段）。
3. `npm install --no-audit --no-fund` + `npm run build`。
4. 把 `build/` 复制到 `resources/vocab/`。
5. 支持 `VOCAB_DICTS=cet4,cet6,kaoyan,ielts,toefl` 裁剪词库（可选）。

`package.json` 增加 `"build:vocab": "node scripts/build-vocab.mjs"` 与 `extraResources` 条目。

### 5.2 补丁清单

| 补丁 | 文件 | 内容 |
|---|---|---|
| 去上报 | `src/index.tsx` | 删 `mixpanel.init` 与 `<Analytics />` |
| 去上报 | `src/utils/mixpanel.ts` | `mixpanel` 换成 no-op 对象，保留导出签名 |
| 去上报 | `src/utils/trackEvent.ts` | `@vercel/analytics` 的 `track` 换成 no-op |
| 路由 | `src/index.tsx` | `BrowserRouter` → `HashRouter`；embed 时禁止 resize 跳转（会丢 nonce） |
| 嵌入外壳 | `src/components/Layout.tsx` | `?embed=1` 时不渲染 Footer |
| 嵌入外壳 | `src/pages/Typing/index.tsx` | `?embed=1` 时不渲染 DonateCard |
| 嵌入外壳 | `src/components/EnhancedPromotionModal/index.tsx` | embed 时不自动弹推广 |
| 外链 | `src/components/Header/index.tsx` | logo 指回 `/` |
| 主题 | `src/store/index.ts` | `?theme=dark` 时用非持久 atom，避免覆盖宿主主题 |
| 桥 | 新增 `src/utils/phrontisBridge.ts` | `isEmbed` / `postToHost` / `initVocabBridge` / `postTypingSession` |
| 桥 | `src/index.tsx` | 调 `initVocabBridge()` |
| 桥 | `src/pages/Typing/index.tsx` | 章节完成 + `pagehide` 上报会话 |

补丁以字符串替换实现，不依赖 `git apply` 上下文；上游改动导致替换失败时脚本报错，人工更新补丁。

## 6. AI 接入

### 6.1 数据查询

`phrontis-core/src/kbStore/vocabVaultRepo.ts`：

- `vaultVocabDayGet(date)`
- `vaultVocabRecordSession(input)`
- `vaultVocabReviewWords({ date?, wrongDays?, onlyWrong?, limit? })`
  - 读今天日文件 → 全部词；
  - 读最近 `wrongDays` 天日文件 → `wrongCount > 0` 的词；
  - 合并去重，标记 `sources: ('today' | 'wrong')[]`；
  - 排序：`today+wrong` 优先 → `wrongCount` 降序 → `lastSeenAt` 降序；
  - 默认 `wrongDays=7`、`limit=50`。

### 6.2 AI 工具

`electron/lib/builtinTools.ts`：

```
builtin.vocab.words
  description: 读取今天和近 N 天背过的单词（释义/错次/词库/章节），用于造句复习。
               出造句题时先只给题目，等用户作答后再批改，不要直接给答案。
  params: date?, wrongDays?(7), onlyWrong?, limit?(50)
  readOnly: true, tier: 'ondemand', module: 'vocab'
```

权限接线：

- `src/lib/dataChanged.ts` `DataChangeScope` 加 `'vocab'`。
- `src/lib/aiPermPresets.ts` `MODULES` 加 `vocab`（`writeDesc: ''`）。
- `src/lib/settings.ts` `aiModulePermissions` 默认值加 `"vocab":"read"`。
- `builtin.tool.request` 的 description 清单补该工具。

### 6.3 造句复习行为

用户说「用今天背的单词造句 / 复习今天的词」时：

1. 模型调 `builtin.vocab.words`，拿今天 + 近 7 天错词。
2. 出 5 题：中译英造句 3 题 + 填空 2 题；每题给中文提示/英文挖空，不直接给答案。
3. 用户作答后逐题批改：指出用词/搭配/时态问题，给一个更自然的改写。
4. 错词可建议加入后续复习；本期不自动写错题本，避免越权写数据。

## 7. 文件改动清单

### phrontis-core

- 新增 `src/kbStore/vocabVaultRepo.ts`

### Phrontis

- 新增 `src/modules/vocab/index.tsx`
- 新增 `electron/database/repositories/vocabRepo.ts`
- 新增 `scripts/build-vocab.mjs`
- 新增 `scripts/vocab/patch-upstream.mjs`
- 新增 `resources/vocab/`（构建产物，gitignore）
- 改 `electron/main/index.ts`：`vocab://` 协议 + 注册 handler
- 改 `electron/preload/index.ts`：`vocabGetDay` / `vocabRecordSession` / `vocabReviewWords`
- 改 `src/types/index.ts`：`TabName` + 类型 + `ElectronAPI`
- 改 `src/lib/ipc.ts`：三个 wrapper
- 改 `src/lib/appModules.ts` / `workbenchLayout.ts` / `dataChanged.ts` / `aiPermPresets.ts` / `settings.ts`
- 改 `src/components/workbench/WorkbenchLeftPanel.tsx` / `WorkbenchPageBar.tsx`
- 改 `src/modules/desktop/tiles.tsx`
- 改 `src/App.tsx`
- 改 `electron/lib/builtinTools.ts`
- 改 `package.json`：版本 3.17.0、`build:vocab`、`extraResources`
- 改 `CHANGELOG.md` + 重跑 release-notes
- 改契约脚本：`ai-perms` / `workbench-shell` / `startup-tab` / `pdf-reader` 计数

## 8. 验收

- `npx tsc --noEmit -p tsconfig.node.json`
- `npx tsc --noEmit -p tsconfig.web.json`
- `npm run build`
- `node .AGENT/scripts/ai-perms/verify-ai-perms.mjs`
- `node .AGENT/scripts/workbench-shell/verify-workbench-shell.mjs`
- `node --experimental-strip-types .AGENT/scripts/startup-tab/verify-startup-tab.mjs`
- 手动：
  1. 打开背单词模块，能选词库、开始跟打、完成一章。
  2. 检查 `.knowbase/modules/vocab/days/<today>.json` 有该章 words。
  3. 对全局 AI 说「用今天背的单词造句复习」，能拿到今日词 + 近 7 天错词并出 5 题。
  4. 重发同一章（重复完成）不产生重复词/重复计数。
  5. 嵌入模式默认关闭发音与按键音；打字与记录正常。

## 9. 遗留工作（下次继续）

**总任务：背单词功能的软件适配与优化。**

- **B-48 读单词功能疑似有问题**：用户 2026-11-02 反馈，具体表现待补充；按用户要求**本次只记录、不修复**，下次先复现再定位。详见 `docs/pending-fixes.md` B-48。
- 当前嵌入版默认关闭发音播放 / 预取 / 按键音，是无音频设备环境下的临时稳定性处理，不代表 B-48 已解决。
- 后续适配 / 优化候选：发音链路（本地 TTS 或可选在线发音）、词库裁剪与安装包体积、跨设备进度回灌、AI 造句一键入口 / 练习页沉淀。

## 10. 原生模块化路线（暂缓，下一阶段）

> 决策：v3.17.0 先用 iframe 快速落地；原生模块作为下一阶段，**不急于实施**。
> 目标不是「把 qwerty-learner 源码搬进来」，而是把「打字背单词」重写成 Phrontis 的一等模块。

### 10.1 目标

- 统一 React 19 + Tailwind 4 + Phrontis 设计令牌，去掉 iframe 接缝。
- 数据只走 Vault：词库 / 章节 / 每日记录 / 错词 / 统计都在 `.knowbase/modules/vocab/`，不再依赖 iframe IndexedDB。
- 与左栏、右栏、桌面磁贴、命令面板、AI 助手、日程 / 打卡原生联动。
- 去掉约 82MB 的 qwerty-learner 静态产物与 vendor / build 脚本，安装包回到正常体积。
- 保留 qwerty-learner 的词库数据与 GPL-3.0 归属。

### 10.2 不做什么

- 不追求一次性 100% 复刻上游所有页面（Gallery / Analysis / ErrorBook 可分批）。
- 不把逐字母时序全量写 Vault；只保留聚合统计，明细可选本地缓存。
- 不在本期改 AI 工具协议（`builtin.vocab.words` 继续用）。

### 10.3 模块结构（建议）

```
src/modules/vocab/
  index.tsx                 # 原生模块壳：左栏 / 中央 / 右栏
  views/TypingView.tsx      # 跟打 / 默写 / 复习
  views/DictView.tsx        # 词库 / 章节选择
  views/StatsView.tsx       # 今日 / 历史 / 错词
  components/...
  core/
    typingEngine.ts         # 纯函数：输入判定 / 进度 / 错误统计
    wordQueue.ts            # 章节切分 / 循环 / 复习队列
    stats.ts                # 日 / 周聚合
phrontis-core/src/kbStore/vocabVaultRepo.ts  # 扩展词库 / 章节 / 统计
```

### 10.4 分阶段

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 打字判定 / 队列 / 统计抽成纯函数 + 契约脚本；词库 JSON 转 Phrontis 数据格式 | 1–2 天 |
| P1 | 原生模块壳 + 词库 / 章节选择 + 跟打 + Vault 日记录 | 2–3 天 |
| P2 | 默写 / 循环 / 错词本 / 今日统计 | 2–3 天 |
| P3 | AI 造句复习入口 + 日程 / 打卡联动 + 右栏设置 | 1–2 天 |
| P4 | 移除 iframe / vendor / resources/vocab，安装包瘦身 | 0.5–1 天 |
| 合计 | 完整对齐上游核心体验 | 约 7–11 天 |

### 10.5 迁移与回退

- 用设置项 / 构建开关保留 iframe 版一个版本周期（如 `vocabEngine: 'iframe' | 'native'`），默认 iframe，native 稳定后切换。
- Vault 日记录格式不变，原生模块直接复用；iframe 的 Dexie 明细不迁移，只保留 Vault 语义记录。
- 原生模块上线后，`resources/vocab` 与 `scripts/build-vocab.mjs` 先保留一个版本，确认无回退需求再删除。

### 10.6 风险

- 功能 parity：上游的默写、循环、错题本、统计页较多，分批做。
- 输入法 / 键盘布局 / 长词 / 大小写 / 标点等边界，需要纯函数 + 真机验证。
- 词库数据体积与许可证：继续用 kajweb/dict 来源，保留 GPL-3.0 与来源说明。
- 逐字母时序数据：原生版只存聚合，避免 Vault 膨胀；如需要图表，另建可选缓存。
- 发音：原生版优先系统 TTS 或本地音频包，避免在线依赖与音频栈崩溃。

### 10.7 验收

- 双 tsc / build / 契约脚本通过。
- 跟打、默写、错词、统计、AI 造句五条主链路可用。
- 卸载 iframe 后安装包体积明显下降，且无 `vocab://` 协议残留。

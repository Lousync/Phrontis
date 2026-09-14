# 设计文档归档约定（DESIGN-ARCHIVE）

> 本目录（`docs/`）只保留**活跃**的设计文档——总纲、正在推进的方案、活跃记录、常驻规范。
> 已完成使命的设计过程材料（已落码 / 已搁置 / 已作废 / 已暂缓的方案、全部原型、视觉稿、迭代截图）统一归档至独立的过程记录仓库。

## 归档仓库

**DesignProcess** — https://github.com/Lousync/DesignProcess （PRIVATE）
本地路径：`E:\Projects\DesignProcess\`

**定位：软件设计过程的留存库**（不只是文档与原型）——收录「立项 → 调研 → 方案 → 交互原型 → 视觉 → 落地 → 验收」全链路产物。六类目录：

- `Phrontis/方案与调研/` — 已搁置 / 已作废 / 已暂缓的方案稿 + 调研与对标注记
- `Phrontis/已实现设计文档/` — 已落码的设计方案
- `Phrontis/原型/` — 全部交互原型（HTML / drawio）
- `Phrontis/视觉与品牌/` — 图标（含完整过程稿）、命名、文案、欢迎页设计
- `Phrontis/过程记录/` — 决策记录、验收记录、UI 迭代截图
- `Phrontis/内容与素材/` — 产品内容规划与素材清单

该仓库由定时任务自动提交推送：有未提交变更时每日自动 commit + push。

## 归档规则

1. **判定标准「已完成使命」**，满足其一即归档：
   - 设计方案的核心功能**已落码**（文档头部标注"已实现/已落地/Q0 已实现"，或经代码核对确认）；
   - 方案**已搁置 / 已作废 / 已暂缓**，不再作为开工依据；
   - 属过程证据（原型、视觉稿、迭代截图、命名与文案），且对应工作已收官。
2. **归档动作**：从主仓库移到 DesignProcess 对应目录，随该仓库自动提交推送；同时在本文档清单中登记。
3. **保留在主仓库的**：总纲（rework-master-plan / ai-teaching-module-rework）、**仍在推进的方案**（plugin-api-v2-*、rework-plugin-openness、rework-toolbox-as-plugins、ui-animation-plan）、活跃记录（ui-updates / verification-issues-* / 真机验证）、常驻规范（help-disclosure-pattern）。
4. **被代码注释当规范引用的文档不回迁归档**：`.AGENT/docs/读写分工设计.md` 与 `.AGENT/docs/去库化迁移方案.md` 被 6 处代码注释 + 3 处文档引用（见下），视同常驻规范留在主仓库。
5. **不再设二级归档区**：原 `docs/archive/`（2026-09-07 建立的本地暂存归档）已于 2026-09-12 整体并入 DesignProcess。本地只保留"活跃文档"一层，完成即一步到位进 DesignProcess，避免两处归档面职责重叠。
6. **已知取舍**：归档会让主仓库内的相对链接失效（总纲正文按名引用已归档文档）。这是既有事实，主仓库侧不做链接维护，检索以本清单为准。
7. **过程证据一并归档**：原型、迭代截图、命名与文案稿、图标源件同批处理。未落码但与已归档方案配套的原型随方案一同归档；仍被**活跃**方案按名引用的原型留在 `docs/prototypes/`。
8. **不纳入归档**：运行时资产（`resources/help`、`resources/builtin-plugins`、`resources/market-plugins`、`resources/skills`）、工作区（`tmp/` 里的脚本与检查快照）、构建产物（`out/`、`dist/`、`dist-electron/`）、随扩展发货的 `clipper-extension/`、已发布的 `website/`。

## 归档清单

| 日期 | 文档 | 实现证据 |
|---|---|---|
| 2026-09-07 | rework-vault-layout-implementation.md | P1–P8 全部实现完毕（2026-09-06 验证，57935d5→064d4d3） |
| 2026-09-07 | rework-vault-account-model.md | vault 账户模型设计定稿，已被上述实现落地取代 |
| 2026-09-07 | rework-workbench-design.md | Workbench（uiWorkbench / 编辑器组 W3 / 全局侧栏槽）已实现于 App.tsx |
| 2026-09-07 | zen-mode-design.md | 禅模式（zenLevel Z1/Z2）已实现于 App.tsx + 禅热区 |
| 2026-09-07 | settings-rework-design.md | settings-rework 已合并实施（settings/views/ 全套分区） |
| 2026-09-07 | plugin-pdf-reader-design.md | PDF 阅读器已实现（docsReader.ts + PdfReaderView.tsx） |
| 2026-09-07 | graph-view-ui-spec.md | 图谱 G1–G3 + A8 增删动画全部完成（root 新版覆盖旧副本） |
| 2026-09-07 | rework-handoff-20260902.md | 2026-09-02 交接备忘，已完成使命（root 新版覆盖旧副本） |
| 2026-09-07 | agent-immersive-mode-design.md | 沉浸模式方案已被「AI教学」模块取代并实施 |
| 2026-09-07 | agent-immersive-quiz-design.md | 沉浸问答方案已被 AI教学题目视图（P7）取代并实施 |
| 2026-09-07 | devbridge-roadmap.md | 已实现并实测通过（2026-08-29，feature/devbridge-roadmap 分支） |
| 2026-09-07 | ai-test-bridge.md | 已实现并实测通过（仅 dev/测试环境启用，生产构建不打包） |
| 2026-09-07 | habit-module-linkage.md | 已实现（迁移 048 + `electron/lib/habitLinkService.ts`） |
| 2026-09-07 | DEVELOPER.md | 开发者指南（非设计方案），随本地归档区整体并入留存 |
| 2026-09-11 | conflict-resolution-design.md | v1（保存时 mtime 校验）已落地 |
| 2026-09-11 | icon-redesign-record.md | 无影版图标接入 build/，构建验证通过 |
| 2026-09-11 | ignore-filter-design.md | `.ignore` 过滤插 scanMarkdownFiles 全链路生效（2026-09-07 定稿后落码） |
| 2026-09-11 | plugin-web-clipper-design.md | Q0 已实现（2026-09，ebf46e2/e12d27d/583c8ca + 浏览器扩展） |
| 2026-09-12 | settings-switch-toggle-redesign.md | `SettingSwitch` 全量替换原生 checkbox（设置页 5 视图 + 下拉面板，共 18 处）；文档头仍写"未执行任何代码改动"，已按代码现况校正 |
| 2026-09-12 | ui-polish-round2-vault-pomodoro-toolbox.md | 三点全落地：仓库切换器迁编辑器侧栏底部（`editor/index.tsx:1054`、`TitleBar.tsx:195` 注释已迁走）+ 番茄钟预设分段器 + `toolboxHiddenTools` 显隐管理 |
| 2026-09-12 | ai-teaching-sources-panel-rework.md | 文档头 ✅ 已实现（2026-09-09） |
| 2026-09-12 | ai-tools-consolidation-design.md | P1–P4 全部完成（工具 23→18 + tier 装载层 + `tool.request`），仅真机验收待做 |
| 2026-09-12 | agent-file-tools-design.md | B0–B3 + `web.read` + `docs.read-text` + P 面板 + 会话要求 + PPT 素材，台账全部 ✅ 代码完成 |
| 2026-09-12 | quizbook-builtin-rework.md | 已全内置（`1d87d9d` 退役双形态 / `7827aa4` 内置工具族；`QuizMigratePanel`→`QuizDataPanel`）；文档头仍写"待评审"，已按代码现况校正 |
| 2026-09-12 | ai-streaming-design.md | `useAgentStream.ts` + `StreamBubble.tsx` + `aiStreamEnabled`/`aiShowThinking` 已落地 |
| 2026-09-12 | slim-activitybar-plan.md | `Onboarding.tsx` 场景选择步骤 + `activityBarHidden` 写入链路已落地 |
| 2026-09-12 | vault-archive-all-files-design.md | `electron/lib/kbStore/archivedFilesRepo.ts` 全类型归档已落地 |

### 2026-09-12 第二批（口径放宽为「设计过程留存」后）

| 文档 | 归档去向 | 判定依据 |
|---|---|---|
| delete-fx-skin.md | 已实现设计文档 | 删除动效已落码（`src/lib/deleteFx.ts` + `src/components/shared/DeleteWipe.tsx` + `settings.ts` 外观设置项） |
| auto-update-improvements.md | 已实现设计文档 | 自动更新已落码（`electron/lib/updateService.ts`；CHANGELOG 记有 v2.13.0 事故复盘与三重防护实现） |
| knowledge-query-design.md | 方案与调研 | 文档头「用户已立项，细节待拍板」，未落码 |
| graph-view-design.md | 方案与调研 | 文档头「方案讨论稿，未落地代码」；正式规格已另档（graph-view-ui-spec.md） |
| theme-system-design.md | 方案与调研 | 文档头「设计讨论稿 v0.1，细节待拍板」 |
| onboarding-rework-design.md | 方案与调研 | 文档头「方案讨论稿，待拍板后实施」 |
| ai-teaching-artifacts-pane-design.md | 方案与调研 | 文档头「方案定稿，待排期实现」 |
| voice-input-design.md | 方案与调研 | 暂缓项目（已论证到落码级后搁置） |
| plugin-obsidian-benchmark-20260902.md | 方案与调研 | 已完成的调研注记与对标材料 |
| plugin-external-integration.md | 方案与调研 | 调研完成（2026-09-02），目标清单未圈定 |
| pdf-annotation-roadmap.md | 方案与调研 | 未落码路线图 |
| soft-copyright-application.md | 内容与素材 | 软著申请材料（资质文件，非设计方案） |
| kaoyan-408-quiz-mode.md 等考研 4 篇 + knowledge-pack-answer-format.md | 内容与素材 | 产品内容规划与知识包契约，非代码设计 |
| DEVELOPER.md / ai-test-bridge.md / devbridge-roadmap.md / habit-module-linkage.md | 去重删除 | 与 DP 内同名文件**逐字节相同**，`.AGENT/docs/` 侧为冗余副本，已移出仓库 |

## 原型归档清单

> 归档目标：DesignProcess `Phrontis/原型/`。

| 日期 | 原型 | 配套文档 / 实现证据 |
|---|---|---|
| 2026-09-12 | ai-thinking-progress-preview.html | ai-streaming-design.md（会话流式输出已落地：`useAgentStream.ts` / `StreamBubble.tsx`） |
| 2026-09-12 | ai-teaching-sources-collapse.html | ai-teaching-sources-panel-rework.md（✅ 已实现 2026-09-09） |
| 2026-09-12 | quizbook-builtin-prototype.html | quizbook-builtin-rework.md（已全内置：1d87d9d / 7827aa4） |
| 2026-09-12 | schedule-week-rework.html | 日程周视图改造（615de12，无独立设计文档） |
| 2026-09-12 | schedule-timetable-week-view.html | 日程表周视图（02de416，无独立设计文档） |
| 2026-09-12 | schedule-view-switch-mock.html | 日程表周视图·视图切换稿（02de416） |
| 2026-09-12 | schedule-task-feedback-and-quadrant.html | 日程完成反馈三档 + 四象限图标化（21772d1） |
| 2026-09-12 | 侧边栏原型-日程与打卡.drawio | 日程与打卡小窗完整实现（57e722b） |

### 2026-09-12 第二批原型

| 原型 | 来源 | 判定依据 |
|---|---|---|
| ai-teaching-prototype.html、ai-teaching-layout-builder.html、ai-teaching-layout-user-v1.json | docs/prototypes/ | AI 教学模块 P0–P8 已全部落地，原型完成使命（总纲正文按名引用，按规则 6 接受链接失效） |
| ai-teaching-right-artifacts.html | docs/prototypes/ | 配套 ai-teaching-artifacts-pane-design.md（已归档） |
| ai-teaching-companion-split.html | docs/prototypes/ | 「伴读分屏」方向已作废，留档 |
| ai-teaching-tech-mode.html | docs/prototypes/ | 无对应设计文档，作为过程证据留存 |
| ink-theme-prototype.html | docs/prototypes/ | 配套 theme-system-design.md（已归档） |
| 知识库-呈现模式重构-原型.drawio、knowledge-bookshelf.html | .AGENT/docs/ | 知识库呈现模式重构原型（软链时代孤儿文档区，2026-09-12 收编） |
| password-vault-preview.html | outputs/ | 密码本已落码（`src/modules/toolbox/components/PasswordVault.tsx`） |
| slim-activitybar-prototype.html | outputs/ | slim-activitybar-plan.md（已归档 + 已落码） |
| help-disclosure-prototype.html、hint-icon-prototype.html | outputs/ | 提示披露规范已应用（help-disclosure-pattern.md） |
| quickadd-variants-prototype.html、tag-chip-fix-preview.html | outputs/ | 未落码的交互变体稿，作为过程证据留存 |
| immersive-agent-mock.html、daypanel-tools.html、demo-resize.html、range-demo.html、selftest-timetable.html | tmp/ | 散落在工作区的原型稿，一并收编 |

### 仍留主仓 `docs/prototypes/` 的原型（3 件）

| 原型 | 留仓原因 |
|---|---|
| ai-learn-center.html、ai-learn-bottom-bar.html | ai-learn-center-design.md 留在主仓库（待拍板，且 §7.3/7.5 已落码被代码引用），其原型随之留仓 |
| ui-animation-prototype.html | ui-animation-plan.md 正在推进，正文按名引用 |

## 视觉与品牌归档

| 日期 | 内容 | 去向 |
|---|---|---|
| 2026-09-11 | 图标重设计全过程（决策记录 + 终稿 + 过程稿） | `Phrontis/视觉与品牌/图标重设计/` |
| 2026-09-12 | `name-compare.html`（定名候选对比）、`phrontis-copy-brief.md`、`readme-draft.md`、`Phrontis-plugins-README.md`、`欢迎.html`、`knowledge-recorder-icon-redesign.png` | `Phrontis/视觉与品牌/` |
| 2026-09-12 | `outputs/icon-final`、`icon-final-noshadow`、`icon-redesign` 三目录 | **去重删除**——与 DP 内 `图标重设计/final-带影版`、`final-无影版`、`过程稿` 目录级零差异（`diff -rq` 确认） |

## 过程记录归档

| 日期 | 内容 | 去向 |
|---|---|---|
| 2026-09-12 | `outputs/` 与 `tmp/proto-shots/` 的设计过程截图 61 张 | `Phrontis/过程记录/UI迭代截图/`（分 欢迎页与宣传页 / 日程与日面板 / AI教学与学习中心 / 底栏与动效 四组） |
| 2026-09-12 | `Knowbase仓库整合报告-20260910.md` | `Phrontis/过程记录/` |
| 2026-09-12 | Claude Code plan 文件 25 份（约 175 KB） | `Phrontis/过程记录/Claude 计划文件/` |
| 2026-09-13 | 主仓库根目录 `更新计划.md` 整体迁出；DP 侧新建 `更新计划/` 专夹，**按版本分文件**（`vX.Y.Z.md` = 自上一版升级到该版的批次计划，版本号标注在文件名与标题）。批次划分：`v3.1.1.md`（3.1.0→3.1.1，13 项全完成收官）+ `v3.1.2.md`（3.1.1→3.1.2，当前迭代 8 项待办：开场模板预填/会话准备态、Token 用量拆分、/ 弹层透明、扩大态侧栏拖宽、docx 素材、工作区级约束、资料范围纪律；两条旧待办经志岩确认不再跟进） | `Phrontis/更新计划/v3.1.1.md`、`v3.1.2.md` |

## Claude 计划文件归档（2026-09-12）

`.claude/plans/` 是用 Claude Code 开发时自动落盘的实现计划（动手前先写的那一份），**25 份、约 175 KB**，横跨 6 月至 9 月。既不在版本控制内（`.claude/` 被 gitignore）、也不参与任何构建，长期堆在工作区只干扰检索。

| 来源 | 数量 | 去向 |
|---|---|---|
| `.claude/plans/*.md` | 14 | `Phrontis/过程记录/Claude 计划文件/` |
| `.claude/plans/plugins/*.md` | 11 | 同上（扁平化，去掉 plugins 子层） |

**判定的依据**：AI 工作过程产物，非用户视角的设计文档；对应方案**多数已落码或被后续设计取代**（真实设计稿在 `docs/`，已按状态分流至本库）。作为「当时是怎么想出来的」的过程证据留存。

**附带的工作区清理**（同批，`.claude/` 整体不进版本控制）：搬空后删除 `plans/` 与空目录 `temp_scripts/`、`worktrees/`；两份 `settings*.json` 中的历史一次性授权一并清出（明细见 DP 侧 `Claude 计划文件/README.md`）。

## AI 约束文档清理归档（2026-09-12）

`.claude/CLAUDE.md`（AI 常驻约束文档）自 6 月定型后未随项目演进更新，463 行中 346 行失效；且混入大量「过程记录」性质的章节。清理时把非约束内容移出文档、归档至 DP：

| 来源 | 内容 | 去向 | 判定依据 |
|---|---|---|---|
| `.claude/CLAUDE.md` 六节（功能模块 / 技术栈 / 项目结构 / App 主结构 / 数据库设计 / 开发路线） | Knowbase 时期（sql.js + 四模块）的完整技术快照 | 方案与调研 `Knowbase 早期架构基线与开发路线（sql.js 四模块时期）.md` | 整体失效：v3.0.0 已更名 Phrontis、移除 sql.js、模块 4→14 |
| `.claude/CLAUDE.md`「已解决：界面缩放」57 行 | 三条失败路径的排错过程 + 最终方案 | 已实现设计文档 `界面缩放（Ctrl+= 内容区缩放）.md` | 已落码（`App.tsx` 用 `documentElement.fontSize`）；属过程记录，非开工依据 |
| `.claude/knowledge-schemes.md` | 知识库四方案对比（文件夹 / 网状 / 卡片盒 / 混合型） | 方案与调研 `知识库四方案对比（方案 D 已落地）.md` | 方案 D 已落地为现行知识库 |
| `.claude/windows-sprightly-bird.md` | 最初技术方案（better-sqlite3 + Milkdown + `KnowledgeRecorder/`） | 方案与调研 `初版技术方案（博客+日程双模块）.md` | 技术选型全部被替换（Monaco 取代 Milkdown、SQLite 整体移除） |

**清理后**：`CLAUDE.md` 由 463 行重建为 **123 行**，只保留「每次开工必读」——三条核心不变量、技术栈现状、架构地图、11 条铁律、工作流、提示与设置、文档指针。

**顺带修正的一处事实性错误**：旧文档写 `sandbox: false` 并解释"因为 preload 需要访问 Node.js API"，实际代码是 `sandbox: true` + `contextIsolation: true`（`electron/main/index.ts:252`）——方向完全相反，AI 读了会往反方向改。

**已知局限**：`.claude/` 被 `.gitignore` 排除（`.gitignore:13`），该文档不在版本控制内。这既是它长期无人察觉的原因，也意味着本次重建没有 git 历史可回溯（2026-09-12 讨论决定暂不纳入跟踪）。

## 已知引用失效（接受）

以下活跃文档仍按旧路径引用已归档文件，按规则 6 不再维护链接：

- `docs/rework-master-plan.md`、`.AGENT/docs/去库化迁移方案.md` 等引用已归档的 rework-* 文档
- `docs/ai-teaching-module-rework.md` 正文按名引用已归档的 `ai-teaching-prototype.html` / `ai-teaching-layout-builder.html` / `ai-teaching-layout-user-v1.json`
- `scripts/publish-knowledge-pack.py:23` 写的是 `docs/knowledge-pack-answer-format.md`，该路径**早已失效**（真实文件现位于 DP `Phrontis/内容与素材/`）

## 反向说明：留在主仓库的"旧位置"文档

`.AGENT/docs/` 是软链时代的 `docs` 实体目录（早期 `docs` 为指向它的软链），2026-09-12 收编时将其余文档全部归入 DP，仅保留两篇被代码当规范引用的：

- `.AGENT/docs/读写分工设计.md` ← `electron/database/repositories/knowledgeRepo.ts:23`、`electron/lib/kbStore/knowledgeVaultRepo.ts:11`、`src/modules/editor/index.tsx:387`、`src/modules/knowledge/index.tsx:658`、`docs/knowledge-query-design.md:184`、`docs/onboarding-rework-design.md:5`
- `.AGENT/docs/去库化迁移方案.md` ← `electron/lib/kbStore/blogVaultRepo.ts:8`、`electron/lib/kbStore/bookmarkVaultRepo.ts:5`、`docs/rework-master-plan.md:87`

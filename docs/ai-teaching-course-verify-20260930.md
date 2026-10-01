# AI教学 · 课程模式 / 课时生命周期 · 验证记录（2026-09-30）

> **用途**：对「课时生命周期 + 引用网络」结构性重构（`docs/ai-teaching-lesson-lifecycle-plan.md`，L0–L5）做一次完整功能核查。
> **纪律（用户指示）**：**只验证、只记录，不急着修**。修复待后续拍板。
> **验证分支**：`feature/v3.4.0`（相关改动均未提交）。

## 一、验证方式与工具

| 方式 | 载体 | 结果 |
|---|---|---|
| **专项探针** | `tmp/probe-ai-teaching-course.mjs`（纯函数真实执行 + 生命周期规则源码级断言 + 风险探测） | **PASS 29 / FAIL 0 / WARN 3** |
| 课程契约 | `.AGENT/scripts/ai-teaching/verify-course-mode.mjs` | **53 / 53** |
| 全量契约 | `node tmp/run-all-contracts.mjs` | **65 / 65** |
| 类型门禁 | `tsc --noEmit` node/web | **零错误** |
| 素材契约 | `.AGENT/scripts/ai-teaching/verify-sources-workspace.mjs` | 37 / 37 |

探针覆盖：① 课程.md 解析/往返、大纲 JSON 抗噪、手册通道词表（**真实执行**）；② `openUnit` 三态、`endLesson`、`finishUnit` 守卫、L1 解析器注册、L3 出题/解析是否存在（**源码级**）；③ 前端接线（打开即续课 / 只读 / 跳转 chip / 交接条 / 回炉 / 自测）。

## 二、发现（**待修，本轮未修**）

### F1 · 总结篇落点与 L1 分层不一致（探针 D1）
- 现象：`finishUnit` 把总结篇写到 **`{工作区}/总结·{知识点}.md`（工作区根）**，而 L1 已把知识点产物组织到 `{工作区}/{章号}·{知识点}/`。
- 影响：同一知识点的「课时夹在分层目录里、总结篇却浮在工作区根」，与设计（`{知识点}/总结·x.md`）不符。
- 位置：`electron/lib/aiTeachingCourse.ts` 的 `finishUnit`。

### F2 · 收尾不接测验得分（探针 D2）
- 现象：`finishUnit` 固定 `status='mastered'`、`mastery` 不变；L3 自测的得分只展示、不写回掌握度。
- 影响：「练习驱动掌握度」在收尾这一步断链（此前 quiz 写回只作用于课时内检验）。

### F3 · 跳转 chip 按「名精确匹配」（探针 D3）
- 现象：`courseSummaryByName.get(name)` 用**知识点全名**精确匹配；AI 输出 `跳转：《行列式的性质》`、简称或带标点时会**匹配失败 → chip 置灰**。
- 位置：`src/modules/ai-teaching/index.tsx`（`splitJumps` + `courseSummaryByName`）。

### F4 · 章序/章名变更 → 知识点夹前缀漂移，无迁移
- 现象：目录前缀 = `{章号}·{知识点名}`（取大纲顺序）。改章名或调章顺序后，**旧文件夹不重命名**；靠 `findSessionFolderRel` 的递归寻址仍能读到，但同一知识点再产生新产物时会**按新前缀新建第二个夹**。
- 属「方案 A（章不落盘）」的已知代价。

### F5 · 旧「会话级」画像 / 素材不迁移（懒迁移未实现）
- 现象：L5 把画像第三层、素材对话级都上移到「知识点级」。**旧会话夹里的 `PROFILE.md` / `SOURCES/{对话名}/` 不会被读、也不会被迁移**——历史内容静默失联。
- 影响有限（该功能此前基本未实际使用），但属于数据迁移缺口。

### F6 · 空课时也能「结束」并生成占位交接
- 现象：对一条**零消息**的课时点结束，`finalizeLesson` 仍会生成 `交接.md`，内容为「（本节没有对话）」。
- 与「空课时不建夹」不完全呼应（虽不建夹，但结束会建）。

### F7 · 已完成知识点再开课 = 新建课时，`finished` 不重置
- 现象：收尾后点「重温」→ `openUnit` 见最后一节已结束 → 新建下一节；但 `finished` 仍为 true、状态仍 `mastered`。
- 影响：与新课时并存时，「已收尾」标记与实际又在学习的状态并存，语义略拧。

### F8 · 素材 `SOURCE.md` 的 `conversation:` 字段现为知识点名
- 现象：L5 后 `layout().convName` 取的是知识点段，登记模板 frontmatter `conversation:` 会写成知识点名而非「对话名」。
- 属字段语义漂移（不影响解析，程序按小节解析）。

### F9 · `aiTeachCourse:setSessionUnit` 成死接口（非 bug，清理项）
- 现象：新前端已改用 `openUnit`，`setSessionUnit` 及其 IPC 仍保留但渲染层不再调用。非缺陷，登记为清理候选。

## 三、探针覆盖不到、仍需真机验证的项

> 探针是「源码级 + 纯函数」，**跑不了真实 UI 与 LLM**。以下必须 `npm run dev`（改了主进程，需重启）后在真机走一遍：

1. **打开即续课**：点知识点 → 无课时建课时1 / 进行中续上 / 已结束开下一节（且不再刷重复夹）。
2. **结束课时**：冻结 + 输入区只读 + 异步生成 `讲义.md`/`交接.md`；生成期与失败态。
3. **上节交接条**：进入下一节时条出现、可折叠、内容正确。
4. **目录物理分层**：真实落盘是否 `{工作区}/{章号}·{知识点}/课时N·类型/`；旧平铺夹兼容读取。
5. **收尾自测**：出题 → 作答 → 得分 → 生成总结篇；出题失败是否回退直接生成。
6. **跳转 chip**：主动/被动两种时机下 AI 是否按协议输出、chip 能否点开总结篇。
7. **画像/素材**：第三层是否落 `{知识点}/PROFILE.md`；素材是否落 `{工作区}/SOURCES/{知识点}/`。
8. **LLM 稳定性**：生成大纲 / 交接 / 总结 / 出题在真实模型下的成功率与格式合规。

## 四、结论

- **接线与数据结构：全绿**（契约 + 类型 + 探针规则断言均通过）——重构没有破坏既有契约。
- **功能正确性：3 条设计一致性缺口（F1–F3）+ 4 条边界/迁移项（F4–F8）**，均**未修**，等拍板。
- **真实交互与 LLM 表现：未验证**（探针不可达），需真机。

---
（记录人：AI；日期：2026-09-30；状态：待用户拍板后逐条处置）

---

# 附录 · 真机验证结果（2026-10-01）

> 方式：启动带调试桥的 dev 实例（`KNOWBASE_DEV_BRIDGE=1` → 端口 7465），用探针 `tmp/probe-ai-teaching-app.mjs` 走桥驱动真实应用（`ui.eval` / `ui.click` / `/ui/screenshot` / `/errors`）。
> 真实 vault：`E:\生活与记录`（workspace「线性代数」已开启课程模式）。

## R0 · 通过项（真机）
- 活动栏「AI 教学」可进入；**课程主页渲染正常**（顶栏 `课程主页 ⇄ 上课` 分段、`线性代数` chip、右「画像 / 会话要求」）；左栏**课程大纲**章/知识点齐全。
- 点「继续上课」→ **上课视图**（出现「结束课时」按钮 + 快捷 chip），**进入过程无渲染层异常**。
- 点「结束课时」→ **输入区立即只读**（`readonlyText:true`、`textareaDisabled:true`），且**无渲染崩溃**。
- 截图：`tmp/devbridge/shot-*.png`（3 张）。

## R1 · 真机确认崩溃：`readPrevHandoff` 空安全缺口（**建议优先修**）
- 现象（主进程日志实锤，`/errors`）：
  ```
  Error occurred in handler for 'aiTeachCourse:readPrevHandoff':
  TypeError: Cannot read properties of undefined (reading 'cc97029d-5e53-4b41-b5d3-b3fb73028b61')
    at readPrevHandoff (electron/lib/aiTeachingCourse.ts:274)
  ```
- 根因（已读码）：`const cur = s?.lessons[sessionId]` —— `s` 为 `undefined` 时，`s?.lessons` 得 `undefined`，再 `[sessionId]` 即抛。应为 `s?.lessons?.[sessionId]`。
- 触发条件：`getWorkspaceOfSession(sessionId)` 返回的 wsId **在 `progress.json` 里没有条目**（会话来源映射与进度条目不齐）。
- 影响：**「上节交接」界面条静默失效**（渲染层 catch 吞掉 → 条不显示），且每进一个课时主进程报一次错。

## R2 · 真机发现：结束课时**未产出 `交接.md`**
- 现象：真机点「结束课时」后，`progress.json` 里该课时 `status:"ended"`（迁移出的 `lessons` 结构正确），但
  - `Get-ChildItem E:\生活与记录\AI教学 -Recurse -Filter 交接.md` → **空**；
  - 也**未见 L1 嵌套目录**（`{章号}·{知识点}/课时N·类型/`），该 workspace 下仍只有旧平铺夹 `10-01 课·…(1..5)`。
- 推断：`finalizeLesson` 的**写盘路径未达**（疑似 `getWorkspaceOfSession` 解析出的 wsId 与 `progress.json` 不一致，`writeFolderFile` 早退）；主进程**未记录 `aiTeachCourse:finalizeLesson` 的异常**（说明是返回 ok:false 而非抛错）。
- 待查：`finalizeLesson`→`writeFolderFile`→`lessonFolderRel`/`ensureSessionFolder`(→resolver) 各早退分支，与 `getWorkspaceOfSession` 的取值。

## R3 · 环境噪声（非产品问题）
- `[Renderer] Uncaught SyntaxError: Illegal return statement`：来自**本轮我早期一条写坏的桥 `ui.eval`**（时间戳 09:01:12 早于进入模块），非应用代码，忽略。

## 结论（真机）
- 界面与核心交互**能跑通、无产品侧白屏/崩溃**；
- 但 **R1（空安全崩溃）** 与 **R2（结束课时不产交接/不分层）** 是**真机实锤的缺陷**，与静态探针的 F1/F4 相互印证；
- `progress.json` 的 `sessions→lessons` 迁移**在真机生效**（见 ws-muo54ld8 的 lessons）。

---

# 修复记录（2026-10-01 · 用户「开修」）

## 已修（真机复验通过）
### R1 · `readPrevHandoff` 空安全崩溃 → 已修
- 改法：`readPrevHandoff` / `lessonFolderRel` / `buildCourseInjection` 三处从**读原始 `progress.json`** 改为走 **`wsState()`**（它才做 `sessions→lessons` 迁移 + 保证结构），并把 `s?.lessons[sessionId]` 改为 `s.lessons?.[sessionId]`。
- 根因确认：旧 `progress.json` 的 workspace 条目只有 `sessions`、无 `lessons`，读取路径直接裸取 `s.lessons[...]` → `TypeError`。
- 真机复验：**不再报错**，`/errors` 零新增。

### R2 · 结束课时不产 `交接.md` / 不分层 → 已修
- 同上根因（`lessonFolderRel` 读原始文件取不到 lesson → 早退 → 走平铺兜底/或返回）。
- 真机复验（重启 dev 后）：点「结束课时」→ toast「**交接已生成（交接.md）**」，磁盘实锤：
  ```
  E:\生活与记录\AI教学\线性代数\1·行列式的概念与阶数\课时8·精讲\交接.md   (434B)
  ```
  —— **L1 物理分层也一并验证通过**（出现了嵌套夹 `1·行列式的概念与阶数`）。

### F1 · 总结篇落点与 L1 一致 → 已修
- 新增 `unitFolderRel(wsId, unitId)`；`finishUnit` 的 `总结·{知识点}.md` 从**工作区根**改到**知识点夹** `{工作区}/{章号}·{知识点}/`。

### F3 · 跳转 chip 名匹配脆弱 → 已修
- 新增 `normName()`（去书名号/引号/标点/空白、大小写不敏感）；`courseSummaryByName` 与 chip 查表均用归一化键。

### F2 · 收尾未用自测得分 → 已修
- `finishUnit(wsId, unitId, getSetting, score?)`：有得分时 `mastery = correct/total`、`status = mastery≥0.8 ? mastered : review`；无得分保持原掌握度。IPC/preload/types/ipc.ts 同步加 `score`；建课向导自测「生成总结篇」把得分传下去。

### F6 · 空课时生成占位交接 → 已修
- `finalizeLesson` 先查消息数，零消息 → 返回 `{ ok:true, skipped:true }` 不写文件；渲染层 toast「本节没有内容，未生成交接」。

### F7 · 收尾后再开课不回炉 → 已修
- `openUnit` 新建课时后：若该知识点此前 `finished`，自动 `finished:false, status:'learning'`。

### 真机复验（重启 dev 后）
- 真机探针 **PASS 8 / FAIL 0**、`/errors` 零新增；`交接.md` 在 L1 路径 `1·行列式的概念与阶数/课时N·精讲/`。

### F4 · 章名/章序变更 → 知识点夹改名迁移 → 已修
- 新增 `migrateUnitFolderPrefixes()`：`writeCourseOutline` 保存大纲后，扫描工作区下 `^\d+·(.+)$` 的知识点夹，按新章号重命名（`renameWorkspacePath`），并同步 `SOURCES/{旧段}` → `SOURCES/{新段}`；目标已存在/单夹失败不阻断。

### F8 · 素材登记字段语义 → 已修
- `SOURCE.md` 模板 frontmatter 的 `conversation:` 改为 `归属:`（`sourceTemplateText` 与 `rewriteEntries` 同步），避免「值其实是知识点名」的误解。

### F9 · 死接口 `setSessionUnit` → 已移除
- 确认无调用方（仅自引用 + 契约），删除：`aiTeachingCourse.setSessionUnit` + IPC handler + preload/types/ipc.ts 包装，契约计数 13→12。

## F5 · 暂缓（说明）
- 现象：旧「会话级」画像/素材不迁移。
- **实测 vault：无可迁移数据**——现存旧 `PROFILE.md` / `SOURCES/{对话}/` 都落在**未开课程模式的工作区**（机器学习 / 编译原理 / 数据结构与算法），**没有知识点可挂**；开课程模式的工作区（线性代数/高数）本就没有旧会话级资产。故「懒迁移」当前无对象，暂缓（若日后给这些工作区开课程模式再补）。

## 验证（最终）
- 双 tsconfig 零错误；课程契约 52/52；素材契约 37/37；源码探针 29/0/3；全量契约 **65/65**。


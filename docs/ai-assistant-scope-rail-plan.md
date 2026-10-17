# AI 助手左栏 · 作用域面板统一改造 —— 实现方案

> 台账：`docs/v3.9.0-feedback.md` 的 **★ 主题聚类：AI 助手左栏统一改造**（`F-2` / `F-3` / `F-4` / `F-5`）。
> 拍板依据 = 可交互原型 `E:\Projects\KnowledgeRecorder\tmp\ai-assistant-scope-pane-proto\index.html` 体验后的档位选择（2026-10-16）。
> **状态（2026-10-16 落地）**：两处开放点已选定 —— 批量入口 = **摘要行同位单按钮**（§5）；版本 = **随 3.9.x 补丁线**（§7）。代码已按本方案落地：`scopeSetPure.ts` 新增、`ScopePane.tsx` 重写、`index.tsx` 三处改、契约 `verify-scope-guard.mjs` 扩到 **94/94 PASS**（含 §H 43 条 + 炸开不变量穷举）、`tsc --noEmit`（web + node）双清、`npm run build` 通过、`resources/help/AI助手.md` 已同步（帮助检索 156/156）。**真机 GUI 未验**，验收清单见 §6 末。

## 0. 已定（四条一览）

| 条目 | 已定（你选的档） | 落到代码上是什么 |
|---|---|---|
| `F-5` | **C 只报数（选择态交给树）** | 删掉搜索框下方那排 chip，改一行摘要「已选 N 项 · 全部取消」；选择态**只在树里**表达 |
| `F-2` | **集合语义 + 前缀压缩** | 复选框显示节点的**真实归属**（实勾 / 半选 / 未勾）；点击 = 加入或移出该子树；存储仍压缩回前缀 |
| `F-3` | 三个动作都要（全选顶层 / 全选可见 / 全部取消） | **入口已定 = 摘要行同位单按钮、按语境换语义**（§5） |
| `F-4` | **不改，保留双击** | 零代码改动。台账转 `[-]`（按设计），契约 `G15`（钉双击入口）从「待改」升格为「按设计的锁」 |

不动的东西（明确划出去）：主进程作用域语义（`electron/lib/kbStore/vaultScope.ts` / `aiAssistantScope.ts`）、会话落库通道（`agentSessionRepo.updateAgentSessionScope`）、`useAiAssistant` 的 scope 状态机与「运行中拒绝改动」、`index.tsx:216` 的 `maxHeight: '56%'`。

## 1. 一句话主张

**选择态只有一处真源（前缀数组），只有一处表达（树内三态）。** `F-2` 与 `F-5` 是同一个问题的两半，所以一起解：树内表达准了，树外的 chip 就从「必需」降级为「冗余」，删掉它既解了挤压，也解了双重表达。

## 2. 改哪些文件

> **行号口径**：台账里 `index.tsx:151`（守卫）/ `:211`（`maxHeight`）/ `:270`（双击改名）三处锚点，因同日 `F-1` 落地在该文件上方加了约 5 行而整体下移。本方案一律用**现行实测行号**：守卫 `:156`、`maxHeight` `:216`、双击 `:275`。

| 文件 | 动作 |
|---|---|
| `src/modules/ai-assistant/scopeSetPure.ts` | **新增**（零依赖纯函数，专为可测） |
| `src/modules/ai-assistant/ScopePane.tsx` | 主战场：删 chip 行、加摘要行、三态显示、集合语义点击、批量动作、raw 子项 |
| `src/modules/ai-assistant/index.tsx` | 段头文案去重；`adoptScopeCard` 过一遍压缩；`56%` 注释更新 |
| `.AGENT/scripts/ai-assistant/verify-scope-guard.mjs` | 新增 §H（纯函数用例表）+ 三条负向接线断言 |
| `docs/v3.9.0-feedback.md` | 状态翻转 + 变更记录 |
| `resources/help/AI助手.md`、`resources/help/AI 权限与工具边界.md` | 收尾同步（作用域用法变了：没有 chip 了、能全选了） |

### 2.1 `scopeSetPure.ts`（新增，零依赖）

```ts
export const SCOPE_ENTRY_SOFT_CAP = 400          // 落库硬截断是 500，留 100 余量
export function prunePrefixes(list: string[]): string[]           // 去重 + 删掉被其它条目覆盖的冗余项
export function coveredBy(scope: string[], rel: string): string | undefined  // 覆盖 rel 的前缀（含自身）
export function coverageOf(scope: string[], rel: string, kidsOf: (r: string) => string[] | undefined):
  'all' | 'partial' | 'none'                     // 三态；子项未知时退化为「按条目本身判」
export function addToScope(scope: string[], rel: string): string[]              // = prune([...scope, rel])
export function removeFromScope(scope: string[], rel: string, kidsOf): string[] | null
                                                // null = 需要更多子项才能算（上层去 ensureLoaded）；超软上限也返回 null
```

`kidsOf` 是**注入的访问器**而不是参数数组，因为目录子项在 `ScopePane` 里是懒加载的。纯函数不碰 IPC，契约脚本可以直接 `import` 跑用例表（先例：`electron/lib/aiAssistantScopeSuggestPure.ts`）。

### 2.2 `ScopePane.tsx`

1. **删** `:133-150` 整块 chip 行（`flex flex-wrap gap-1` + `scope.map`）。
2. **加**一行摘要（搜索框与树之间，`shrink-0`，高度恒定）：
   - 有选中：`已选 N 项` …… 右侧一个动作按钮；
   - 未选中：`未圈定范围`（`text-[var(--warn)]`）…… 右侧 `全选顶层`。
   - 动作按钮**同一位置永远只有一个**（见 §5），窄侧栏不出现第二个按钮换行。
3. **三态显示**：`checked = coverageOf(...) === 'all'`，`indeterminate = 'partial'`；被祖先覆盖的行加浅色 + 行尾小字 `来自 <祖先末段>`（`title` 给完整前缀）。
4. **点击语义**改为集合语义，且必须 `async`：
   - 加：`onChange(addToScope(scope, rel))`；
   - 减：先 `removeFromScope`；返回 `null` 时说明要炸开尚未加载的祖先 → 逐个 `await loadRaw(anc)` 再重试；成功后若仍 `null`（超软上限）→ `showToast` 说明，不改状态。
   - 删除 `:60` 那条静默 `return`（`F-2` 的第二个症状就是它）。
5. **新增 `childrenRaw` state**：`loadRaw(rel)` 存**未过滤**的 `r.entries`（目录 + 全部文件），只喂给「炸开」和「全选顶层」；树显示仍用套了 `MD_EXTS` 的 `children`。**理由见 §3.1，这条不能省。**
6. `disabled`（运行中锁定）通道覆盖摘要行的动作按钮，与树内复选框对称。

### 2.3 `index.tsx`

- 段头右侧 `:219-221`：现在会显示 `N 项` / `未选择`，与摘要行的计数重复。改为**只承担状态**：`api.pending ? '运行中 · 已锁定' : null`；空态与计数交给摘要行。
- `adoptScopeCard` `:194`：`api.setScope(paths)` → `api.setScope(prunePrefixes(paths))`（建议卡一次给 8 条文件路径，若其中一条是另一条所在目录，应塌成目录前缀）。
- `:216` 的 `maxHeight: '56%'` **保留**，注释补一句：chip 已移除，段高恒定，不再存在「chip 每长一行从树上割」；限高仍在，是为了让树不吞掉任务段。

## 3. 三条必须先钉住的口径（踩坑点）

### 3.1 炸开 / 全选必须用**未过滤**子项，否则会静默缩小范围

前缀 `'A'` 覆盖 `A` 下**一切**文件（含 `.png` / `.pdf`，主进程 `isWithinVaultScope` 不看扩展名）。而树把非 `.md/.txt` 过滤掉了（`ScopePane.tsx:39`）。若「在 A 里单独取消一项」时按树的清单炸开，`A/图片.png` 就**掉出作用域**——用户只是取消了一个 md 文件，AI 却突然读不到图片，且只在模型侧报 `ESCOPE`，界面上毫无线索。⇒ 炸开与全选顶层都走 `childrenRaw`。契约配一条负向断言：炸开/全选路径不得引用 `MD_EXTS` 过滤结果。

### 3.2 三态显示精度受懒加载约束

未展开过的目录拿不到子项，**无法**判断「部分覆盖」。取「未知 = 显示未勾」：一旦展开即按真实三态刷新。代价：勾了 `A/B` 后，收起状态的 `A` 显示未勾（与今天一致，不算回退）。**不为此引一次全库扫盘**，也不新增主进程覆盖统计 IPC —— 那属于另开条目。

### 3.3 条目数软上限

`agentSessionRepo.ts:413` 在落库时**静默截断到 500 条**。炸开大目录可能一次产出上百条前缀，超限时界面显示 N 项、重开后只剩 500 项 —— 典型的「无报错的丢数据」。⇒ `SCOPE_ENTRY_SOFT_CAP = 400` 前置守卫，超了就 Toast 拒绝并建议改勾上层目录（或走 `.ignore` 排除）。

## 4. 契约（`.AGENT/scripts/ai-assistant/verify-scope-guard.mjs`）

- **§H 纯函数用例表**（直接 `import` `scopeSetPure.ts`）：`prunePrefixes` 幂等 + 顺序无关；`coverageOf` 的 all / partial / none × 子项未知退化路径；`removeFromScope` 在「兄弟保持选中」下的炸开结果（原型里那条 1 条 → 4 条的用例）；软上限返回 `null`。
- **接线断言**：`indeterminate` 在位；`childrenRaw` 与 `loadRaw` 在位；摘要行在位。
- **负向断言**（先 `stripComments`，本模块注释里写着旧代码，不剥会假 FAIL）：① `ScopePane` 不再渲染 chip（禁 `scope.map` + `flex-wrap`）；② 禁 `MD_EXTS` 出现在炸开/全选路径；③ 禁 `ScopePane.tsx` 里对 covered 行的裸 `return`（`F-2` 的根因，防回归）。
- 现有 `G14`（运行中置灰）/ `G15`（双击改名）/ `G16`（模块不自持 scope）三条**不动**，`G15` 注释补「`F-4` 拍板按设计保留」。

## 5. 批量入口放哪（已定 = 摘要行同位单按钮）

侧栏 300px，一行塞不下「计数 + 三个按钮」。取**同位单按钮、按语境换语义**：

| 状态 | 摘要行长这样 |
|---|---|
| 未圈定 | `未圈定范围` …… `全选顶层` |
| 已圈定、无过滤 | `已选 N 项` …… `全部取消` |
| 已圈定、搜索框有词 | `已选 N 项 · 命中 M` …… `全选可见(M)` |

`全选可见` = 当前过滤命中的**已加载**节点（不递归扫盘，口径与 `WebSourceDialog` 先例一致）；要回到 `全部取消` 只需清空搜索框。这样三个动作都在、行高恒定、也不会出现「两个全选按钮并排谁管谁」。

## 6. 验收

- 契约：`node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-scope-guard.mjs` **94/94 PASS**（新增 §H 43 条）；两份 tsc 门禁均 clean；`npm run build` 通过。
- 真机（沙箱起不了 GUI，需你点）：① 勾顶层目录 → 展开 → 子项显示「来自 X」且实勾/半选正确；② 在大目录里单独取消一个文件 → 其余兄弟仍勾、`N 项` 按预期变多；③ 选到 20 项 → 树高不动、无 chip；④ 运行中摘要行按钮置灰；⑤ 大目录炸开超软上限时给出 Toast 而非静默截断；⑥ 未圈定时发送仍走建议作用域卡。**这六项本轮均未验。**
- 收尾已同步 `resources/help/AI助手.md`：作用域一节改写（chip 已取消 → 摘要行只报数、三态勾选框、「来自 X」、批量按钮语义、400 条上限、锁定期按钮置灰），keywords 补「全选 / 全部取消 / 半选 / 已选几项 / 范围上限」等检索词；帮助检索验收 `node .AGENT/scripts/help-kb/verify-help-retrieval.mjs` **156/156 通过**。`resources/help/AI 权限与工具边界.md` 讲的是右栏助手与工具权限，不涉及本面板，未改。

## 7. 版本归属（已定 = 随 3.9.x 补丁线）

定性为「v3.9.0 新面板的显示口径纠正 + 缺失入口补齐」，不是新增能力 ⇒ 进 **`3.9.x`**，不抬 `3.10.0`。连带口径：`CHANGELOG.md` 措辞用「修正 / 补齐」，不用「新增」；版本号只在真正发版时抬（`package.json` → `CHANGELOG.md` 段名 → 重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`，见 `AGENTS.md` 铁律 24）。

# 附件入仓库（3.9.2）实现方案

> 状态：已实现（3.9.2）—— 契约 `verify-attachment-store` 55/55 + 4 条变异测试 + Electron 集成探针 14/14
> 目标版本：3.9.2（Linux 端口线）
> 决策依据：Vault = 唯一真相源。一个文件夹 = 一个仓库，仓库里的图片/PDF/头像必须只属于这个仓库。

## 1. 问题与目标

现状：`.knowbase/modules/attachments/registry.json` 是仓库内的台账，但文件本体写在**全局** `userData/attachments`，导致：

- 换电脑/换系统：图全丢（Windows 的 `%APPDATA%\knowbase\attachments` 不会跟着仓库走）；
- 台账里 168/176 条 `file_path` 是 Windows 反斜杠，Linux 解析不出（`\` 被当普通字符 → 404）；
- `userData/attachments` 被多个仓库共用，文件不属于任何单个仓库；
- 备份「拷走文件夹」不完整。

目标：

1. 附件文件落进仓库 `<vault>/.attachments/`（与 AI 生图、知识包图片同一附件区）；
2. 读路径兼容旧 `userData/attachments`（只读回退，不破坏旧版 Windows）；
3. 台账里的相对路径一律 POSIX（`/`），读写双向归一化；
4. 迁移幂等、原子、不覆盖、可回滚；
5. 不改变 `attachment://<id>/` 与 `attachment://vault/<pageId>/<file>` 两个协议的外部语义。

## 2. 目标布局

```
<vault>/.attachments/
  moments_post/_pending/<uuid>.jpg              # 说说（上传时未认领）
  moments_post/<postId>/<uuid>.jpg              # 说说（认领后）
  knowledge_page/<pageId>/<uuid>.png            # 编辑器插图 / 页面图片
  blog_entry/<entryId>/<uuid>.png               # 博客配图
  user_profile/default/avatar_<ts>.png          # 头像
  2026-10/<name>.png                            # AI 生图（既有，不动）
  knowledge_page/<pageId>/<原文件名>             # 知识包导入（既有，靠 attachment://vault）
```

关键点：

- 台账 `file_path` / `thumb_path` 的**语义不变**（相对「附件根」），只是附件根从 `userData/attachments` 变成 `<vault>/.attachments`。因此迁移**不需要改写 176 条路径**，只需搬文件 + 归一化分隔符。
- `.attachments` 是点目录，天然不进知识库索引/搜索/图谱。
- 知识包导入已经用 `.attachments/knowledge_page/<pageId>/<原文件名>`，与附件台账的 `knowledge_page/<pageId>/<uuid>.png` 同目录共存，文件名不同，不冲突。

## 3. 路径解析（新模块，零依赖）

新增 `electron/lib/kbStore/attachmentPath.ts`（纯函数，契约脚本可直接 import）：

```ts
/** 反斜杠→斜杠；拒绝空/绝对/盘符/UNC/NUL；不负责 containment */
export function normalizeRel(rel: unknown): string | null

/** POSIX 拼接：ownerType/ownerId/<id><ext>（永远出 `/`） */
export function attachmentRel(ownerType: string, ownerId: string, id: string, ext: string): string

/** 候选绝对路径：仓库内优先，旧 userData 兜底 */
export function attachmentCandidates(vaultRoot: string | null, legacyRoot: string, rel: string): string[]

/** 在候选里找第一个存在且落在基座内的路径 */
export function resolveExisting(candidates: string[], rel: string): string | null

/** 迁移计划：旧目录存在、新目录缺失的条目（幂等） */
export function planMigration(rows: Array<{ id: string; file_path: string; thumb_path: string }>): Array<{ id: string; rel: string }>
```

安全口径：先 `normalizeRel`，再交给现有 `safePathInside`（`electron/lib/pathGuard.ts`）做 containment。`..\..\x` 归一化后仍会越界 → 被拒；`C:\`、`//server/share` 直接拒。

## 4. 读路径

`getAttachmentFilePath(id, thumb)`：

1. 取台账行；`normalizeRel(thumb ? thumb_path : file_path)`；
2. `<vault>/.attachments/<rel>` 存在 → 返回；
3. 旧 `<userData>/attachments/<rel>` 存在 → **复制**到 2（`<rel>.tmp-<uuid>` → `rename` 原子提交），成功返回新路径；失败则返回旧路径（本次仍可用）；
4. 都不存在 → `null`（协议层 404，界面显示破图占位）。

同一规则用于：`attachment:getPath`、`attachment:readBase64`、`attachment://<id>/` 协议、PDF 阅读器。

## 5. 写路径

- `attachment:uploadMany`、`attachment:uploadFromPath`、头像保存：直接写 `<vault>/.attachments/...`；
- 无当前仓库 → 抛 `当前没有打开的仓库`；
- 写失败（只读挂载/磁盘满）→ **抛错**，由界面 Toast 呈现；**不静默回退 userData**（否则又会分裂）；
- `file_path` / `thumb_path` 一律用 `posix.join` 生成（Linux 上写出的台账 Windows 也能用）。

## 6. 删除与回收

- 回收区改为 `<vault>/.knowbase/attachments_trash/<binId>/<basename>`；
- `trash_path` 仍是 `attachments_trash/<binId>/<basename>`（相对 `.knowbase`），分隔符 POSIX；
- `restoreAttachments`：基座 `<vault>/.knowbase`；读到旧值（无 `.knowbase/` 前缀或旧 userData 布局）时回退旧基座，恢复后重写为新布局；
- `deleteAttachments`：删仓库副本；旧 userData 里若还有同名副本一并删（仅台账指向的那一条）；
- `cleanupOrphans`：同一套解析器。
- 取舍：回收区进仓库 = 已删附件会随仓库同步到另一系统。可接受（同一仓库的历史），且恢复在两端都可用。

## 7. 一次性迁移

`ensureAttachmentStoreMigrated()`（`attachmentRepo.ts` 内部）：

- 触发：每仓库每会话第一次附件类 IPC（`getAttachmentFilePath` / `getAttachmentsForIds` / upload / trash / restore / delete），模块级 `Map<rootId, Promise>` 去重；
- 范围：台账里 `file_path`、`thumb_path` 在旧目录存在、新目录缺失的条目；
- 方式：**复制**，不删旧（旧版 Windows 仍能读）；
- 原子：临时文件 + `rename`；
- 失败：记日志、跳过该条、不阻塞（读路径仍有旧目录回退）；
- 幂等：目标已存在一律跳过，绝不覆盖；
- 头像：`avatar_path` 走同一套（见 §8），旧值 `attachments/user_profile/...` 在迁移时复制到仓库；
- 迁移完成后不写任何标记字段（避免污染共享 schema）；靠「目标存在即跳过」保证幂等。

旧目录清理：等两端都升到 3.9.2 后，手动删 `%APPDATA%\knowbase\attachments`（Windows）/ `~/.config/knowbase*/attachments`（Linux）。方案不自动删。

## 8. 头像（`avatar_path`）

现状：`userRepo.ts` 存 `attachments/user_profile/default/<file>`，读时 `join(userData, avatar_path)`。

改法：

- 新写入：`avatar_path = user_profile/default/<file>`（与台账同基座）；
- 读/导出/导入统一走解析器：
  1. `<vault>/.attachments/<avatar_path>`；
  2. 若以 `attachments/` 开头：`<vault>/.attachments/<去掉前缀>`；
  3. 旧 `<userData>/<avatar_path>`（兼容 Windows 旧值）。
- `user:getAvatarBase64`、`user:getExportData`、`user:restoreFromImport`、`user:saveAvatar` 四处同步改。

## 9. IPC 与渲染层

- `app:getAttachmentsPath`：返回 `<vault>/.attachments`（无仓库返回 `''`）；
- `PageEditor.tsx`：删掉 `${attachmentsPath}\\${page.contentMd}` 这种 Windows 专有拼接（Linux 上必坏），改为新增 IPC `attachment:resolveRel(rel)`（主进程做 vault-first / legacy 回退），返回绝对路径给 `openExternal`；
- `attachment://vault/<pageId>/<file>` 分支不变（本来就是仓库内 + POSIX）；
- 协议层 `attachment://<id>/` 不变，内部改走新解析器。

## 10. 改动文件

| 文件 | 改动 |
|---|---|
| `electron/lib/kbStore/attachmentPath.ts` | **新增**：归一化 / 拼接 / 候选 / 迁移计划（零依赖） |
| `electron/lib/kbStore/vaultContext.ts` | 复用已有 `getVaultAttachmentsRoot()`；不加新 API |
| `electron/lib/globalPaths.ts` | `getAttachmentsDir()` 改为**旧布局专用**（重命名 `getLegacyAttachmentsDir()`，保留导出别名避免漏改） |
| `electron/database/repositories/attachmentRepo.ts` | 读/写/回收/清理/注册全部改基座；新增 `ensureAttachmentStoreMigrated()`；`file_path` 用 POSIX |
| `electron/database/repositories/userRepo.ts` | 头像四处改用解析器；新值去掉 `attachments/` 前缀 |
| `electron/main/index.ts` | `app:getAttachmentsPath` 返回仓库附件区；新增 `attachment:resolveRel` |
| `electron/preload/index.ts` + `src/lib/ipc.ts` + `src/types/index.ts` | 新 IPC 的桥接与类型 |
| `src/modules/knowledge/components/PageEditor.tsx` | 去掉反斜杠拼接 |
| `.AGENT/scripts/attachments/verify-attachment-store.mjs` | **新增**契约脚本 |
| `CHANGELOG.md` + `electron/lib/releaseNotes/data.ts` | 3.9.2 条目；改完重跑 `build-release-notes.mjs` |

## 11. 契约与验证

新脚本 `.AGENT/scripts/attachments/verify-attachment-store.mjs`（`node --experimental-strip-types`）：

§1 归一化

- `a\\b\\c.jpg` → `a/b/c.jpg`
- `./a/../b.jpg` → 合法（containment 通过）
- 拒绝：`..\\..\\x`、`C:\\x`、`C:/x`、`//server/share`、`/etc/passwd`、空串、含 `\0`

§2 拼接

- `attachmentRel('moments_post','_pending',id,'.jpg')` 恒出 `/`，任何平台
- ext 缺 `.` 时补

§3 候选与回退

- 仓库命中 → 仓库
- 仓库缺失 + 旧命中 → 旧（并断言「复制目标」存在）
- 双缺失 → null
- 双命中 → 仓库优先

§4 迁移计划

- 旧存在/新缺失 → 计划 1 条
- 第二次计划 0 条（幂等）
- 新已存在（内容可能更新）→ 不覆盖
- 反斜杠台账 → 计划里的 rel 是 `/`

§5 注册/写入形状

- `file_path`、`thumb_path`、`trash_path` 三处写入口都必须过 `normalizeRel`
- 断言 pin 调用点形状（不是函数定义），按仓库既有变异测试口径

变异测试（必须红）：

1. 删掉 `normalizeRel` 里的 `replace(/\\/g,'/')`；
2. 把「仓库优先」改成「旧目录优先」；
3. 把迁移的「目标存在则跳过」删掉；
4. 把写路径的 `posix.join` 换回 `path.join`（Linux 下可通过、断言必须拦住）。

门禁：`npx tsc --noEmit -p tsconfig.node.json`、`-p tsconfig.web.json`、`npm run build`、既有 `verify-linux-port` / `verify-pack-dir` / `verify-release-notes` / help-retrieval。

## 12. 真机验收（不碰你的真实仓库）

1. 复制一份仓库到 `/tmp/opencode/attachment-fixture-vault`（只复制 `.knowbase/modules/attachments/registry.json` + 少量 md/图片）；
2. 造一个临时 userData（`KNOWBASE_*` 或直接放 `/tmp/opencode/legacy-userdata/attachments`）放旧文件；
3. 启动 dev，验证：说说图、头像、博客图、知识库页面图都显示；`file_path` 在保存后变 `/`；
4. 反向验证：删掉仓库里的副本 → 自动从旧目录复制回来；
5. 只读/缺文件 → 破图占位 + 控制台明确日志，不崩；
6. 迁移后再用旧逻辑读（模拟 Windows 3.9.1）→ 旧目录文件仍在，可读。
7. `npm run pack` 出 deb，装/不装各冒烟一次。

## 13. 风险与回滚

| 风险 | 处置 |
|---|---|
| 迁移复制占用双份磁盘 | 仅复制一次；两端升级后手动清旧目录；迁移前提示 |
| 旧版 Windows 读不到新文件 | 不删旧文件，旧版继续读 userData |
| 迁移中途失败 | 临时文件 + rename；失败跳过；读回退旧路径 |
| 回收区随仓库跨系统 | 接受（同仓库历史）；恢复两端可用 |
| 只读挂载 | 上传抛错，界面 Toast；不静默回退 |
| 迁移期两系统同时写 | 双系统不能同时启动；单实例锁已有 |
| 回滚 | 代码回退即可；旧文件一直在；新建的 `.attachments` 副本可留可删，不影响旧版 |

## 14. 不在本次范围

- 仓库身份（rootId）写进 `.knowbase/meta.json`（PDF 阅读进度/摘录跨系统分裂）——建议另开一条；
- 134 条无引用附件台账 + 5 条历史 PDF 记录的清理；
- 高数那批 md 里 30 处 `attachment://image.png` 无效引用；
- 附件去重、压缩、缩略图重建。

## 15. 已拍板

1. 迁移用「复制」—— 旧版 Windows 仍可读；两端升级后再手动清旧目录。
2. 回收区进仓库（`<vault>/.knowbase/attachments_trash/`）。
3. rootId 统一不放进 3.9.2（另开一条）。

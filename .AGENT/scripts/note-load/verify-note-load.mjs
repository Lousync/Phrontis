#!/usr/bin/env node
/**
 * 契约：笔记区「切页装载」的健壮性（2026-10-13，v3.5.0 线；反馈 F-7）。
 *
 * 反馈原话：「从一个空文件切换到其他文件的时候，切过去的那个文件不显示内容，
 *           但是如果是从一个有内容的文件切到其他文件就会显示内容」。
 *
 * 只读调查（PageEditor.tsx / knowledgeVaultRepo.ts / workspaceManager.ts）结论：
 *   ① **装载失败时组件什么都不做**（`if (p)` 之外没有"加载中 / 取不到"分支去动 content）
 *      ⇒ 界面**静默停在上一页的正文**上：从空文件切走 = 停在空白（看着像"新文件没内容"）；
 *        从有内容的文件切走 = 上一页正文还在（看着"正常"，其实是**假正常**）。
 *   ② 三条异步装载链没有"迟到即丢弃"守卫（`loadPage` 的 .then / `loadDraftPage` / `loadVaultBaseline`），
 *      迟到的结果会盖到新页上（`loadVaultBaseline` 尤其危险：它写的是**保存基线**）。
 *   ③ 归档类（非 md）正文由自读 effect 补，而它不会在 `isReload` 重读后重跑 ⇒ 内容置空后永不自愈。
 *   ④ `retryRef` 单槽且成功后不复位 ⇒ 同一 pageId 一生只重试一次（编辑器实例随 Tab 常驻整个会话）。
 *
 * 本契约把这几条**修好之后不许退回去**变成机器可查，并配负向断言（旧的静默分支必须消失）。
 * ★ 说明：真正"为什么那次 getKnowledgePageById 会失败"需要真机探针（本沙箱起不了 Chromium），
 *   所以这里守的是**失败时的行为**（可见 + 不静默 + 不覆盖新页），而不是某一条具体成因。
 *
 * 跑法：node --experimental-strip-types --no-warnings .AGENT/scripts/note-load/verify-note-load.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

let failures = 0
const ok = (label, detail) => console.log(`  [OK]   ${label}${detail ? ' —— ' + detail : ''}`)
const bad = (label, detail) => { failures++; console.error(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
const check = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

const PAGE = read('src/modules/knowledge/components/PageEditor.tsx')
/** 剥注释：负向断言别被解释性注释判红（这一坑在 page-menu §12 与 schedule-recurring 都踩过） */
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const PAGE_NC = noComments(PAGE)

// ---------------------------------------------------------------- §1 迟到即丢弃

console.log('\n§1 三条异步装载链：迟到即丢弃（别让上一页的结果盖到新页上）')

check('loadPage 记下"本次请求的 pageId"', /const requested = pageId/.test(PAGE))
check('★ .then 里先校验"还是不是当前页"，不是就直接返回',
  /getKnowledgePageById\(pageId\)\.then\(p => \{[\s\S]{0,200}if \(pageIdRef\.current !== requested\) return/.test(PAGE))
check('★ loadVaultBaseline 收 expectPageId 并在写入前校验（它写的是**保存基线**：前缀 + mtime）',
  /const loadVaultBaseline = useCallback\(async \(rel: string, expectPageId\?: string\)/.test(PAGE)
  && /if \(expectPageId && pageIdRef\.current !== expectPageId\) return/.test(PAGE))
check('调用处把 requested 传进去（不传 = 守卫是空转）', /void loadVaultBaseline\(p\.path, requested\)/.test(PAGE))
check('loadDraftPage 同样有守卫（草稿伪页路径）',
  /if \(pageIdRef\.current !== `draft:\$\{rel\}`\) return/.test(PAGE))

// ---------------------------------------------------------------- §2 取不到页面：可见 + 可重试

console.log('\n§2 取不到页面：不再静默停在上一页，也不再默默 onBack')

check('有 loadMiss 状态（这就是"能看见"的载体）', /const \[loadMiss, setLoadMiss\] = useState<string \| null>\(null\)/.test(PAGE))
check('★ 重试一次之后仍取不到 ⇒ 置 loadMiss（而不是什么都不做）',
  /if \(retryRef\.current !== pageId\) \{[\s\S]{0,200}setTimeout\(\(\) => \{ loadPageRef\.current\(\) \}, 500\)[\s\S]{0,80}return\s*\}[\s\S]{0,120}setLoadMiss\(requested\)/.test(PAGE))
check('★ 负向：旧的静默分支（`else if (pageRef.current)` + 默默 onBack）已经不存在',
  !/else if \(pageRef\.current\) \{/.test(PAGE_NC) && !/setLoadMiss\(requested\)[\s\S]{0,80}onBack\(\)/.test(PAGE_NC))
check('命中即复位 retryRef（下一次"索引还没重建"仍值得重试一次）', /retryRef\.current = null/.test(PAGE))
check('命中即清掉提示', /setLoadMiss\(null\)/.test(PAGE))
check('换页复位（上一个 pageId 的提示不跟着新页挂）',
  /useEffect\(\(\) => \{ setShowRename\(false\); setShowMove\(false\); setShowProps\(false\); setLoadMiss\(null\) \}, \[pageId\]\)/.test(PAGE))

// 提示条本身（探针可定位的锚点 + 一个真能重试的钮）
check('提示条有锚点 peLoadMiss', PAGE.includes('data-wb="peLoadMiss"'))
check('只在 loadMiss 时渲染', /\{loadMiss && \(/.test(PAGE))
check('★ 提示条给出"下面可能还是上一页的内容"（正是这条反馈的坑）', PAGE.includes('下面显示的可能还是上一页的内容'))
check('重试钮真的会重取（清提示 + 复位重试槽 + 调 loadPage）',
  /onClick=\{\(\) => \{ setLoadMiss\(null\); retryRef\.current = null; loadPageRef\.current\(\) \}\}/.test(PAGE))
check('提示条排在顶栏之后、正文之前（不挤掉正文容器）',
  PAGE.indexOf('data-wb="peLoadMiss"') > PAGE.indexOf('<NoteTopBar') && PAGE.indexOf('data-wb="peLoadMiss"') < PAGE.indexOf('{/* Content */}'))
check('用了既有动效令牌（铁律 13：不另造过渡）', /data-wb="peLoadMiss" className="[^"]*kb-view-in/.test(PAGE))

// ---------------------------------------------------------------- §3 归档类（非 md）自愈

console.log('\n§3 归档类正文：isReload 重读后要能自愈')

check('自读 effect 的依赖里有 selfReadTick',
  /\}, \[textSelfReadTarget, page\?\.path, pageId, selfReadTick\]\)/.test(PAGE))
check('★ 重读（isReload）且目标是归档条目时推进代次 —— 否则置空后永不自愈',
  /if \(isReload && p\.entryKind === 'file'\) setSelfReadTick\(t => t \+ 1\)/.test(PAGE))
check('负向：不在首次装载时也推进（否则大文件被读两遍）',
  !/if \(p\.entryKind === 'file'\) setSelfReadTick/.test(PAGE_NC))

// ---------------------------------------------------------------- §4 反例（证明上面不是空转）

console.log('\n§4 反例与回归保护')

check('反例：不存在的锚点在源码里找不到（证明 includes 类判据不是恒真）', !PAGE.includes('data-wb="peNoSuchThingXYZ"'))
check('回归：命中分支仍在灌正文（没有为了"不显示旧内容"把正常装载也砍掉）', /setContent\(p\.contentMd\)/.test(PAGE))
check('回归：归档条目的正文仍不由 loadPage 给（索引侧 contentMd 恒空，靠自读）',
  /p\.entryKind !== 'file'/.test(PAGE))

console.log('')
if (failures === 0) {
  console.log('PASS  笔记切页装载：迟到即丢弃 / 取不到看得见 / 归档自愈 / 旧静默分支已消失')
  process.exit(0)
}
console.error(`FAIL  ${failures} 项未通过`)
process.exit(1)

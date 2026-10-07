// 契约验证：PDF 书签两处体验修复（2026-09-23，开发负责人反馈）。
//
// 背景（两条独立反馈，都发生在 PDF 阅读器的左栏书签区）：
//   ① 「点收藏后第一体验是没反应」—— 左栏面板停在「目录」区，书签其实已加上，
//      但面板 section 是它的**组件内部 state**、收藏按钮在 PdfReaderView 工具栏，两者不通信。
//      修：新增事件 KB_BOOKMARK_SECTION_SHOW，阅读器**仅在新增加书签时**派发，面板据此切到书签区。
//   ② 「备注输入框太容易被选中改坏」—— 原先整卡就是一个裸 input，点条目想跳页却落到输入框。
//      修：备注默认只读，点备注文本/图标才进编辑；卡片其余处一律跳页。
//
// 为什么用静态断言：这三个组件都静态 import pdfjs-dist（浏览器 worker、`?url` 导入），
//   strip-types 在 node 里跑不起来。故本脚本锁**源码结构与接线**；运行期判据需实机。
//
// 运行（仓库根目录）：
//   node .AGENT/scripts/pdf-reader/verify-bookmark-ux.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'))

const EVENTS = 'src/components/shared/pdf/pdfEvents.ts'
const VIEW = 'src/components/shared/pdf/PdfReaderView.tsx'
const PANEL = 'src/components/shared/pdf/PdfRailPanel.tsx'
const LIST = 'src/components/shared/pdf/PdfBookmarkList.tsx'

const ev = read(EVENTS)
const view = read(VIEW)
const panel = read(PANEL)
const list = read(LIST)

// ===== ① 事件常量：定义在 pdfEvents（铁律 20：常量不得拖 pdfjs 进主包）=====
console.log('\n--- ① 事件常量 KB_BOOKMARK_SECTION_SHOW ---')
check('定义在 pdfEvents.ts', /export const KB_BOOKMARK_SECTION_SHOW\s*=\s*'kb-bookmark-section-show'/.test(ev))

// ===== ② 派发侧：仅「新增」派发，移除不派发 =====
console.log('\n--- ② PdfReaderView：仅新增书签时派发 ---')
check('import 了该常量', /import\s*\{[^}]*KB_BOOKMARK_SECTION_SHOW[^}]*\}\s*from\s*'\.\/pdfEvents'/.test(view))
// 派发必须在 toggleBookmark 内、且带 !has 守卫（has === true 是移除分支，不该切区）
const tb = (view.match(/const toggleBookmark = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/) || [])[1] || ''
check('★ 派发点在 toggleBookmark 内', tb.includes('KB_BOOKMARK_SECTION_SHOW'), tb ? 'found in fn' : 'fn 未匹配')
check('★ 派发受 !has 守卫（移除时不切区）', /if\s*\(\s*!has\s*\)\s*window\.dispatchEvent\(new CustomEvent\(KB_BOOKMARK_SECTION_SHOW/.test(tb))
check('派发带 relPath（供面板过滤「是不是给我的书」）', /KB_BOOKMARK_SECTION_SHOW[^)]*detail:\s*\{\s*relPath/.test(tb))
// 依赖数组要带 relPath（否则闭包捕获旧的）
check('toggleBookmark deps 含 relPath', /\}, \[bookmarks, scheduleProgress, relPath\]\)/.test(view))

// ===== ③ 监听侧：面板切到 bookmarks 区 + relPath 过滤 =====
console.log('\n--- ③ PdfRailPanel：监听并切到书签区 ---')
check('import 了该常量', /import\s*\{[^}]*KB_BOOKMARK_SECTION_SHOW[^}]*\}\s*from\s*'\.\/pdfEvents'/.test(panel))
check('addEventListener(KB_BOOKMARK_SECTION_SHOW)', /addEventListener\(KB_BOOKMARK_SECTION_SHOW/.test(panel))
check('配套 removeEventListener（防泄漏）', /removeEventListener\(KB_BOOKMARK_SECTION_SHOW/.test(panel))
check('★ 收到后 setSection(\'bookmarks\')', /setSection\('bookmarks'\)/.test(panel))
// 监听 effect 体：relPath 过滤 + 切区，都在同一个 useEffect 内
const secEffect = (panel.match(/useEffect\(\(\) => \{[\s\S]*?KB_BOOKMARK_SECTION_SHOW, on\)[\s\S]*?\}, \[relPath\]\)/) || [])[0] || ''
check('★ relPath 过滤：不是我的书不切（与 KB_PDF_PAGE_CHANGED 同惯例）',
  /d\?\.relPath && d\.relPath !== relPath/.test(secEffect), secEffect ? 'in effect' : 'effect 未匹配')
check('★ 该 effect 依赖 relPath（换书后过滤器用的是新值）', /\[relPath\]\)/.test(secEffect))
// 三区 tab 仍在（切区目标必须存在）
for (const s of ['outline', 'thumbs', 'bookmarks']) {
  check(`三区切换按钮含 '${s}'`, new RegExp(`setSection\\('${s}'\\)`).test(panel))
}

// ===== ④ 备注输入框：默认只读、点备注才编辑 =====
console.log('\n--- ④ PdfBookmarkList：备注默认只读 ---')
check('有 editing 状态（null = 全部只读）', /useState<number \| null>\(null\)/.test(list))
check('编辑态才渲染 <input>', /isEditing\s*\?\s*\(\s*<input/.test(list))
check('★ 非编辑态渲染的是按钮（不是只读 input）', /data-wb="pdfBookmarkEdit"/.test(list))
check('★ 点备注按钮才 setEditing(b.page)', /onClick=\{\(\)\s*=>\s*setEditing\(b\.page\)\}/.test(list))
check('进入编辑自动聚焦', /useEffect\([\s\S]{0,200}?inputRef\.current\?\.focus\(\)/.test(list))
check('Enter 提交（blur 触发 onBlur 落库）', /e\.key === 'Enter'[\s\S]{0,80}?\.blur\(\)/.test(list))
check('Esc 放弃编辑（回滚 value 并退出）', /e\.key === 'Escape'[\s\S]{0,120}?setEditing\(null\)/.test(list))
// 跳页入口仍在（改备注不该吃掉跳页能力）
check('跳页按钮仍在', /onClick=\{\(\)\s*=>\s*onJump\(b\.page\)\}/.test(list))
check('删除按钮仍在', /data-wb="pdfBookmarkDel"/.test(list))

// ===== ⑤ 负向：不该出现的旧形态 =====
console.log('\n--- ⑤ 负向断言（旧形态不得复活） ---')
// 旧形态：裸 input 靠 focus:bg 表现可编辑性、无 editing 门控
check('★ 负向：不再有「裸 defaultValue input + onBlur 落库」这一无门控形态',
  !/defaultValue=\{b\.note\}[\s\S]{0,200}?onBlur[\s\S]{0,120}?\n\s*\/>\s*\n\s*<\/div>/.test(list))
check('★ 负向：面板不得在新增书签路径上写盘（写盘是阅读器职责，见 KB_BOOKMARK_DELETE 同口径）',
  !/KB_BOOKMARK_SECTION_SHOW[\s\S]{0,300}?pdfReaderPatch/.test(panel))

console.log('\n' + '='.repeat(40))
console.log(pass ? '✅ PDF 书签体验契约全部通过' : '❌ 有断言失败 —— 见上面的 fail 行')
process.exit(pass ? 0 : 1)

/**
 * 契约脚本：笔记区顶栏（对齐 Obsidian）+ 页面访问历史
 * 拍板记录：2026-10-11 两轮讨论（原型 `tmp/note-topbar-proto/index.html`）
 *
 * 覆盖的缺陷面（每条都是「不报错但坏掉」的类型）：
 *   ① **历史栈规则写飞** —— 前进分支不截断 / 与栈顶重复入栈 / 超上限不丢最旧 / 失效条目被跳过
 *      （失效不跳过 = 点了没反应，用户只当按钮坏了）→ 用纯函数跑用例表；
 *   ② **顶栏只在 md 生效**被写漏 —— 非 md 同时出现顶栏与悬浮胶囊（两套按钮重叠）或 md 下胶囊
 *      仍挂着一颗空丸（真源 = index.css 的 `:not(:has(button))` 隐身规则 + PageEditor 的 `!isMdNote` 门）；
 *   ③ **分隔线回来了** —— 顶栏 / 页面条任一处再长出 hairline，就破坏了「与正文连成一整片」的拍板；
 *   ④ **文件格式只剩一处** —— 拍板要求 ⋮ 与编辑器右键菜单**两处都有**，且落点只有一个（applyFileType）；
 *   ⑤ **Alt+←/→ 被 isEditingInput 吞掉** —— 顺序写反的后果是「编辑器里按了没反应」，而这是主用法；
 *   ⑥ **快捷键补偿缺失** —— 插图 / 脚注收进 ⋮ 之后必须能用键盘一步到位（拍板 E2）。
 *
 * 用法（同其它契约脚本）：
 *   node .AGENT/scripts/note-topbar/verify-note-topbar.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'
import {
  NAV_HISTORY_CAP, emptyNav, pushNav, stepNav, canNavBack, canNavForward, currentNav,
} from '../../../src/modules/knowledge/navHistory.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

// ===================== A 组：历史栈纯函数（用例表）=====================

{
  const empty = emptyNav()
  ok(empty.stack.length === 0 && empty.index === -1, 'A1 空栈：index = -1')
  ok(!canNavBack(empty) && !canNavForward(empty) && currentNav(empty) === null,
    'A2 空栈：两个方向都不可用，当前条目为 null')

  const s1 = pushNav(empty, 'a')
  ok(s1.stack.join(',') === 'a' && s1.index === 0 && !canNavBack(s1),
    'A3 首个入栈：栈 [a]、不能后退')
  ok(empty.stack.length === 0, 'A4 纯函数：入栈不改写传入的 state（否则 React 里会漏更新）')

  const s2 = pushNav(s1, 'b')
  ok(s2.stack.join(',') === 'a,b' && s2.index === 1 && canNavBack(s2) && !canNavForward(s2),
    'A5 第二个入栈：栈 [a,b]、可后退不可前进')

  const s2b = pushNav(s2, 'b')
  ok(s2b.stack.join(',') === 'a,b' && s2b.index === 1, 'A6 与栈顶同 id 不入栈（连点同一页不撑重复条目）')

  ok(pushNav(s2, '').stack.join(',') === 'a,b', 'A7 空 id 入栈时原样返回')

  const back = stepNav(s2, -1, () => true)
  ok(back.id === 'a' && back.state.index === 0 && canNavForward(back.state),
    'A8 后退到 a，且此后可前进')

  const trunc = pushNav(back.state, 'c')
  ok(trunc.stack.join(',') === 'a,c' && trunc.index === 1 && !canNavForward(trunc),
    'A9 从中间后退后再开新页：前进分支被截断（浏览器同款语义）')

  let capped = emptyNav()
  for (let i = 0; i < NAV_HISTORY_CAP + 10; i++) capped = pushNav(capped, 'id' + i)
  ok(capped.stack.length === NAV_HISTORY_CAP,
    `A10 超过上限后长度恒为 ${NAV_HISTORY_CAP}`, String(capped.stack.length))
  ok(capped.stack[0] === 'id10' && capped.stack[capped.stack.length - 1] === `id${NAV_HISTORY_CAP + 9}`,
    'A11 超限时丢的是**最旧**的一条（不是丢新的、也不是清空）')

  // 失效条目跳过：b 已被删/关
  const three = pushNav(pushNav(pushNav(emptyNav(), 'a'), 'b'), 'c')
  const skip = stepNav(three, -1, (id) => id !== 'b')
  ok(skip.id === 'a' && skip.state.index === 0, 'A12 后退时跳过失效条目（页面被删 / 页签被关）')

  const allDead = stepNav(three, -1, (id) => id === 'c')
  ok(allDead.id === null && allDead.state.index === three.index,
    'A13 整段都失效时不跳、state 原样返回（按钮随之保持禁用，不给假反馈）')
}

// ===================== B 组：源码接线（静态断言）=====================

const SRC_TOPBAR = stripComments(read('src/modules/knowledge/components/NoteTopBar.tsx'))
const SRC_PAGE = stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))
const SRC_MODULE = stripComments(read('src/modules/knowledge/index.tsx'))
const SRC_MENU = stripComments(read('src/components/shared/NoteContextMenu.tsx'))
const SRC_ACTIONS = stripComments(read('src/lib/noteActions.ts'))
const SRC_PAGEBAR = stripComments(read('src/components/workbench/WorkbenchPageBar.tsx'))

// ---- B1 顶栏组件与锚点 ----
for (const a of ['noteTopBar', 'noteTopBack', 'noteTopForward', 'noteTopTitle', 'noteSaveDot', 'noteTopMore', 'noteTopMoreMenu']) {
  ok(SRC_TOPBAR.includes(`data-wb="${a}"`), `B1 顶栏锚点 ${a}`)
}
for (const a of ['inlineSuggestBtn', 'inlineBusy', 'inlinePaused', 'inlineOffSlash']) {
  ok(SRC_TOPBAR.includes(`data-wb="${a}"`), `B2 旧锚点原样搬到顶栏：${a}（探针 G 系按属性全局查，改名即失配）`)
}
ok(SRC_TOPBAR.includes('data-wb-inline-off'), 'B3 关闭态仍以 data-wb-inline-off 表达（探针 G3/G6/G7 语义不变）')
ok(/h-10\b/.test(SRC_TOPBAR), 'B4 顶栏高度 = 40px（拍板 A1）')
ok(!/h-px/.test(SRC_TOPBAR), 'B5 负向：顶栏不得有 hairline（拍板：与正文连成一整片）')
ok(!/runNoteAction|noteActions/.test(SRC_TOPBAR),
  'B6 负向：顶栏组件保持「纯展示」（不自己执行写作动作，菜单内容由 PageEditor 传入）')

// ---- B7 md 分流：顶栏只在 md，胶囊只在非 md ----
ok(/const isMdNote = fileType === 'md'/.test(SRC_PAGE), 'B7 分流判据唯一：isMdNote = fileType === \'md\'')
ok(/\{isMdNote && \(\s*<NoteTopBar/.test(SRC_PAGE), 'B8 md 笔记渲染顶栏')
ok(/!isMdNote && createPortal/.test(SRC_PAGE),
  'B9 旧悬浮胶囊只在非 md 时 portal（md 下不 portal → 胶囊被 index.css 的空胶囊规则隐身）')
ok(SRC_PAGE.includes('initialFileType'), 'B10 文件类型预置（避免顶栏 loadPage 完成前闪一帧）')

// ---- B11 页面条 hairline 已删 ----
ok(!/bottom-0 h-px bg-\[var\(--border-color\)\]/.test(SRC_PAGEBAR),
  'B11 负向：页面条底部 hairline 已删（拍板 A2：从标签到正文一张底）')

// ---- B12 文件格式两处都有、落点只有一个 ----
ok((SRC_PAGE.match(/const applyFileType = useCallback/g) || []).length === 1,
  'B12 文件格式落点只有一处实现（applyFileType）')
ok((SRC_PAGE.match(/applyFileType\(/g) || []).length >= 3,
  'B13 至少三处消费同一落点（⋮ 二级子菜单 / 旧胶囊 chip / 右键菜单回调）',
  String((SRC_PAGE.match(/applyFileType\(/g) || []).length))
ok(/FILE_LANG_OPTIONS/.test(SRC_PAGE) && SRC_PAGE.includes('文件格式'),
  'B14 ⋮ 菜单内有「文件格式」二级子菜单（清单取 FILE_LANG_OPTIONS，不另抄一份）')
ok(/FILE_LANG_OPTIONS/.test(SRC_MENU) && /fileTypeActionId/.test(SRC_MENU) && /onFileType/.test(SRC_MENU),
  'B15 右键菜单同样有「文件格式」组，并把扩展名转交宿主')
ok(/onFileType/.test(stripComments(read('src/components/shared/NoteSurface.tsx'))),
  'B16 NoteSurface 把 onFileType 透传给右键菜单（少一层就等于没接）')
ok(/export type FileTypeActionId/.test(SRC_ACTIONS) && /export function fileTypeOfAction/.test(SRC_ACTIONS),
  'B17 noteActions 提供格式动作 id 空间与解析函数')
ok(!/from '\.\/fileTypes'/.test(SRC_ACTIONS),
  'B18 负向：noteActions 不得静态 import fileTypes（它要能被契约脚本零依赖 import，格式清单在菜单组件侧取）')

// ---- B19 历史栈接线 ----
ok(/from '\.\/navHistory'/.test(SRC_MODULE), 'B19 模块 import navHistory')
ok((SRC_MODULE.match(/pushNav\(/g) || []).length >= 3,
  'B20 入栈收口 ≥3 处（handleOpenPage / 沉浸阅读内跳转 / 图谱跳转）',
  String((SRC_MODULE.match(/pushNav\(/g) || []).length))
ok(/fromHistory: true/.test(SRC_MODULE) && /opts\?\.fromHistory/.test(SRC_MODULE),
  'B21 回退/前进复用 handleOpenPage 并跳过入栈（否则后退会原地打转）')
for (const p of ['canNavBack', 'canNavForward', 'onNavBack', 'onNavForward']) {
  ok(SRC_MODULE.includes(`${p}={`), `B22 模块向 PageEditor 传 ${p}`)
}

// ---- B23 Alt+←/→ 必须早于 isEditingInput 守卫 ----
{
  const altIdx = SRC_MODULE.indexOf('ArrowLeft')
  const guardIdx = SRC_MODULE.indexOf('if (isEditingInput(e)) return')
  ok(altIdx > -1 && guardIdx > -1 && altIdx < guardIdx,
    'B23 ★ Alt+←/→ 分支在 isEditingInput 早退**之前**（否则编辑器里按了没反应）',
    `alt@${altIdx} guard@${guardIdx}`)
  ok(/e\.altKey && !e\.ctrlKey && !e\.shiftKey[\s\S]{0,60}ArrowLeft/.test(SRC_MODULE) &&
     /e\.preventDefault\(\)[\s\S]{0,60}navStep\(/.test(SRC_MODULE),
    'B24 方向键分支带 preventDefault 并调 navStep（挡掉 Chromium 自带 Alt+← 后退）')
}

// ---- B25 快捷键补偿（拍板 E2）----
ok(/e\.ctrlKey && e\.shiftKey && !e\.altKey && \(e\.key === 'i'/.test(SRC_PAGE) && /imageInputRef\.current\?\.click\(\)/.test(SRC_PAGE),
  'B25 Ctrl+Shift+I 插图（收进 ⋮ 之后的键盘补偿）')
ok(/e\.ctrlKey && e\.altKey && !e\.shiftKey && \(e\.key === 'f'/.test(SRC_PAGE),
  'B26 Ctrl+Alt+F 脚注（Ctrl+Shift+F 已被左栏搜索占用，故换键位）')

// ===================== 结果 =====================

if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  [FAIL] ' + f)
  process.exit(1)
}

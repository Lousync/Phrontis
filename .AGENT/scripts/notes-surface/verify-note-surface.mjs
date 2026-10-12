/**
 * 契约脚本：双写作面（源码档 Monaco / 即时渲染档 CM6）+ 编辑器右键菜单
 * 方案：`docs/note-surface-dual-engine-design.md`
 *
 * 覆盖的缺陷面（每一条都是「不报错但坏掉」的类型）：
 *   ① **两档契约漂移** —— 某一档少实现一个方法，菜单项在那一档静默失效（没有异常、没有提示）；
 *      故用假引擎把 `noteActions` 的动作逐个跑一遍，断言产出的文本与选区；
 *   ② **菜单只做了一档** —— 源码档接了右键、即时渲染档没接（或反过来），用户切档后功能消失；
 *   ③ **双引擎同挂一个文件** —— 同一 relPath 同时被两个引擎持有 = 互相覆盖保存；
 *   ④ **CM6 进首屏静态闭包** —— 铁律 20：大依赖必须惰性，否则默认源码档的用户白付体积；
 *   ⑤ **段落/格式动作的行前缀处理错**（标题叠加成 `## # abc`、引用切不掉、任务列表切不掉）；
 *   ⑥ **切档光标记忆串档**（源码档的位置被写到即时渲染档，切回来乱跳）。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/notes-surface/verify-note-surface.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { NOTE_MENU, runNoteAction, isNoteActionEnabled } from '../../../src/lib/noteActions.ts'
import { rememberCursor, recallCursor, forgetCursor } from '../../../src/lib/noteEngine.ts'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

// ===================== A 组：动作表（假引擎跑真实现）=====================

/**
 * 内存假引擎：实现 `NoteEngineHandle` 全部方法，只操作一段字符串 + 一个选区。
 * 用它跑 `runNoteAction` 就能把「菜单点下去到底改了哪些字符、光标落在哪」断言死。
 */
function makeEngine(text, selFrom, selTo) {
  let doc = text
  let from = selFrom ?? 0
  let to = selTo ?? from
  const stats = { wikiSuggest: 0, selectAll: 0, blockCell: null }
  const engine = {
    insertAtCursor(t) { doc = doc.slice(0, from) + t + doc.slice(to); from = to = from + t.length },
    revealLine() { /* 无 UI */ },
    focus() { /* 无 UI */ },
    getSelection: () => ({ text: doc.slice(from, to), from, to }),
    replaceRange(f, t, ins, sf, st) {
      doc = doc.slice(0, f) + ins + doc.slice(t)
      from = sf !== undefined ? f + sf : f + ins.length
      to = st !== undefined ? f + st : from
    },
    getBlockContext() {
      const lineStart = doc.lastIndexOf('\n', Math.max(0, from - 1)) + 1
      const nl = doc.indexOf('\n', from)
      const lineEnd = nl === -1 ? doc.length : nl
      const prevStart = doc.lastIndexOf('\n', Math.max(0, lineStart - 2)) + 1
      const prevText = lineStart === 0 ? '' : doc.slice(prevStart, Math.max(prevStart, lineStart - 1))
      return {
        lineText: doc.slice(lineStart, lineEnd),
        lineFrom: lineStart,
        lineTo: lineEnd,
        prevLineEmpty: lineStart === 0 || prevText.trim() === '',
        selection: { text: doc.slice(from, to), from, to },
      }
    },
    getCursorOffset: () => from,
    setCursorOffset(o) { from = to = Math.max(0, Math.min(o, doc.length)) },
    selectAll() { stats.selectAll++; from = 0; to = doc.length },
    getRaw: () => null,
    triggerWikiSuggest() { stats.wikiSuggest++ },
    focusBlockCell(pos) { stats.blockCell = pos },
  }
  return { engine, peek: () => ({ doc, from, to, ...stats }) }
}

/** 跑一个同步动作（剪贴板类会返回 Promise，本脚本不碰它们） */
function runSync(id, text, selFrom, selTo) {
  const h = makeEngine(text, selFrom, selTo)
  const out = runNoteAction(id, h.engine)
  if (out instanceof Promise) return { async: true }
  return { out, ...h.peek() }
}

// ---- A1 行内包裹：有选区包住并保持选中；无选区插占位并选中占位 ----
{
  const r = runSync('fmt-bold', 'hello', 0, 5)
  ok(r.doc === '**hello**', 'A1a 加粗（有选区）产出 **hello**', r.doc)
  ok(r.from === 2 && r.to === 7, 'A1b 加粗后选区仍覆盖原文本', `${r.from}-${r.to}`)
  const r2 = runSync('fmt-bold', '')
  ok(r2.doc === '**加粗**', 'A1c 加粗（无选区）插占位', r2.doc)
  ok(r2.from === 2 && r2.to === 4, 'A1d 占位文字被选中（直接输入即替换）', `${r2.from}-${r2.to}`)
  ok(runSync('fmt-italic', '').doc === '*斜体*', 'A1e 斜体标记')
  ok(runSync('fmt-strike', '').doc === '~~删除线~~', 'A1f 删除线标记')
  ok(runSync('fmt-code', '').doc === '`代码`', 'A1g 行内代码标记')
  ok(runSync('fmt-highlight', '').doc === '==高亮==', 'A1h 高亮标记')
}

// ---- A2 段落设置：幂等（重复点不叠加），且能剥掉既有前缀 ----
{
  ok(runSync('para-h2', 'abc').doc === '## abc', 'A2a 正文 → 标题 2', runSync('para-h2', 'abc').doc)
  ok(runSync('para-h2', '# abc').doc === '## abc', 'A2b 标题 1 → 标题 2（不叠加）', runSync('para-h2', '# abc').doc)
  ok(runSync('para-h2', '- abc').doc === '## abc', 'A2c 列表 → 标题（剥掉列表前缀）', runSync('para-h2', '- abc').doc)
  ok(runSync('para-h2', '## abc').doc === '## abc', 'A2d 同级标题重复点不变', runSync('para-h2', '## abc').doc)
  ok(runSync('para-text', '## abc').doc === 'abc', 'A2e 标题 → 正文', runSync('para-text', '## abc').doc)
  ok(runSync('para-text', '> - abc').doc === 'abc', 'A2f 引用+列表 → 正文（多前缀一次剥净）', runSync('para-text', '> - abc').doc)
  ok(runSync('para-quote', 'abc').doc === '> abc', 'A2g 加引用', runSync('para-quote', 'abc').doc)
  ok(runSync('para-quote', '> abc').doc === 'abc', 'A2h 引用再点取消', runSync('para-quote', '> abc').doc)
  ok(runSync('para-ul', 'abc').doc === '- abc', 'A2i 加无序列表', runSync('para-ul', 'abc').doc)
  ok(runSync('para-ul', '- abc').doc === 'abc', 'A2j 无序列表再点取消', runSync('para-ul', '- abc').doc)
  ok(runSync('para-ol', 'abc').doc === '1. abc', 'A2k 加有序列表', runSync('para-ol', 'abc').doc)
  ok(runSync('para-task', 'abc').doc === '- [ ] abc', 'A2l 加任务列表', runSync('para-task', 'abc').doc)
  ok(runSync('para-task', '- [ ] abc').doc === 'abc', 'A2m 任务列表再点取消', runSync('para-task', '- [ ] abc').doc)
  ok(runSync('para-task', '- [x] abc').doc === 'abc', 'A2n 已勾选任务也能取消', runSync('para-task', '- [x] abc').doc)
  ok(runSync('para-ul', '- [ ] abc').doc === '- abc', 'A2o 任务 → 普通列表（降级不叠加）', runSync('para-ul', '- [ ] abc').doc)
}

// ---- A3 插入：块级模板与「插完就能打」的落点 ----
{
  const t = runSync('ins-table', '')
  ok(t.doc.startsWith('| 列 1 | 列 2 | 列 3 |'), 'A3a 表格模板表头', t.doc.split('\n')[0])
  ok(t.doc.includes('| --- | --- | --- |'), 'A3b 表格模板分隔行')
  // 2026-10-11 改：表格在即时渲染档是**渲染表 + 单元格就地编辑**，故不再「选中源码里的首格」，
  // 而是把焦点交给首格（`focusBlockCell`）；源码档不实现该方法 → 仍是插完选中首格的旧行为
  ok(t.blockCell === 0, 'A3c 插完把焦点交给首格（即时渲染档走 focusBlockCell）', String(t.blockCell))
  ok(t.doc.slice(t.from, t.to) === '', 'A3c2 不再选中源码文本（选中会落在被替换的 widget 区间里）', JSON.stringify(t.doc.slice(t.from, t.to)))
  const hr = runSync('ins-hr', '')
  ok(hr.doc === '---', 'A3d 分隔线', hr.doc)
  const code = runSync('ins-code', '')
  ok(code.doc === '```\n\n```', 'A3e 代码块模板', JSON.stringify(code.doc))
  const math = runSync('ins-math', '')
  ok(math.doc === '$$\n\n$$', 'A3f 数学块模板', JSON.stringify(math.doc))
  const quiz = runSync('ins-quiz', '')
  ok(quiz.doc.startsWith('```quiz\n{') && quiz.doc.endsWith('\n```'), 'A3g 题目围栏模板', JSON.stringify(quiz.doc.slice(0, 20)))
  ok(/^\{"no":1,/.test(quiz.doc.split('\n')[1]), 'A3h 题目围栏是合法 JSON 开头（能被 QuizParser 解析）', quiz.doc.split('\n')[1].slice(0, 24))
  const callout = runSync('ins-callout', '')
  ok(callout.doc.startsWith('> [!note]'), 'A3i 标注（callout）模板', callout.doc.split('\n')[0])
  // 块级插入的落点：紧贴段落插 `---` 会被 Markdown 当 setext 标题下划线 → 必须空一行
  const onLine = runSync('ins-hr', 'abc', 1, 1)
  ok(onLine.doc === 'abc\n\n---', 'A3j 非空行插块级 → 空一行再插（否则 --- 变标题下划线）', JSON.stringify(onLine.doc))
  const onEmptyAfterText = runSync('ins-hr', 'abc\n', 4, 4)
  ok(onEmptyAfterText.doc === 'abc\n\n---', 'A3k 空行但上一行有内容 → 保留空行、另起一行插', JSON.stringify(onEmptyAfterText.doc))
  const onEmptyAfterBlank = runSync('ins-hr', 'abc\n\n', 5, 5)
  ok(onEmptyAfterBlank.doc === 'abc\n\n---', 'A3l 空行且上一行也空 → 就地插在空行处（前方已有一个空行）', JSON.stringify(onEmptyAfterBlank.doc))
  const replaceSel = runSync('ins-hr', 'abc', 0, 3)
  ok(replaceSel.doc === '---', 'A3m 有选区 → 直接替换选区', JSON.stringify(replaceSel.doc))
}

// ---- A4 脚注：必须单行非空选区 ----
{
  const r = runSync('ins-footnote', 'word', 0, 4)
  ok(r.doc === 'word^[注释]', 'A4a 脚注包裹', r.doc)
  ok(r.doc.slice(r.from, r.to) === '注释', 'A4b 占位「注释」被选中', r.doc.slice(r.from, r.to))
  const noSel = runSync('ins-footnote', 'word')
  ok(noSel.out && noSel.out.ok === false, 'A4c 无选区时明确失败（不是静默什么都不做）', JSON.stringify(noSel.out))
  const multi = runSync('ins-footnote', 'a\nb', 0, 3)
  ok(multi.out && multi.out.ok === false, 'A4d 跨行选区拒绝（脚注是行内语法）')
  const again = runSync('ins-footnote', 'word^[旧]', 0, 9)
  ok(again.doc === 'word^[注释]', 'A4e 重复标注替换旧标注（不套娃）', again.doc)
}

// ---- A5 链接 ----
{
  const w = runSync('link-wiki', '')
  ok(w.doc === '[[', 'A5a 内部双链插 [[', w.doc)
  ok(w.wikiSuggest === 1, 'A5b 插完唤起候选建议', String(w.wikiSuggest))
  const w2 = runSync('link-wiki', '笔记', 0, 2)
  ok(w2.doc === '[[笔记]]', 'A5c 有选区直接包成双链', w2.doc)
  const ext = runSync('link-external', '站点', 0, 2)
  ok(ext.doc === '[站点](https://)', 'A5d 外部链接（有选区做文字）', ext.doc)
  ok(ext.doc.slice(ext.from, ext.to) === '站点', 'A5e 外部链接后仍选中文字（方便改）', ext.doc.slice(ext.from, ext.to))
  const ext2 = runSync('link-external', '')
  ok(ext2.doc === '[链接文字](https://)', 'A5f 外部链接（无选区插占位）', ext2.doc)
}

// ---- A6 可用性判定（菜单灰显的唯一真源）----
{
  const ctx = (text, from, to) => ({ lineText: text, lineFrom: 0, lineTo: text.length, selection: { text: text.slice(from, to), from, to } })
  ok(isNoteActionEnabled('ins-footnote', ctx('word', 0, 4)) === true, 'A6a 单行选区 → 脚注可用')
  ok(isNoteActionEnabled('ins-footnote', ctx('word', 0, 0)) === false, 'A6b 无选区 → 脚注灰显')
  ok(isNoteActionEnabled('ins-footnote', ctx('a\nb', 0, 3)) === false, 'A6c 跨行选区 → 脚注灰显')
  ok(isNoteActionEnabled('fmt-bold', null) === true, 'A6d 格式类不依赖选区（插占位即可用）')
}

// ---- A7 剪贴板类动作存在（走主进程通道，不在本脚本里执行）----
{
  const h = makeEngine('abc', 0, 3)
  const out = runNoteAction('edit-copy', h.engine)
  ok(out instanceof Promise, 'A7a 复制走异步剪贴板通道（不阻塞 UI）')
  const all = runSync('edit-select-all', 'abc', 0, 0)
  ok(all.selectAll === 1 && all.from === 0 && all.to === 3, 'A7b 全选落到整篇')
}

// ---- A8 切档光标记忆：按「文件 × 档位」隔离，换文件不串档 ----
{
  rememberCursor('a.md', 'source', 12)
  rememberCursor('a.md', 'live', 40)
  rememberCursor('b.md', 'source', 7)
  ok(recallCursor('a.md', 'source') === 12, 'A8a 源码档位置独立记录', String(recallCursor('a.md', 'source')))
  ok(recallCursor('a.md', 'live') === 40, 'A8b 即时渲染档位置独立记录（不互相覆盖）', String(recallCursor('a.md', 'live')))
  ok(recallCursor('b.md', 'source') === 7 && recallCursor('b.md', 'live') === undefined, 'A8c 文件之间隔离')
  ok(recallCursor('missing.md', 'source') === undefined, 'A8d 无记录返回 undefined（首开不动光标）')
  forgetCursor('a.md')
  ok(recallCursor('a.md', 'source') === undefined && recallCursor('a.md', 'live') === undefined, 'A8e forget 清两档')
  rememberCursor('c.md', 'source', -5)
  ok(recallCursor('c.md', 'source') === undefined, 'A8f 负偏移被拒（脏输入不落表）')
}

// ===================== B 组：菜单树完整性 =====================

const flat = (nodes, out = []) => {
  for (const n of nodes) {
    if (n.sep) continue
    if (n.label) out.push(n.label)
    if (n.children) flat(n.children, out)
  }
  return out
}
const LABELS = flat(NOTE_MENU)
for (const need of ['新增链接', '新增外部链接', '文本格式', '段落设置', '插入', '剪切', '复制', '粘贴', '以纯文本形式粘贴', '全选']) {
  ok(LABELS.includes(need), `B1 菜单含「${need}」`)
}
for (const need of ['加粗', '斜体', '删除线', '行内代码', '高亮', '正文', '标题 1', '标题 6', '引用', '无序列表', '有序列表', '任务列表', '脚注', '表格', '标注', '分隔线', '代码块', '数学块', '题目围栏']) {
  ok(LABELS.includes(need), `B2 子菜单含「${need}」`)
}
ok(!LABELS.includes('新建数据库'), 'B3 负向：不做「新建数据库」（本项目无 Bases 对标物，已明确不做）')
const ACTIONS = (function walk(nodes, out = []) {
  for (const n of nodes) { if (n.action) out.push(n.action); if (n.children) walk(n.children, out) }
  return out
})(NOTE_MENU)
ok(ACTIONS.length >= 25, 'B4 动作节点数合理（防手滑删掉一半菜单）', String(ACTIONS.length))
ok(new Set(ACTIONS).size === ACTIONS.length, 'B5 无重复动作 id（重复会让同一动作出现在两处而难以维护）')

// ===================== C 组：源码接线（两档 + 单写者 + 惰性）=====================

const SRC_ENGINE = stripComments(read('src/lib/noteEngine.ts'))
const SRC_ACTIONS = stripComments(read('src/lib/noteActions.ts'))
const SRC_SURFACE = stripComments(read('src/components/shared/NoteSurface.tsx'))
const SRC_MONACO = stripComments(read('src/components/shared/MonacoPane.tsx'))
const SRC_LIVE = stripComments(read('src/components/shared/LiveMarkdownPane.tsx'))
const SRC_MENU = stripComments(read('src/components/shared/NoteContextMenu.tsx'))
const SRC_PAGE = stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))
const SRC_SETTINGS = stripComments(read('src/lib/settings.ts'))
const SRC_EDITORVIEW = stripComments(read('src/modules/settings/views/EditorView.tsx'))
const SRC_CSS = read('src/styles/index.css')
// 脚注：即时渲染档的 widget 复用预览那份工具类，两边字符串必须逐字相同（C12l/C12m 互锁）
const SRC_PREVIEW = stripComments(read('src/components/shared/MarkdownPreview.tsx'))

// ---- C1 设置项 ----
ok(/editorWritingMode:\s*\{[^}]*default:\s*'source'/.test(SRC_SETTINGS), 'C1a 设置 editorWritingMode 默认 source（默认不改现有手感）')
ok(/editorWritingMode[\s\S]{0,400}?anchor:\s*'editor\.writingMode'/.test(SRC_SETTINGS), 'C1b 设置项带 anchor（进设置搜索）')
ok(SRC_EDITORVIEW.includes("'live'") && SRC_EDITORVIEW.includes('editor.writingMode'), 'C1c 设置页提供源码/即时渲染两档')

// ---- C2 契约：两档同签名 ----
for (const m of ['insertAtCursor', 'revealLine', 'focus', 'getSelection', 'replaceRange', 'getBlockContext', 'getCursorOffset', 'setCursorOffset', 'selectAll', 'getRaw']) {
  ok(SRC_ENGINE.includes(m + '(') || SRC_ENGINE.includes(m + '?('), `C2 契约含 ${m}`)
}
ok(/export interface MonacoPaneHandle extends NoteEngineHandle/.test(SRC_MONACO), 'C2b 源码档句柄 extends 契约（少实现一个方法就编译不过）')
ok(/forwardRef<NoteEngineHandle,\s*LiveMarkdownPaneProps>/.test(SRC_LIVE), 'C2c 即时渲染档 ref 就是契约本身')
ok(SRC_LIVE.includes('triggerWikiSuggest') && SRC_MONACO.includes('triggerWikiSuggest'), 'C2d 两档都实现 triggerWikiSuggest（菜单「新增链接」才两档一致）')

// ---- C3 单写者：同一文件只挂一个引擎 ----
ok(/active === 'live'\s*\?/.test(SRC_SURFACE), 'C3a 宿主按 active 单值二选一（不存在两引擎同挂）')
ok(/mode === 'live' && doc\?\.language === 'markdown'/.test(SRC_SURFACE), 'C3b 即时渲染只对 markdown 生效（代码/txt 强制源码档）')
ok((SRC_SURFACE.match(/<MonacoPane\s/g) || []).length === 1 && (SRC_SURFACE.match(/<LiveMarkdownPane\s/g) || []).length === 1,
  'C3c 两档各渲染一处（防有人顺手复制一份造成双挂）')

// ---- C4 惰性：CM6 不进首屏静态闭包 ----
ok(/lazy\(\(\)\s*=>\s*import\('\.\/LiveMarkdownPane'\)/.test(SRC_SURFACE), 'C4a 即时渲染档惰性加载（铁律 20）')
ok(!/^import\s+\{[^}]*\}\s+from\s+'\.\/LiveMarkdownPane'/m.test(SRC_SURFACE), 'C4b 负向：NoteSurface 不得静态 import 即时渲染档')
{
  const hits = []
  for (const f of ['src/components/shared/NoteSurface.tsx', 'src/modules/knowledge/components/PageEditor.tsx', 'src/components/shared/MonacoPane.tsx', 'src/lib/noteActions.ts']) {
    if (/from\s+'@codemirror\//.test(read(f))) hits.push(f)
  }
  ok(hits.length === 0, 'C4c 负向：@codemirror 只允许出现在即时渲染档文件里', hits.join('、'))
}

// ---- C5 右键菜单：两档都接、共用一份定义 ----
ok(SRC_MONACO.includes("domNode.addEventListener('contextmenu'") && SRC_MONACO.includes('menuCbRef'), 'C5a 源码档接管右键')
ok(SRC_MONACO.includes('contextmenu: false') || SRC_PAGE.includes('contextmenu: false'), 'C5b 源码档关掉 Monaco 自带菜单（避免两套叠一起）')
ok(SRC_LIVE.includes('contextmenu:') && SRC_LIVE.includes('e.preventDefault()'), 'C5c 即时渲染档接管右键')
ok(SRC_SURFACE.includes('NoteContextMenu') && SRC_MENU.includes('NOTE_MENU'), 'C5d 两档汇到同一份菜单组件/菜单树')
ok(SRC_MENU.includes('data-wb="noteContextMenu"'), 'C5e 菜单带 data-wb 锚点（探针可定位）')
ok(SRC_MENU.includes('kb-pop'), 'C5f 菜单进出走动效工具类（铁律 13）')
ok(SRC_CSS.includes('.kb-menu-item') && SRC_CSS.includes('.kb-menu-sep'), 'C5g 菜单样式已落 index.css')

// ---- C6 动作表是两档的唯一真源 ----
ok(SRC_MONACO.includes("runNoteAction('fmt-bold'") && SRC_LIVE.includes("runNoteAction(id"), 'C6a 两档快捷键都经同一份动作表下达（不各写一份）')
ok(SRC_LIVE.includes("key: 'Mod-b'") && SRC_LIVE.includes("key: 'Mod-i'") && SRC_LIVE.includes("key: 'Mod-k'"), 'C6b 即时渲染档有 Ctrl+B/I/K（编辑器内组合键不走全局）')
ok(SRC_ACTIONS.includes("case 'ins-footnote'") && SRC_PAGE.includes("runNoteAction('ins-footnote'"), 'C6c 工具栏脚注按钮与菜单脚注同实现')

// ---- C7 即时渲染档的渲染范围与回源码纪律 ----
ok(SRC_LIVE.includes('HIDE_NODES') && SRC_LIVE.includes('Decoration.replace'), 'C7a 隐藏语法标记靠替换装饰')
ok(SRC_LIVE.includes('hitsActiveLine') && SRC_LIVE.includes('containsCursor'), 'C7b 光标所在块回源码（两重判定）')
ok(SRC_LIVE.includes('TableWidget') && SRC_LIVE.includes('ImageWidget') && SRC_LIVE.includes('MathWidget') && SRC_LIVE.includes('CheckboxWidget'),
  'C7c 表格/图片/公式/复选框四类 widget 齐')
ok(SRC_LIVE.includes('normalizeVaultRel') && SRC_LIVE.includes('loadVaultImage'), 'C7d 内联图片走附件白名单共用实现（不新开读盘口子）')
ok(SRC_LIVE.includes('katex.renderToString'), 'C7e 公式走 KaTeX')
ok(!/mermaid/i.test(SRC_LIVE), 'C7f 负向：一期不渲染 mermaid（保持源码文本）')
ok(!/quiz.*parse|parseQuizFence/.test(SRC_LIVE), 'C7g 负向：一期不在编辑器里解析 quiz 围栏')
ok(SRC_LIVE.includes('compositionstart') && SRC_LIVE.includes('applyTextDiff'), 'C7h 输入法组合期不落外部文本 + 最小 diff 同步（两档同纪律）')

// ---- C8 PageEditor 接线 ----
ok(SRC_PAGE.includes("from '../../../components/shared/NoteSurface'"), 'C8a PageEditor 消费写作面宿主')
ok(!/<MonacoPane/.test(SRC_PAGE), 'C8b 负向：PageEditor 不再直接渲染某个引擎')
ok(/mode=\{writingMode\}/.test(SRC_PAGE), 'C8c 档位由设置下发')
ok(SRC_PAGE.includes('writingMode === \'source\'') , 'C8d 即时渲染档不渲染 AI 续写钮（暂未提供，避免点了没反应）')

// ---- C9 剪贴板通道（主进程代理，渲染层不直连 navigator.clipboard）----
ok(read('electron/main/index.ts').includes("clipboard:readText"), 'C9a 主进程新增 clipboard:readText')
ok(read('electron/preload/index.ts').includes('readClipboardText'), 'C9b preload 暴露 readClipboardText')
ok(read('src/lib/ipc.ts').includes('readClipboardText'), 'C9c ipc 封装 readClipboardText')
ok(read('src/types/index.ts').includes('readClipboardText'), 'C9d ElectronAPI 类型补齐')

// ---- C10 渲染层样式 ----
for (const cls of ['.kb-live-h1', '.kb-live-strong', '.kb-live-code', '.kb-live-quote', '.kb-live-img', '.kb-live-task', '.kb-live-codecard-lang', '.kb-live-math-block']) {
  ok(SRC_CSS.includes(cls), `C10 样式含 ${cls}`)
}

// ---- C11 排版单一真相（阅读态预览与即时渲染档共用令牌，不许各写数值）----
// 背景：2026-10-11 实测两侧漂移（基准字号 13 vs 16、H1 无/有下划线、代码块无/有语法高亮…）。
// 治理 = 「共享排版令牌 `--md-*`」+「共用原子作用域 `.kb-md-atom`」；运行时由
// `.AGENT/scripts/notes-surface/compare-live-vs-preview.mjs` 逐项断言，这里锁源码层不漂。
ok(SRC_CSS.includes('--md-h1-size'), 'C11a 共享排版令牌块存在（--md-*）')
for (const tok of ['--md-h1-size', '--md-h2-size', '--md-code-bg', '--md-code-pad', '--md-pre-pad', '--md-table-pad', '--md-quote-pad-left', '--md-strong-weight', '--md-heading-line-height']) {
  ok(SRC_CSS.includes(`var(${tok})`), `C11b 有规则消费 ${tok}`)
}
ok(/\.prose-content h1 \{[^}]*var\(--md-h1-size\)/.test(SRC_CSS), 'C11c 预览 h1 字号取自令牌')
ok(/\.kb-live-h1 \{[^}]*var\(--md-h1-size\)/.test(SRC_CSS), 'C11d 写作面 h1 字号取自令牌')
ok(/\.prose-content h4 \{/.test(SRC_CSS) && /\.kb-live-h4 \{/.test(SRC_CSS), 'C11e h4–h6 两侧都有规则（预览此前缺失，回落到正文）')
ok(SRC_CSS.includes('.kb-md-atom'), 'C11f 预览与写作面共用原子作用域 .kb-md-atom')
{
  // 锚点必须带注释开头：令牌块的说明文字里也出现过「即时渲染档写作面」四个字
  const liveCss = SRC_CSS.slice(SRC_CSS.indexOf('/* ===== 即时渲染档写作面'), SRC_CSS.indexOf('/* ===== 编辑器右键菜单'))
  ok(liveCss.length > 0, 'C11g 定位到写作面样式块（供下面两条负向断言）')
  ok(!/font-size:\s*[\d.]+em/.test(liveCss), 'C11h 负向：写作面不再写死 em 字号（必须走令牌）')
}
ok(SRC_LIVE.includes("fontSize: '1rem'"), 'C11i 写作面基准字号 = 1rem（根字号，与预览同基准）')
ok(!SRC_LIVE.includes('liveTheme(fontSize)') && !SRC_LIVE.includes('fontSizeComp'), 'C11j 负向：写作面不再按「编辑器字号」重配置')
ok(SRC_LIVE.includes("'kb-live-table-wrap kb-md-atom'") && SRC_LIVE.includes("'kb-live-img kb-md-atom'"), 'C11k 表格/图片 widget 挂共用原子作用域')
ok(SRC_LIVE.includes("outer.className = 'kb-md-atom'"), 'C11l 代码块 widget 挂共用原子作用域')
ok(SRC_LIVE.includes("from 'highlight.js/lib/common'"), 'C11m 代码高亮与预览同一个库（highlight.js）')
ok(SRC_LIVE.includes('new CodeBlockWidget'), 'C11n 围栏代码块走卡片 widget（与预览同构 DOM）')
ok(SRC_LIVE.includes("['•', '○', '▪']"), 'C11o 无序列表按层换标记（• / ○ / ▪）')
ok(SRC_LIVE.includes('[-*+]\\s+\\[[ xX]\\]'), 'C11p 任务行不再画项目符号（双标记修复）')
ok(SRC_LIVE.includes("from '@codemirror/search'") && SRC_LIVE.includes('searchKeymap') && SRC_LIVE.includes('search({ top: true })'),
  'C11q 查找面板接线（Ctrl+F，与源码档 Monaco find widget 对齐）')
ok(SRC_LIVE.includes('listDepth') && SRC_LIVE.includes('orderedMarker'), 'C11r 列表层级走语法树祖先链 + 有序重编号')

// ---- C12 表格「渲染态就地编辑」（2026-10-11 对齐 Obsidian）+ 脚注即时渲染 ----
// 背景：此前语义是「光标进入表格 → 整块回源码」，于是「插入表格」把你丢进管道符里；
// Obsidian 是直接在渲染后的表格里打字。改法见 LiveMarkdownPane 文件头的表格段。
ok(!/name === 'Table'[\s\S]{0,220}containsCursor/.test(SRC_LIVE), 'C12a 负向：表格不再按「光标进入回源码」处理（永远渲染成表）')
ok(SRC_LIVE.includes("cell.contentEditable = 'true'") && SRC_LIVE.includes("cell.contentEditable"), 'C12b 单元格显式 contentEditable（CM6 给 widget 根设 false，格内 true 即成为编辑宿主）')
ok(SRC_LIVE.includes('commitTableCell') && SRC_LIVE.includes('view.dispatch({ changes: { from: ref.from, to: ref.to, insert: clean } })'),
  'C12c 格内改动写回源文本（最小替换，只动这一格的正文区间）')
ok(SRC_LIVE.includes('widget.src = src.slice') && /eq\(o: TableWidget\): boolean \{ return o\.src === this\.src \}/.test(SRC_LIVE),
  'C12d 写回前同步 widget.src ⇒ 重建时 eq 判等、DOM 不被重建（格内光标与输入法不丢）')
ok(SRC_LIVE.includes('tableRangeOf') && SRC_LIVE.includes('view.posAtDOM') && SRC_LIVE.includes("n.name !== 'Table'"),
  'C12e 单元格源区间每次从文档现算（posAtDOM + 语法树找 Table），不缓存偏移')
ok(SRC_LIVE.includes('moveTableCell') && SRC_LIVE.includes('addTableRow') && SRC_LIVE.includes('focusCellNear'),
  'C12f Tab/Shift+Tab 换格、Enter 下行、末行加一行')
ok(SRC_LIVE.includes("if (mod && key === 'z')") && SRC_LIVE.includes('undo(view)'), 'C12g 格内 Ctrl+Z 交给 CM6（原生 contenteditable 撤销会与源脱钩）')
ok(SRC_LIVE.includes("if (mod && (key === 'b' || key === 'i' || key === 'u'))"), 'C12h 负向：格内拦掉原生富文本命令（Ctrl+B/I/U 会改 DOM 而源不动）')
ok(SRC_LIVE.includes('focusBlockCell') && SRC_ACTIONS.includes('engine.focusBlockCell?.(r.at)'), 'C12i 插入表格后把焦点交给首格（两档共用的可选契约）')
ok(SRC_CSS.includes('th[contenteditable]:focus') && SRC_CSS.includes('td[contenteditable]:focus'), 'C12j 正在编辑的单元格有强调色描边')
// 脚注：与预览同一批 Tailwind 类名（外观由同一份 CSS 供），气泡 fixed + 视口回夹
ok(SRC_LIVE.includes('FootnoteWidget') && SRC_LIVE.includes('FN_RE'), 'C12k 脚注在即时渲染档也渲染（与预览一致）')
ok(SRC_LIVE.includes("border-b border-dashed border-[var(--accent)] cursor-help hover:bg-[var(--accent)]/10 transition-colors"),
  'C12l 脚注词复用预览那份工具类（同一批 class ⇒ 同一批数值）')
ok(SRC_PREVIEW.includes("border-b border-dashed border-[var(--accent)] cursor-help hover:bg-[var(--accent)]/10 transition-colors"),
  'C12m 预览侧那份仍在（两边字符串必须逐字相同，漂了就红）')
ok(SRC_LIVE.includes("tip.className = `${FN_TIP_CLS} fixed z-[9999]") && SRC_LIVE.includes('Math.min(r.left, window.innerWidth - w - 8)'),
  'C12n 脚注气泡 fixed + 视口回夹（absolute 会被 .cm-scroller 的 overflow 裁掉）')
ok(SRC_LIVE.includes('closeFootnoteTip') && SRC_LIVE.includes('destroy(): void { closeFootnoteTip() }'), 'C12o 气泡在点外部 / Esc / 滚动 / widget 被换掉时收掉')

// ---- C13 右键菜单与子菜单都不被屏幕边缘截断（2026-10-11 反馈）----
// 根因两条：① 尺寸用 getBoundingClientRect 量，`.kb-pop` 进场是 scale(0.94)，量到的是缩小 6% 的尺寸；
// ② 子菜单完全没有出屏处理（右缘右键 → 往右展开的子菜单整块在窗口外）。
ok(SRC_MENU.includes('offsetWidth') && SRC_MENU.includes('offsetHeight'), 'C13a 菜单用 offsetWidth/Height 量（不受进场 transform 影响）')
ok(!SRC_MENU.includes('r.width') && !SRC_MENU.includes('rect.width') && SRC_MENU.includes('window.innerWidth - w - EDGE'),
  'C13b 负向：不再拿 rect 的宽高算出屏回夹（anchor 的 rect 只用来取 left/top）')
ok(SRC_MENU.includes('function SubMenu') && SRC_MENU.includes('if (left + w > window.innerWidth - EDGE) left = Math.max(EDGE, r.left - w + gap)'),
  'C13c 子菜单右边放不下就翻到左侧')
ok(SRC_MENU.includes('if (top + h > window.innerHeight - EDGE) top = window.innerHeight - EDGE - h'), 'C13d 子菜单下边放不下就上移（贴底右键不再被截）')
ok(SRC_MENU.includes('overflowY') && SRC_MENU.includes('maxHeight'), 'C13e 极矮窗口兜底：子菜单内部滚动而不是整块溢出')
{
  const hook = read('src/lib/useContextMenuPosition.ts')
  ok(hook.includes('offsetWidth') && hook.includes('offsetHeight'), 'C13f 共享 hook（文件树 / 书签 / 章节等 8 处菜单）同因同修')
  ok(!hook.includes('rect.width - EDGE_MARGIN'), 'C13g 负向：hook 不再用 rect 尺寸回夹')
}

// ===================== 结果 =====================

if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  [FAIL] ' + f)
  process.exit(1)
}

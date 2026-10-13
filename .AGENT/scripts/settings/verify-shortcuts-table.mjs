/**
 * 契约脚本：设置 → 快捷键「指令表」的**内容判据**（v3.5.0，2026-10-13）
 *
 * 为什么需要它：
 *   这张表过去是**手写的**，所以「表里写了一套、代码里是另一套」没有任何机制会发现。
 *   2026-10-13 逐行对账一次找出 8 处不符 —— 其中 4 处是"写了但不存在"的：
 *     · `Ctrl` + 反引号 描述的是早已删除的「底部搜索面板」
 *     · `Ctrl+P` 错挂在「知识库 — 阅读」组（代码里是全局拦截）
 *     · `Ctrl+Shift+F` 代码里有、表里整条缺失
 *     · 密码本 `Ctrl+Alt+P` 写「可在设置改键」，而设置真源里没有这个设置项
 *   本脚本把结论锁住；负向断言一律先 `stripComments`，否则注释里的说明文字会被当成真实内容
 *   （本文件的头注里就写着那些过期文案，正是现成靶子）。
 *
 * ★ 2026-10-13 L1 真源化之后的分工（两边别搞混）：
 *   · 表的**数据源**已是 src/lib/commandRegistry.ts（真源）。本脚本因此**不再解析
 *     ShortcutsView.tsx 的 JSX 文本**，改成直接 import 真源 —— 断言从「正则切文本」
 *     升级为「类型化数据」，重构组件不再凭空弄挂契约。
 *   · 结构类断言（组数 / 条数 / 键帽 token / 锚点可解析 / 撞车）在
 *     .AGENT/scripts/commands/verify-commands-registry.mjs，本脚本不重复。
 *   · 本脚本守**内容判据**：这批具体键位归哪个组、死键有没有复活、代码里那个分支还在不在、
 *     手册同没同步、设置搜索索引挪没挪 —— 即「真源里这条写得对不对」。
 *
 * 口径：只锁「写错了的」（会让用户读到错误信息）与「曾经漏登记、现已补齐」的那批。
 *   H 组原本是「已知缺口」的交接标记，L1 落地时按约定**翻转**为「必须存在」，不是删掉。
 *
 * 用法（本脚本 import 了 .ts 真源）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/settings/verify-shortcuts-table.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'
import { COMMANDS, COMMAND_GROUPS, commandsOfGroup } from '../../../src/lib/commandRegistry.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
const has = (p) => existsSync(`${ROOT}/${p}`)

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

// ---------- 数据源：真源 ----------
// 刻意**不再**解析 ShortcutsView.tsx 的 JSX：表已由真源驱动，解析 JSX 只会让重构组件时
// 凭空弄挂契约。下面把真源投影成与旧脚本同形的结构（anchor / label / rows[].combos），
// 好让 A–I 各组判据保持原意不变。SRC 仍然保留 —— G 组要看 Row 组件的渲染代码。
const SRC = stripComments(read('src/modules/settings/views/ShortcutsView.tsx'))

const GROUPS = COMMAND_GROUPS.map((g) => ({
  anchor: g.anchor,
  label: g.label,
  groupId: g.id,
  rows: commandsOfGroup(g.id).map((c) => ({
    id: c.id,
    text: c.desc,
    groups: c.keys,
    combos: c.keys.map((k) => k.join('+')),
    multi: c.keys.length > 1,
  })),
}))
const ALL_COMBOS = GROUPS.flatMap((g) => g.rows.flatMap((r) => r.combos))
const groupOf = (anchor) => GROUPS.find((g) => g.anchor === anchor)
const combosIn = (anchor) => (groupOf(anchor)?.rows ?? []).flatMap((r) => r.combos)
/** 真源里**用户可见**的文案（label + desc）。负向断言只用它 —— note 是给开发者看的备注，
 *  里面会引用过期文案（如「原表写『可在设置改键』」），把 note 也算进去必然假报。 */
const VISIBLE_TEXT = COMMANDS.map((c) => `${c.label} ${c.desc}`).join('\n')

// ============================================================
// A. 结构：真源 11 组 / 61 条，表由真源驱动，且已无失效内容
// ============================================================
ok(GROUPS.length === 11, `A1 真源 ${GROUPS.length} 个快捷键组（B1 收录范围）`,
  `实际 ${GROUPS.length}: ${GROUPS.map((g) => g.label).join(' / ')}`)
ok(GROUPS.every((g) => g.rows.length > 0), 'A2 每组至少有一行',
  GROUPS.filter((g) => !g.rows.length).map((g) => g.label).join(', '))
ok(ALL_COMBOS.length >= 60, `A3 真源内共 ${ALL_COMBOS.length} 个键位组合（>=60）`)

// 「编辑器模块」整组失效：模块 2026-09-20 阶段四物理退役，组里只剩 PDF 三行是真的
ok(!GROUPS.some((g) => g.label.includes('编辑器模块')) && !VISIBLE_TEXT.includes('编辑器模块'),
  'A4 真源已无「编辑器模块」分组与文案（模块已物理退役）')
ok(!GROUPS.some((g) => g.anchor === 'shortcuts.editorModule'),
  'A5 真源已无 shortcuts.editorModule 锚点')
ok(!has('src/modules/editor'), 'A6 src/modules/editor 确实不存在（A4/A5 的前提）')

const SECTIONS = stripComments(read('src/modules/settings/sections.tsx'))
ok(!SECTIONS.includes('shortcuts.editorModule'), 'A7 sections.tsx 已无 shortcuts.editorModule（否则设置搜索跳空锚）')
ok(groupOf('shortcuts.pdfKeys') !== undefined && SECTIONS.includes('shortcuts.pdfKeys'),
  'A8 「PDF 阅读器」组在真源与设置索引两侧都登记了（anchor id 成对）')
// A9/A10 —— 真源化的意义就在这两条：表必须真的由真源驱动，且手写行不许复活
ok(SRC.includes('commandRegistry'), 'A9 ShortcutsView 确实 import 了真源（表不再是手写行）')
ok(!/<Row\s+keys=\{/.test(SRC) && !/<Row\s+alts=\{/.test(SRC),
  'A10 ShortcutsView 里已无手写键位字面量（keys=/alts= 写法都不该再出现）')

// ============================================================
// B. 死键 Ctrl+Shift+S：表里删了，且独立复核"代码里确实没有"
// ============================================================
ok(!ALL_COMBOS.includes('Ctrl+Shift+S'), 'B1 真源里已无「Ctrl+Shift+S 保存全部」（死键）')
ok(!read('resources/help/键盘快捷键.md').includes('`Ctrl` `Shift` `S`'), 'B2 帮助手册里也已删该行')

// 独立复核：全仓 .ts/.tsx 里 Ctrl+S 的处理只有笔记与博客两处，且都是 e.key === 's'（不含 Shift）
const srcFiles = walkSourceFiles(resolve(ROOT, 'src'))
const ctrlS = []
for (const f of srcFiles) {
  const t = stripComments(readFileSync(f, 'utf8'))
  if (/ctrlKey\s*&&\s*e\.key\s*===\s*'s'/.test(t) || /ctrlKey\s*&&\s*\(\s*e\.key\s*===\s*'s'/.test(t)) {
    ctrlS.push(f.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
  }
}
ok(ctrlS.length === 2, 'B3 全仓 Ctrl+S 处理恰 2 处（笔记立即保存 / 博客保存并关闭）', ctrlS.join(', '))
ok(ctrlS.some((f) => f.includes('PageEditor')) && ctrlS.some((f) => f.includes('MarkdownEditor')),
  'B4 这 2 处分别是 PageEditor 与 MarkdownEditor', ctrlS.join(', '))
// 没有任何地方处理「Ctrl+Shift+S」—— 双重确认死键结论（大小写两种写法都查）
const shiftS = srcFiles.filter((f) => {
  const t = stripComments(readFileSync(f, 'utf8'))
  return /shiftKey[\s\S]{0,40}key\s*===\s*'S'/.test(t) && /ctrlKey/.test(t)
})
ok(shiftS.length === 0, 'B5 全仓无任何「Ctrl+Shift+S」处理（死键结论双重确认）',
  shiftS.map((f) => f.replace(ROOT, '')).join(', '))

// ============================================================
// C. Ctrl+P / Ctrl+` / Ctrl+Shift+F 三键同效 → 归「全局」，且不再是「知识库—阅读」
// ============================================================
const G = 'shortcuts.global'
ok(['Ctrl+P', 'Ctrl+`', 'Ctrl+Shift+F'].every((k) => combosIn(G).includes(k)),
  'C1 三个同效键都在「全局」组', `全局组现有: ${combosIn(G).join(' | ')}`)
ok(combosIn('shortcuts.kbReading').every((k) => k !== 'Ctrl+P'),
  'C2 「知识库 — 阅读」组内已无 Ctrl+P（原错挂位置）',
  combosIn('shortcuts.kbReading').join(' | '))
const searchRow = groupOf(G)?.rows.find((r) => r.combos.includes('Ctrl+P'))
ok(searchRow?.multi === true, 'C3 该行用 alts 渲染三选一（否则七枚键帽读不出「同效」）')
ok(/全局搜索/.test(searchRow?.text ?? ''), 'C4 该行文案是「全局搜索」而非「知识库快速搜索」')

// 表对了还不够 —— 代码那两个分支得还在（否则表又变成单方面声明）
const APP = stripComments(read('src/App.tsx'))
ok(/e\.key === 'p' \|\| e\.key === 'P' \|\| e\.key === '`'/.test(APP) || /\(e\.key === 'p' \|\| e\.key === 'P' \|\| e\.key === '`'\)/.test(APP),
  'C5 代码里 Ctrl+P / Ctrl+` 仍指向左栏搜索态（App.tsx）')
ok(/e\.key === 'F' \|\| e\.key === 'f'/.test(APP), 'C6 代码里 Ctrl+Shift+F 分支仍在（App.tsx）')

// 设置搜索索引必须跟着挪，否则搜「ctrl p」会跳到错的组
ok(/shortcuts\.global[\s\S]{0,600}'ctrl p'/.test(SECTIONS), 'C7 设置索引 shortcuts.global 的 keywords 含 ctrl p')
ok(!/shortcuts\.kbReading[\s\S]{0,400}'ctrl p'/.test(SECTIONS), 'C8 设置索引 shortcuts.kbReading 的 keywords 已移除 ctrl p')
ok(/shortcuts\.global[\s\S]{0,600}'ctrl shift f'/.test(SECTIONS), 'C9 设置索引 shortcuts.global 的 keywords 含 ctrl shift f')

// ============================================================
// D. Alt+A 归「知识库 — 编辑器」（原挂在已退役的「编辑器模块」下）
// ============================================================
ok(combosIn('shortcuts.kbEditor').includes('Alt+A'), 'D1 Alt+A 已在「知识库 — 编辑器」组',
  combosIn('shortcuts.kbEditor').join(' | '))
const PE = stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))
ok(/e\.altKey && !e\.ctrlKey && !e\.shiftKey && \(e\.key === 'a' \|\| e\.key === 'A'\)/.test(PE),
  'D2 PageEditor 确实是 Alt+A 的判定处（D1 的依据）')

// ============================================================
// E. PDF 三行归「PDF 阅读器」，且判定确实在那
// ============================================================
const PDFC = combosIn('shortcuts.pdfKeys')
ok(['Ctrl+F', 'PageDown', 'PageUp'].every((k) => PDFC.includes(k)),
  'E1 PDF 组含 Ctrl+F / PageDown / PageUp', PDFC.join(' | '))
ok(groupOf('shortcuts.pdfKeys')?.label === '电子书阅读器', 'E2 组名是「电子书阅读器」（2026-10-13 由「PDF 阅读器」改名：翻页键 EPUB 也吃）',
  String(groupOf('shortcuts.pdfKeys')?.label))
const PDFV = stripComments(read('src/components/shared/pdf/PdfReaderView.tsx'))
ok(/e\.key === 'f'/.test(PDFV) && /PageDown/.test(PDFV) && /PageUp/.test(PDFV),
  'E3 PdfReaderView 确实处理这三个键（E1 的依据）')

// ============================================================
// F. 密码本「可改键」这句不实描述：两侧都删了，且独立复核设置真源里确实没有该设置项
// ============================================================
ok(!VISIBLE_TEXT.includes('可在设置改键'), 'F1 真源的用户可见文案里已无「可在设置改键」（note 里的历史备注不算）')
ok(!SECTIONS.includes('可配置键位'), 'F2 设置索引里已删「可配置键位」')
const SETTINGS = stripComments(read('src/lib/settings.ts'))
ok(!SETTINGS.includes('fillPopupShortcut'),
  'F3 设置真源（src/lib/settings.ts）里确实没有 fillPopupShortcut（F1/F2 的依据）')
const FILLER = read('electron/main/passwordFiller.ts')
ok(/settings\.fillPopupShortcut/.test(FILLER) && /'Ctrl\+Alt\+P'/.test(FILLER),
  'F4 主进程仍直接读 settings.json 裸键 fillPopupShortcut，缺省 Ctrl+Alt+P（所以是"只能手改 JSON"）')
ok(/globalShortcut\.register\(shortcutKey/.test(FILLER),
  'F5 该键是系统级 globalShortcut（表里标「系统级」是对的）')

// ============================================================
// G. Row 组件渲染多组同效键 —— 没有它 C1/E1 那几行会渲染成一长串键帽
// ============================================================
const rowBody = SRC.slice(SRC.indexOf('function Row'))
ok(/chords/.test(rowBody), 'G1 Row 接收 chords（多组同效键；真源里 keys 就是 string[][]）')
ok(/\{gi > 0 &&/.test(rowBody), 'G2 组间有分隔符（gi>0 才画）')
// JSX 里的文本子节点是裸的（`>/<`），不是被引号包起来的字符串 —— 第一种写法曾误报
ok(/>\/</.test(rowBody) || /'\/'/.test(rowBody), 'G3 分隔符是 /')
const multiRows = GROUPS.flatMap((g) => g.rows).filter((r) => r.multi)
ok(multiRows.length >= 3, `G4 至少 3 行用了 alts（实际 ${multiRows.length}）`)

// ============================================================
// H. 帮助手册同步 + 已知缺口标记
// ============================================================
const MD = read('resources/help/键盘快捷键.md')
ok(!/^## 编辑器$/m.test(MD), 'H1 手册已删「## 编辑器」小节（描述的是退役模块）')
ok(/^## 编辑器内（写作面）$/m.test(MD), 'H2 手册仍有「编辑器内（写作面）」小节')
ok(/文件树内联命名/.test(MD), 'H3 手册的 Ctrl+N 已改为「文件树内联命名」（原写"跳转编辑器进入命名"）')
const ctrlNCount = [...MD.matchAll(/`Ctrl` `N`/g)].length
ok(ctrlNCount === 3, `H4 手册里 Ctrl+N 恰 3 处（新建知识页 / 新建今日文章 / 新建任务），不再自相矛盾`,
  `实际 ${ctrlNCount}`)

// 写作面那 10 行不是编的：两个写作档位都得有同一套键位
const MP = stripComments(read('src/components/shared/MonacoPane.tsx'))
ok(/KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyB/.test(MP) && /KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyI/.test(MP) &&
   /KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyK/.test(MP),
  'H5 源码档 Monaco 有 Ctrl+B / Ctrl+I / Ctrl+K')
ok(/KeyMod\.CtrlCmd \| monaco\.KeyMod\.Alt \| monaco\.KeyCode\.Digit1/.test(MP) &&
   /KeyMod\.CtrlCmd \| monaco\.KeyMod\.Alt \| monaco\.KeyCode\.Digit0/.test(MP),
  'H6 源码档有 Ctrl+Alt+1..3 / Ctrl+Alt+0（标题档与正文）')
const LMP = stripComments(read('src/components/shared/LiveMarkdownPane.tsx'))
ok(/key: 'Mod-b'/.test(LMP) && /key: 'Mod-i'/.test(LMP) && /key: 'Mod-k'/.test(LMP) &&
   /key: 'Mod-Alt-0'/.test(LMP),
  'H7 即时渲染档 keymap 同键位（两档一致，手册那句"键位一致"成立）')

// H8/H9 —— 原本是「已知缺口」的交接标记，2026-10-13 L1（B1 收录范围：11 组 / 61 条）落地时
//   **按约定翻转**（不是删掉）：缺口已补齐，现在锁的是「必须存在」，防有人把它们删回去。
const FILLED_GLOBAL = ['Ctrl+Shift+J', 'Ctrl+Alt+B', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y']
ok(FILLED_GLOBAL.every((k) => combosIn('shortcuts.global').includes(k)),
  'H8 [已翻转] 全局组已补齐 Ctrl+Shift+J / Ctrl+Alt+B / 撤销重做（Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y）',
  `全局组现有: ${combosIn('shortcuts.global').join(' | ')}`)
const WRITING_KEYS = ['Ctrl+B', 'Ctrl+I', 'Ctrl+K', 'Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Alt+0', 'Ctrl+F']
const IMAGE_KEYS = ['0', '1', '[', ']']
const PDF_ZOOM = ['Ctrl+=', 'Ctrl+-', 'Ctrl+0']
ok(WRITING_KEYS.every((k) => combosIn('shortcuts.kbWriting').includes(k)),
  'H9a [已翻转] 「知识库 — 写作面」8 键已进设置页',
  `写作面组现有: ${combosIn('shortcuts.kbWriting').join(' | ')}`)
ok(IMAGE_KEYS.every((k) => combosIn('shortcuts.imageKeys').includes(k)) &&
   groupOf('shortcuts.imageKeys')?.label === '图片查看器',
  'H9b [已翻转] 「图片查看器」4 键已进设置页',
  `图片组现有: ${combosIn('shortcuts.imageKeys').join(' | ')}`)
ok(PDF_ZOOM.every((k) => combosIn('shortcuts.pdfKeys').includes(k)),
  'H9c [已翻转] PDF 缩放 3 键已进设置页（这三条此前连手册都没有）',
  `PDF 组现有: ${combosIn('shortcuts.pdfKeys').join(' | ')}`)

// ============================================================
// I. Ctrl+O 撞车已解（2026-10-13 用户拍板：博客大纲改键到 Ctrl+Alt+O）
//    原来两条都是 window 级监听，而 App 那条没有焦点闸门 ⇒ 焦点不在输入控件时
//    「弹出快速打开面板」与「切大纲」会一起发生（博客后注册，preventDefault 已晚）。
// ============================================================
const BLOG = stripComments(read('src/modules/blog/index.tsx'))
ok(!/e\.ctrlKey\s*&&\s*e\.key\s*===\s*'o'/.test(BLOG),
  'I1 博客的大纲开关不再占裸 Ctrl+O（撞车已解）')
ok(/e\.ctrlKey\s*&&\s*e\.altKey\s*&&\s*!e\.shiftKey\s*&&\s*e\.key\.toLowerCase\(\)\s*===\s*'o'/.test(BLOG),
  'I2 博客大纲改挂 Ctrl+Alt+O（且排除 Shift，避免与 Ctrl+Shift+O 混淆）')
ok(/Ctrl\+Alt\+O/.test(BLOG), 'I3 本文件的按钮提示已改成 Ctrl+Alt+O')
const MDED = stripComments(read('src/modules/blog/components/MarkdownEditor.tsx'))
ok(/title="大纲 \(Ctrl\+Alt\+O\)"/.test(MDED), 'I4 MarkdownEditor 的按钮提示也已同步')
ok(!/title="大纲 \(Ctrl\+O\)"/.test(BLOG) && !/title="大纲 \(Ctrl\+O\)"/.test(MDED),
  'I5 两处旧提示字符串都已不存在（防只改一处）')

// App 那条全局 Ctrl+O 必须**保持不变** —— 本次是给博客让位，不是给全局改键
ok(/e\.key === 'o' \|\| e\.key === 'O'/.test(APP), 'I6 全局快速打开仍是裸 Ctrl+O（App.tsx）')
// 全仓除 App 外不应再有别的 Ctrl+O 处理（否则又是一处新撞车）
const otherCtrlO = srcFiles.filter((f) => {
  const rel = f.replace(/\\/g, '/')
  if (rel.endsWith('src/App.tsx')) return false
  const t = stripComments(readFileSync(f, 'utf8'))
  return /e\.ctrlKey\s*&&\s*e\.key\s*===\s*'[oO]'/.test(t) ||
         /e\.ctrlKey\s*&&\s*!e\.shiftKey\s*&&\s*!e\.altKey\s*&&\s*\(e\.key === 'o'/.test(t)
})
ok(otherCtrlO.length === 0, 'I7 全仓除 App 外无第二处裸 Ctrl+O 处理（无新撞车）',
  otherCtrlO.map((f) => f.replace(ROOT, '')).join(', '))

// 表与手册也都登记了新键
ok(combosIn('shortcuts.blogKeys').includes('Ctrl+Alt+O'), 'I8 设置页「博客」组已登记 Ctrl+Alt+O',
  combosIn('shortcuts.blogKeys').join(' | '))
ok(/`Ctrl` `Alt` `O`/.test(MD), 'I9 帮助手册「博客」表也已登记该键')

// ============================================================
console.log('')
for (const f of fails) console.log('FAIL  ' + f)
console.log(`${pass}/${pass + fails.length} PASS  设置·快捷键指令表对账`)
process.exit(fails.length ? 1 : 0)

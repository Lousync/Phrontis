/**
 * 契约验证：编辑器文件树「粘贴系统剪贴板里的外部文件/目录」（v3.2.0 条目 ③）。
 *
 * 为什么需要它：
 *   ① **读取路线是本条目的唯一技术风险，且已经被实测推翻过一次。** DP 原方案 B（主进程
 *      `clipboard.readBuffer('FileNameW')`）在 Electron 33.2.0 / win32 上**只能拿到第一条路径**
 *      且载荷里没有 DROPFILES 头（同一次剪贴板：PS 回读 3/3、渲染层 paste 事件 3/3、主进程 1/3）
 *      —— 即「多选静默丢文件」。最终改走 B→A（渲染层 paste 事件 + webUtils.getPathForFile）。
 *      这条路线的两个前提（渲染层能取全量、主进程只负责落盘）都靠断言钉住。
 *   ② **重名递增口径容易被后人"顺手统一"。** 本模块已有 `uniqueFileName`（`a(1).md`），
 *      粘贴必须走 `a copy.md`（VS Code/资源管理器语义），两者故意不同 —— 一旦被合并，
 *      用户看到的副本名会突然变样，且不会有任何报错。
 *   ③ **安全守卫全在守卫分支里**：越界目标、符号链接源、把目录粘进它自己（无限递归）这三条
 *      任何一条失效都不会报错，只会静默地把仓库外内容拖进来或把磁盘写爆。
 *   ④ **焦点守卫的写法被实测反证过一次。** 直觉写法是「paste 事件的 `e.target` 在文件树内才接管」，
 *      但 Chromium 会把**非可编辑焦点**的 paste 事件重定向到 `BODY`（探针双向实测：焦点 `.focus()`
 *      到文件树后 `activeElement` 是树、`e.target` 仍是 BODY；而 textarea / input / contenteditable
 *      聚焦时 target 指向元素自身）—— 按 `e.target` 判定等于永不进分支，Ctrl+V **永久静默失效**
 *      且不报错。故断言钉的是「用 target 是 body + activeElement 不在编辑宿主」这对正确判据，
 *      以及「旧的错法不许回来」。
 *
 * 做法（与 verify-snooze-persist.mjs / verify-update-stall.mjs 一致）：从
 *   `electron/lib/workspaceManager.ts` 切出**真实实现**（stripTypeScriptTypes(mode:'transform')
 *   → 写临时 .mjs → import），验的是真实 `ws:pasteExternal` 处理函数与真实 `vscodeCopyName` /
 *   `isInside` / `resolveSafe`，不是复刻品。替身只有四处：requireInside 的 rootId→路径查表、
 *   invalidateIndexIfCurrentVault（录调用）、MAX_PASTE_ITEMS（用例临时调小）、以及 fs 全用真的
 *   （临时目录里真拷真验）。
 *
 * 运行（项目根目录）：
 *   node --no-warnings .AGENT/scripts/editor/verify-paste-external.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const SRC_WM = path.join(ROOT, 'electron/lib/workspaceManager.ts')
const src = fs.readFileSync(SRC_WM, 'utf8')

const readIfExists = (rel) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}
const preload = readIfExists('electron/preload/index.ts')
const ipcLib = readIfExists('src/lib/ipc.ts')
const typeDecl = readIfExists('src/types/index.ts')
const mainIndex = readIfExists('electron/main/index.ts')
const fileTree = readIfExists('src/components/shared/VaultTree.tsx')
const editorIdx = readIfExists('src/modules/editor/index.tsx')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

// ================================================================ 1 静态协议 / 接线检查
check('主进程注册 ws:pasteExternal', /ipcMain\.handle\('ws:pasteExternal'/.test(src))
check('preload 转发 ws:pasteExternal', /ipcRenderer\.invoke\('ws:pasteExternal'/.test(preload))
check('preload 暴露 workspacePasteExternal', /workspacePasteExternal:\s*\(/.test(preload))
check('ipc.ts 导出 workspacePasteExternal', /export const workspacePasteExternal\b/.test(ipcLib))
check('types 声明 workspacePasteExternal', /workspacePasteExternal:\s*\(/.test(typeDecl))
check('types 导出 WorkspacePasteResult', /export interface WorkspacePasteResult\b/.test(typeDecl))

check('主进程注册 clipboard:paste', /ipcMain\.handle\('clipboard:paste'/.test(mainIndex))
check('clipboard:paste 打在发起窗口（e.sender.paste）', /e\.sender\.paste\(\)/.test(mainIndex))
check('preload 暴露 pasteFromClipboard', /pasteFromClipboard:\s*\(\)/.test(preload))
check('ipc.ts 导出 pasteFromClipboard', /export const pasteFromClipboard\b/.test(ipcLib))
check('types 声明 pasteFromClipboard', /pasteFromClipboard:\s*\(\)/.test(typeDecl))

check('FileTree 根容器 tabIndex={0}（右键粘贴的 focus 落点）', /tabIndex=\{0\}/.test(fileTree))
check('FileTree 接受 rootRef 并挂到根容器', /rootRef\?:/.test(fileTree) && /ref=\{rootRef\}/.test(fileTree))
check('editor 把 treeRef 传给 FileTree', /rootRef=\{treeRef\}/.test(editorIdx))
// 焦点守卫口径（2026-09-15 探针双向实测）：Chromium 把「非可编辑焦点」的 paste 事件 target
// 重定向成 BODY（焦点 focus() 到文件树后 activeElement 是树、e.target 仍是 BODY），而
// textarea / input / contenteditable 聚焦时 target 指向该元素本身。于是：
//   按 e.target 判定「在不在文件树内」= 永不进分支 = Ctrl+V 静默死掉（旧错法，钉住不许回来）；
//   正确写法 = 「target 是 body（= 没有文本接收方）」+ 「activeElement 不在编辑宿主里」双判据。
check('焦点守卫用 hasTextPasteTarget 双判据（模块级纯函数）',
  /^function hasTextPasteTarget\(e: ClipboardEvent\)/m.test(editorIdx))
check('判据①：浏览器口径 —— paste.target 是 body 才算「无文本接收方」',
  /t !== document\.body && t !== document\.documentElement\) return true/.test(editorIdx))
check('判据②：编辑宿主名单（input/textarea/contenteditable/Monaco）落在模块级纯函数里',
  /^function isTextEditingTarget\(el: Element \| null\)/m.test(editorIdx) &&
  /isContentEditable/.test(editorIdx) && /\.monaco-editor/.test(editorIdx))
check('旧的按 e.target 判定文件树的写法已不存在（否则 Ctrl+V 永久失效）',
  !/closest\?\.\('\[data-kb-filetree\]'\)/.test(editorIdx))
check('paste 监听按 isActive 门禁（隐藏模块不抢事件）', /if \(!isActive\) return[\s\S]{0,400}addEventListener\('paste'/.test(editorIdx))
check('剪贴板里没有文件时不 preventDefault（文本粘贴放行）',
  /files\.length === 0\) return[\s\S]{0,200}hasTextPasteTarget/.test(editorIdx) &&
  /hasTextPasteTarget\(e\)\) return[\s\S]{0,120}e\.preventDefault\(\)/.test(editorIdx))
check('右键「粘贴」经 requestPasteFromMenu 走 webContents.paste 链路',
  /requestPasteFromMenu\b/.test(editorIdx) && /void pasteFromClipboard\(\)/.test(editorIdx))
check('菜单粘贴延后一帧再聚焦（避开菜单卸载引发的 blur）', /requestAnimationFrame\(\(\) => \{[\s\S]{0,200}treeRef\.current\?\.focus\(\)/.test(editorIdx))
check('右键菜单含「粘贴」入口', /ClipboardPaste size=\{13\}/.test(editorIdx))
check('粘贴结果按 skipped 数量分流提示', /已跳过 \$\{res\.skipped\.length\} 项/.test(editorIdx))
check('全失败时提示带出具体原因（不吞成一句「粘贴失败」）', /res\.skipped\[0\]\?\.reason/.test(editorIdx))
check('单次上限常量 = 500', /const MAX_PASTE_ITEMS = 500\b/.test(src))
check('渲染层记下最近点中的目录（落点兜底）', /lastTreeDirRef/.test(editorIdx))
check('粘 .md 后失效知识索引', /pasted\.some\(\(n\) => \/\\\.md\$\/i\.test\(n\)\)\) invalidateIndexIfCurrentVault/.test(src))
check('粘贴用 cp 而非 rename（复制语义，源保留）', /await cp\(src, join\(destDir, finalName\)/.test(src))

// ================================================================ 2 切出真实实现
/** 按大括号配平切出完整块（从 token 起），能处理 class / 多行函数 */
function sliceBraced(text, token) {
  const from = text.indexOf(token)
  if (from < 0) throw new Error(`未找到 ${token}`)
  const bodyAt = text.indexOf('{', from)
  if (bodyAt < 0) throw new Error(`${token} 没有块起始大括号`)
  let depth = 0
  for (let j = bodyAt; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}') {
      depth--
      if (depth === 0) return text.slice(from, j + 1)
    }
  }
  throw new Error(`${token} 大括号未配平`)
}

/** 切出单行 `const NAME = ...` */
function sliceConst(text, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*[^\\n]+`).exec(text)
  if (!m) throw new Error(`未找到常量 ${name}`)
  return m[0]
}

/**
 * 切出 `ipcMain.handle('<channel>', async (...) => {...})` 里的箭头函数体（含参数表）。
 * 两个坑：
 *   ① 参数表 ')' 与大括号之间还有返回类型，不能拿「从大括号起算的块长」直接加到参数表位置
 *      —— 少加就把函数尾部切掉一截，切出来仍是合法前缀、不报错（含类型时尤其致命）。
 *   ② 必须把参数表**前面的 `async` 关键字一起带上**：只切 `(...) => {}` 会得到「非 async 函数
 *      里用 await」，剥类型阶段直接抛 `await isn't allowed in non-async function`。
 * 这里参数表起点用 lastIndexOf('(') 反查、再往前回吞 `async`，块终点按大括号绝对位置算。
 */
function sliceHandlerArrow(text, channel) {
  const token = `ipcMain.handle('${channel}'`
  const from = text.indexOf(token)
  if (from < 0) throw new Error(`未找到 handler ${channel}`)
  const arrowAt = text.indexOf('=>', from)
  if (arrowAt < 0) throw new Error(`${channel} 未找到箭头`)
  const parenAt = text.lastIndexOf('(', arrowAt)
  let i = parenAt
  let paren = 0
  for (; i < text.length; i++) {
    if (text[i] === '(') paren++
    else if (text[i] === ')') { paren--; if (paren === 0) { i++; break } }
  }
  const bodyAt = text.indexOf('{', i)
  if (bodyAt < 0) throw new Error(`${channel} 没有函数体起始大括号`)
  const blk = sliceBraced(text.slice(bodyAt), '{') // 从大括号起算 → 返回长度即块长
  const m = /async\s*$/.exec(text.slice(0, parenAt))
  const startAt = m ? parenAt - m[0].length : parenAt
  return text.slice(startAt, bodyAt + blk.length)
}

const realCap = Number(/const MAX_PASTE_ITEMS = (\d+)/.exec(src)?.[1])
if (!Number.isFinite(realCap)) throw new Error('未能从源码解析 MAX_PASTE_ITEMS')

// 真 handler 的箭头源：既用于装配 harness，也用于「它没有多写一条广播」这类断言
const pasteArrowSrc = sliceHandlerArrow(src, 'ws:pasteExternal')
check('粘贴不写 broadcastDataChanged（与 createFile/mkdir 同口径，由渲染层自行刷新）',
  !/broadcastDataChanged/.test(pasteArrowSrc))

/** 组装只含粘贴链路的最小模块：真实 isInside / resolveSafe / vscodeCopyName / 真实 handler 箭头 */
function buildHarness() {
  return `
import { existsSync, lstatSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { basename, join, relative, resolve, sep, extname, isAbsolute } from 'node:path'

// —— 唯一被替换的依赖：rootId → 磁盘路径的查表（真 requireRoot 就是个 Map.get）+ 索引失效记录 ——
export const __roots = { r1: '' }
export const __invalidate = { calls: [] }
export function __setRoot(p) { __roots.r1 = p }
function invalidateIndexIfCurrentVault(rootId) { __invalidate.calls.push(rootId) }

function requireRoot(rootId) {
  const p = __roots[rootId]
  if (!p) throw new Error('未授权的工作区')
  return { id: rootId, name: 'test', rootPath: p }
}
function requireInside(rootId, relPath) {
  const abs = resolveSafe(requireRoot(rootId).rootPath, relPath)
  if (!abs) throw new Error('路径越界或非法')
  return abs
}

// 上限用 let：用例可以调小以在几次拷贝内验出「超出上限」分支（源码原值由用例另行静态断言）
let MAX_PASTE_ITEMS = ${realCap}
export function __setCap(n) { MAX_PASTE_ITEMS = n }
export function __maxPasteItems() { return MAX_PASTE_ITEMS }

// —— 以下全部为源码切片（真实实现）——
${sliceBraced(src, 'function isInside')}
${sliceBraced(src, 'function resolveSafe')}
${sliceBraced(src, 'function vscodeCopyName')}

export const pasteExternal = ${pasteArrowSrc}
`
}

// ================================================================ 3 运行
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-paste-verify-'))
const tmpModules = []
let mod = null
let step = ''

function makeHarness() {
  const file = path.join(tmpRoot, `harness-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, stripTypeScriptTypes(buildHarness(), { mode: 'transform' }), 'utf8')
  tmpModules.push(file)
  return import(pathToFileURL(file).href)
}

/** 建一个"仓库"目录（ws:pasteExternal 的落点根） */
function makeVault(tag) {
  const p = path.join(tmpRoot, `vault-${tag}`)
  fs.mkdirSync(p, { recursive: true })
  return p
}

const srcBox = path.join(tmpRoot, 'src')
fs.mkdirSync(srcBox, { recursive: true })
fs.writeFileSync(path.join(srcBox, 'a.txt'), 'AAA', 'utf8')
fs.writeFileSync(path.join(srcBox, 'a.b.txt'), 'AB', 'utf8')
fs.mkdirSync(path.join(srcBox, 'subdir'), { recursive: true })
fs.writeFileSync(path.join(srcBox, 'subdir', 'inner.txt'), 'INNER', 'utf8')
fs.writeFileSync(path.join(srcBox, 'note.md'), '---\nid: x\n---\n', 'utf8')

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)

const run = async () => {
  mod = await makeHarness()
  const { pasteExternal, __setRoot, __invalidate, __setCap, __maxPasteItems } = mod

  check('切片出的上限常量与源码一致', __maxPasteItems() === realCap, `切片=${__maxPasteItems()} 源码=${realCap}`)

  // ---------- A 无冲突粘贴文件 ----------
  step = 'A 无冲突粘贴'
  let vault = makeVault('A')
  __setRoot(vault)
  let r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.txt')])
  check('A1 单文件无冲突：ok=true 且原名落盘', r.ok === true && r.pasted.length === 1 && r.pasted[0] === 'a.txt', JSON.stringify(r.pasted))
  check('A2 内容真的拷过去（不是空壳）', read(path.join(vault, 'a.txt')) === 'AAA')
  check('A3 源文件仍在（复制而非移动）', read(path.join(srcBox, 'a.txt')) === 'AAA')
  check('A4 无 skipped', r.skipped.length === 0, JSON.stringify(r.skipped))

  // ---------- B/C 重名递增：copy → copy 2 ----------
  step = 'B/C 重名递增'
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.txt')])
  check('B1 二次粘贴 → a copy.txt', r.pasted[0] === 'a copy.txt', JSON.stringify(r.pasted))
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.txt')])
  check('B2 三次粘贴 → a copy 2.txt', r.pasted[0] === 'a copy 2.txt', JSON.stringify(r.pasted))
  check('B3 递增名字下内容完好', read(path.join(vault, 'a copy 2.txt')) === 'AAA')

  // ---------- F 多段扩展名：stem 保留中间点 ----------
  step = 'F 多段扩展名'
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.b.txt')])
  check('F1 a.b.txt 无冲突 → 原名', r.pasted[0] === 'a.b.txt', JSON.stringify(r.pasted))
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.b.txt')])
  check('F2 a.b.txt 冲突 → a.b copy.txt（stem=a.b）', r.pasted[0] === 'a.b copy.txt', JSON.stringify(r.pasted))

  // ---------- D/E 目录递归 + 无扩展名目录递增 ----------
  step = 'D/E 目录'
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'subdir')])
  check('D1 目录递归复制', r.pasted[0] === 'subdir' && read(path.join(vault, 'subdir', 'inner.txt')) === 'INNER', JSON.stringify(r.pasted))
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'subdir')])
  check('D2 目录冲突 → subdir copy（无扩展名不加点）', r.pasted[0] === 'subdir copy', JSON.stringify(r.pasted))
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'subdir')])
  check('D3 目录二次冲突 → subdir copy 2', r.pasted[0] === 'subdir copy 2', JSON.stringify(r.pasted))
  check('D4 副本目录内容完好', read(path.join(vault, 'subdir copy 2', 'inner.txt')) === 'INNER')

  // ---------- G 空入参 ----------
  step = 'G 空入参'
  r = await pasteExternal(null, 'r1', '', [])
  check('G1 空数组 → ok=false reason=empty', r.ok === false && r.reason === 'empty', JSON.stringify(r))
  r = await pasteExternal(null, 'r1', '', null)
  check('G2 非数组 → ok=false reason=empty', r.ok === false && r.reason === 'empty', JSON.stringify(r))
  r = await pasteExternal(null, 'r1', '', [1, '', null, '   '])
  check('G3 全是脏值 → 一项都不落盘、逐条记 skipped（不抛错）',
    r.ok === false && r.pasted.length === 0 && r.skipped.length === 1 && r.skipped[0].reason === '不是绝对路径',
    JSON.stringify(r))

  // ---------- H 相对路径 ----------
  step = 'H 相对路径'
  fs.mkdirSync(path.join(vault, 'sub'), { recursive: true }) // 落点先存在，否则先撞 statSync 的 ENOENT
  r = await pasteExternal(null, 'r1', 'sub', ['relative/a.txt'])
  check('H1 相对路径被拒', r.pasted.length === 0 && r.skipped[0]?.reason === '不是绝对路径', JSON.stringify(r.skipped))

  // ---------- I 源不存在 ----------
  step = 'I 源不存在'
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'nope.txt')])
  check('I1 源不存在 → 进 skipped 而非整体抛错', r.ok === false && r.skipped.length === 1 && r.pasted.length === 0, JSON.stringify(r.skipped))

  // ---------- J 符号链接源（junction 无需管理员） ----------
  step = 'J 符号链接'
  let linkPath = ''
  try {
    linkPath = path.join(tmpRoot, 'link-to-subdir')
    fs.symlinkSync(path.join(srcBox, 'subdir'), linkPath, 'junction')
  } catch { linkPath = '' }
  if (linkPath && fs.lstatSync(linkPath).isSymbolicLink()) {
    r = await pasteExternal(null, 'r1', '', [linkPath])
    check('J1 符号链接源被拒（防仓库外内容链入）', r.pasted.length === 0 && r.skipped[0]?.reason === '符号链接', JSON.stringify(r.skipped))
  } else {
    check('J1 符号链接源被拒（防仓库外内容链入）', false, '环境无法创建 junction，用例未执行')
  }

  // ---------- K 把目录粘进它自己 / 粘进子孙 ----------
  step = 'K 自嵌套'
  const selfDir = path.join(vault, 'selfdir')
  fs.mkdirSync(selfDir, { recursive: true })
  r = await pasteExternal(null, 'r1', 'selfdir', [selfDir])
  check('K1 目录粘到自己 → 拒（否则无限递归）', r.pasted.length === 0 && r.skipped[0]?.reason === '目标位于源目录内', JSON.stringify(r.skipped))
  r = await pasteExternal(null, 'r1', 'selfdir', [vault])
  check('K2 仓库根粘进自己子孙 → 拒', r.pasted.length === 0 && r.skipped[0]?.reason === '目标位于源目录内', JSON.stringify(r.skipped))

  // ---------- M 目标不是目录 ----------
  step = 'M 目标非目录'
  fs.writeFileSync(path.join(vault, 'plain.txt'), 'x', 'utf8')
  r = await pasteExternal(null, 'r1', 'plain.txt', [path.join(srcBox, 'a.txt')])
  check('M1 落点不是目录 → ok=false reason=notdir', r.ok === false && r.reason === 'notdir', JSON.stringify(r))

  // ---------- L 超过单次上限 ----------
  step = 'L 超上限'
  __setCap(3)
  r = await pasteExternal(null, 'r1', '', [
    path.join(srcBox, 'a.txt'), path.join(srcBox, 'a.b.txt'), path.join(srcBox, 'subdir'), path.join(srcBox, 'note.md'),
  ])
  check('L1 超上限条目进 skipped 且原因可读', r.skipped.length === 1 && /超出单次上限 3/.test(r.skipped[0].reason), JSON.stringify(r.skipped))
  check('L2 上限内条目照常落盘（不整批放弃）', r.pasted.length === 3 && r.ok === true, JSON.stringify(r.pasted))
  __setCap(realCap)

  // ---------- N/P .md 触发索引失效 ----------
  step = 'N/P 索引失效'
  vault = makeVault('N')
  __setRoot(vault)
  __invalidate.calls.length = 0
  await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.txt')])
  check('N1 非 .md 粘贴不失效索引', __invalidate.calls.length === 0, JSON.stringify(__invalidate.calls))
  __invalidate.calls.length = 0
  await pasteExternal(null, 'r1', '', [path.join(srcBox, 'note.md')])
  check('N2 粘 .md 恰好失效索引一次', __invalidate.calls.length === 1 && __invalidate.calls[0] === 'r1', JSON.stringify(__invalidate.calls))

  // ---------- O 部分成功 / 全失败 ----------
  step = 'O 部分成功'
  vault = makeVault('O')
  __setRoot(vault)
  r = await pasteExternal(null, 'r1', '', [path.join(srcBox, 'a.txt'), 'C:/definitely/missing/file.txt', path.join(srcBox, 'subdir')])
  check('O1 部分成功 → ok=true 且逐条记账', r.ok === true && r.pasted.length === 2 && r.skipped.length === 1, JSON.stringify({ pasted: r.pasted, skipped: r.skipped }))
  check('O2 成功项确实在盘上', read(path.join(vault, 'a.txt')) === 'AAA')

  // ---------- 越界目标 ----------
  step = 'Q 越界'
  r = await pasteExternal(null, 'r1', '../escape', [path.join(srcBox, 'a.txt')])
  check('Q1 落点越界 → ok=false reason=error', r.ok === false && r.reason === 'error' && /越界或非法/.test(r.error ?? ''), JSON.stringify(r))

  // ---------- 未授权仓库 ----------
  step = 'R 未授权'
  r = await pasteExternal(null, 'nope', '', [path.join(srcBox, 'a.txt')])
  check('R1 未授权 rootId → ok=false reason=error', r.ok === false && r.reason === 'error', JSON.stringify(r))
}

let timer = null
const guard = new Promise((_, rej) => {
  timer = setTimeout(() => rej(new Error(`硬超时（60s）：卡在 ${step}`)), 60_000)
})

try {
  await Promise.race([run(), guard])
} catch (e) {
  check(`运行期异常（${step}）`, false, String(e?.stack || e))
} finally {
  clearTimeout(timer)
}

// ================================================================ 4 汇总
let pass = 0
let fail = 0
for (const c of checks) {
  if (c.pass) { pass++; console.log(`PASS  ${c.name}${c.detail ? '   → ' + c.detail : ''}`) }
  else { fail++; console.log(`FAIL  ${c.name}${c.detail ? '   → ' + c.detail : ''}`) }
}
console.log(`\n${pass} PASS / ${fail} FAIL`)

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch { /* 临时目录残留不影响结论 */ }

process.exit(fail === 0 ? 0 : 1)

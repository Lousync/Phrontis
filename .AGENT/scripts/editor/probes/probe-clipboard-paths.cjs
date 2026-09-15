/**
 * 平台探针：系统剪贴板里的**外部文件路径**到底能从哪读到、能读到几条，
 * 以及 paste 事件的 target 在什么情况下指向编辑宿主。
 *
 * 为什么值得留在仓库里（而不是跑完就删）：
 *   编辑器文件树的「粘贴外部文件」功能（v3.2.0 条目 ③）的**路线选择完全押在这两个平台行为上**，
 *   而它们都不在文档里、只实测过：
 *     ① 主进程 `clipboard.readBuffer('FileNameW')` 在 Electron 33.2.0 / win32 上**只能拿到第一条
 *        路径**，且载荷里**没有 DROPFILES 头**（首 4 字节不是 pFiles=20，而是路径首字符 'C\0'）——
 *        多选会静默丢文件，所以路线改走渲染层 `paste` 事件 + `webUtils.getPathForFile`。
 *     ② Chromium 把**非可编辑焦点**的 paste 事件 target 重定向成 `BODY`：焦点 `.focus()` 到
 *        tabindex=0 的 div 后 `activeElement` 是那个 div、`e.target` 仍是 BODY。所以焦点守卫
 *        绝不能写「`e.target` 在文件树内才接管」（那等于永不进分支，Ctrl+V 永久静默失效）。
 *   Electron 升级后这两条都可能变，届时重跑本探针即可知道路线还要不要守。
 *
 * 运行（项目根目录；需要 Windows PowerShell 提供 Set-Clipboard）：
 *   node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .AGENT/scripts/editor/probes/probe-clipboard-paths.cjs
 * 注意：跑之前先 `unset ELECTRON_RUN_AS_NODE`，否则 electron.exe 退化成纯 node、Chromium 开关全报 bad option。
 *
 * 退出码：渲染层取不全（路线前提被破坏）→ 1；其余情况 0（观察信息照常打印）。
 */
const { app, BrowserWindow, clipboard } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BOX = path.join(os.tmpdir(), 'kb-clipboard-paths-probe')
const PAGE = path.join(BOX, 'probe.html')

const hexHead = (b, n = 32) =>
  Buffer.from(b).toString('hex', 0, Math.min(n, b.length)).replace(/(..)/g, '$1 ').trim()

/** 用 PowerShell 的 Set-Clipboard -Path 写入真实文件项（等价于资源管理器里复制几个文件） */
function primeClipboard() {
  fs.rmSync(BOX, { recursive: true, force: true })
  fs.mkdirSync(path.join(BOX, 'sub dir'), { recursive: true })
  fs.writeFileSync(path.join(BOX, 'a 中文.txt'), 'hello', 'utf8')
  fs.writeFileSync(path.join(BOX, 'b.md'), 'world', 'utf8')
  const items = [
    path.join(BOX, 'a 中文.txt'),
    path.join(BOX, 'b.md'),
    path.join(BOX, 'sub dir'),
  ]
  const ps = `Set-Clipboard -Path ${items.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')}`
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 20_000 })
  return items
}

/** 探针页面：一个可聚焦 div（文件树角色）+ textarea / contenteditable（编辑宿主角色） */
function writePage() {
  fs.mkdirSync(BOX, { recursive: true })
  fs.writeFileSync(PAGE, `<!doctype html>
<html><head><meta charset="utf-8" /><title>probe</title></head><body>
<div id="tree" tabindex="0"><span id="row">文件树（非编辑宿主）</span></div>
<textarea id="ta"></textarea>
<div id="ce" contenteditable="true">contenteditable</div>
<script>
  const { ipcRenderer, webUtils } = require('electron')
  window.__hits = []
  document.addEventListener('paste', (e) => {
    const t = e.target
    const files = e.clipboardData && e.clipboardData.files ? Array.from(e.clipboardData.files) : []
    window.__hits.push({
      targetId: t && t.id ? t.id : (t ? t.tagName : 'null'),
      targetIsBody: t === document.body || t === document.documentElement,
      activeId: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      fileCount: files.length,
      paths: files.map((f) => { try { return webUtils.getPathForFile(f) } catch (ex) { return 'ERR:' + ex.message } }),
    })
  })
  ipcRenderer.send('probe-ready')
</script></body></html>`, 'utf8')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const result = { electron: process.versions.electron, platform: process.platform, readBuffer: null, renderer: null, focusTable: [], verdict: [] }

  let expected = []
  try {
    expected = primeClipboard()
  } catch (e) {
    result.primeError = String(e && e.message)
  }
  await sleep(400)

  // ---------- ① 主进程直接读剪贴板 ----------
  try {
    result.availableFormats = clipboard.availableFormats()
  } catch (e) {
    result.availableFormats = 'ERR ' + e.message
  }
  try {
    const buf = clipboard.readBuffer('FileNameW')
    result.readBuffer = buf && buf.length
      ? {
        bytes: buf.length,
        head64hex: hexHead(buf, 64),
        // 真 CF_HDROP 的头 4 字节是小端 pFiles(=20)；这里拿到的是路径首字符就说明没有 DROPFILES 头
        firstU32LE: buf.readUInt32LE(0),
        paths: buf.toString('ucs2').split('\u0000').filter(Boolean),
      }
      : null
  } catch (e) {
    result.readBuffer = 'ERR ' + e.message
  }
  try {
    result.readTextUriList = clipboard.read('text/uri-list')
    result.readText = clipboard.readText()
  } catch { /* ignore */ }

  // ---------- ② 渲染层 paste 事件 + webUtils.getPathForFile ----------
  writePage()
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  })
  const wc = win.webContents
  await new Promise((resolve) => {
    const { ipcMain } = require('electron')
    ipcMain.once('probe-ready', resolve)
    win.loadFile(PAGE)
    setTimeout(resolve, 4000)
  })
  win.focus()
  wc.focus()
  await sleep(300)

  const record = async (name, focusJs) => {
    await wc.executeJavaScript('window.__hits = []')
    if (focusJs) await wc.executeJavaScript(focusJs)
    wc.paste()
    await sleep(200)
    const hits = await wc.executeJavaScript('window.__hits')
    return { name, hit: hits[0] ?? null }
  }

  const treeHit = await record('文件树（tabindex=0）聚焦', 'document.getElementById("tree").focus()')
  result.renderer = treeHit.hit ? { fileCount: treeHit.hit.fileCount, paths: treeHit.hit.paths } : null

  for (const [name, js] of [
    ['body / 无焦点', 'document.activeElement && document.activeElement.blur()'],
    ['textarea 聚焦（Monaco 旧形态）', 'document.getElementById("ta").focus()'],
    ['contenteditable 聚焦（Monaco 新形态）', 'document.getElementById("ce").focus()'],
  ]) {
    const r = await record(name, js)
    result.focusTable.push({ name, ...(r.hit ?? {}) })
  }

  // ---------- ③ 结论 ----------
  const nExpected = expected.length
  const nRenderer = result.renderer ? result.renderer.fileCount : 0
  const nBuffer = Array.isArray(result.readBuffer?.paths) ? result.readBuffer.paths.length : 0

  result.expectedItems = nExpected
  result.verdict.push(`剪贴板实际 ${nExpected} 项 → 主进程 readBuffer('FileNameW') 读到 ${nBuffer} 项；渲染层 paste 读到 ${nRenderer} 项`)
  if (nRenderer < nExpected) {
    result.verdict.push('FAIL 渲染层取不全：A 路（paste 事件 + webUtils.getPathForFile）前提被破坏，路线需重估')
    result.exitCode = 1
  } else {
    result.verdict.push('OK   A 路前提成立（渲染层全量可取）')
  }
  if (nBuffer >= nExpected) {
    result.verdict.push('NOTE 主进程 readBuffer 已能取全 → 平台行为可能已变，B 路可重新评估（当前不必改）')
  } else {
    result.verdict.push(`OK   主进程 readBuffer 仍缺 ${nExpected - nBuffer} 项 → 不能走 B 路（多选会静默丢文件）`)
  }
  const tableOk = result.focusTable.every((r) => r.targetIsBody === (r.name === 'body / 无焦点')) &&
    result.focusTable.every((r) => (r.name === 'body / 无焦点' ? r.targetIsBody : r.targetIsBody === false))
  result.verdict.push(tableOk
    ? 'OK   编辑宿主聚焦时 paste.target 指向宿主本身 → 守卫按「target 是不是 body」判定成立'
    : 'WARN focus 表与预期不符，请人工核对（守卫双判据应能兜住）')

  process.stdout.write('PROBE_RESULT ' + JSON.stringify(result, null, 2) + '\n')
  const outFile = path.join(ROOT, 'tmp', 'probe-clipboard-paths.result.json')
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8') } catch { /* ignore */ }
  setTimeout(() => app.exit(result.exitCode ?? 0), 150)
})

setTimeout(() => {
  process.stdout.write('PROBE_RESULT {"error":"HARD_TIMEOUT"}\n')
  app.exit(1)
}, 40_000)

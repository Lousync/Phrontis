#!/usr/bin/env node
/**
 * Worktree desktop launcher manager.
 *
 * After a new git worktree is created, this machine wants a one-click launcher
 * for it on the desktop. That launcher is a THIN wrapper: the real logic is in
 * version control at <worktree>\scripts\start-desktop.bat (self-locating), so
 * the wrapper only has to point at the worktree.
 *
 * TWO HARD RULES for the generated wrapper (see AGENTS.md, section Workflow):
 *   1) File NAME and file CONTENT must be pure ASCII -- no Chinese. cmd.exe
 *      parses batch files in the OEM codepage; Chinese in a .bat corrupts the
 *      parser in both utf-8 and gbk files. Line endings must be CRLF.
 *   2) The wrapper must be DELETED once its worktree is destroyed. Two layers
 *      cover that: the wrapper deletes itself when it finds its worktree gone,
 *      and `clean` sweeps leftovers (run it as part of worktree teardown).
 *
 * Usage:
 *   node .AGENT/scripts/worktree-launcher/desktop-launcher.mjs create --worktree <abs path> [--name <file.ext>] [--desktop <dir>]
 *   node .AGENT/scripts/worktree-launcher/desktop-launcher.mjs list
 *   node .AGENT/scripts/worktree-launcher/desktop-launcher.mjs clean [--dry-run]
 *
 * Linux 平台化（2026-10-19）—— 与 Windows 的三处有意分叉：
 *   · 薄壳改成 .desktop（指向 scripts/start-desktop.sh），文件名 Phrontis-dev-<后缀>.desktop；
 *   · 默认落 ~/.local/share/applications（XDG 应用网格），**不是** ~/Desktop ——
 *     桌面上的 .desktop 必须先 `gio set … metadata::trusted true` 才能双击运行，
 *     否则 GNOME 弹「不受信任的启动器」，正是本项目最忌讳的「双击没反应」形态。
 *     要放桌面就显式 --desktop ~/Desktop。
 *   · 硬约束相反：.desktop 必须 **LF**、允许 UTF-8（.bat 是 CRLF + 纯 ASCII）。
 *
 * Exit codes: 0 = ok, 1 = failure.
 * Output is ASCII-only on purpose (Windows console codepage).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const MARKER = 'KB-WORKTREE-LAUNCHER'
/** .desktop 里装 worktree 绝对路径的自定义键（.bat 走 `rem <MARKER> worktree=…` 注释行） */
const MARKER_KEY = 'X-Phrontis-Worktree'
/** 薄壳要指向的入口脚本：Windows 是 .bat，其余平台是 .sh（scripts/start-desktop.sh） */
const ENTRY_REL = process.platform === 'win32'
  ? path.join('scripts', 'start-desktop.bat')
  : path.join('scripts', 'start-desktop.sh')
/** 生成的薄壳扩展名 */
const WRAPPER_EXT = process.platform === 'win32' ? '.bat' : '.desktop'
const MAIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function fail(msg) {
  console.error('[FAIL] ' + msg)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}

/** Launcher folder: --desktop, then KB_DESKTOP, then the platform's usual spot. */
function resolveDesktop(args) {
  const explicit = args.desktop || process.env.KB_DESKTOP
  if (explicit) {
    const dir = path.resolve(explicit)
    if (!fs.existsSync(dir)) fail('desktop folder does not exist: ' + dir)
    return dir
  }
  if (process.platform !== 'win32') {
    // XDG 应用网格目录。刻意不用 ~/Desktop：桌面上的 .desktop 需要 gio 标记 trusted
    // 才可双击运行，否则 GNOME 弹「不受信任的启动器」—— 反倒成了「双击没反应」。
    // 那个目录是系统级路径，缺了就建（与应用商店安装的条目同一位置）。
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
    const dir = path.join(base, 'applications')
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 交给下面 writeFileSync 报错 */ }
    return dir
  }
  const home = process.env.USERPROFILE || os.homedir()
  const candidates = [
    path.join(home, 'Desktop'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : null
  ].filter(Boolean)
  for (const dir of candidates) if (fs.existsSync(dir)) return dir
  fail('cannot locate the desktop folder; pass --desktop <dir> or set KB_DESKTOP')
}

/**
 * worktree 的短后缀：剥掉主仓目录名前缀。主仓历史上叫 KnowledgeRecorder、现在是 Phrontis
 * —— **两个前缀都要剥**，否则得到 Phrontis-dev-Phrontis-linux.bat 这种重复前缀
 * （原实现只剥了前者）。
 */
function suffixOf(worktree) {
  const base = path.basename(worktree)
  return base.replace(/^(Phrontis|KnowledgeRecorder)-?/, '') || 'main'
}

/** 默认名：Phrontis-dev-<后缀><扩展名>，永远是 ASCII。 */
function defaultName(worktree) {
  return `Phrontis-dev-${suffixOf(worktree)}${WRAPPER_EXT}`
}

function wrapperText(worktree, branch) {
  const entry = path.join(worktree, ENTRY_REL)
  const L = [
    '@echo off',
    'rem ===========================================================',
    'rem  Phrontis dev launcher -- desktop wrapper (GENERATED FILE).',
    'rem  worktree : ' + worktree,
    'rem  branch   : ' + (branch || '(unknown)'),
    'rem ' + MARKER + ' worktree=' + worktree,
    'rem',
    'rem  Real launch logic (version controlled, self-locating):',
    'rem    ' + entry,
    'rem  Regenerate or remove this wrapper with:',
    'rem    ' + path.join(MAIN_ROOT, '.AGENT', 'scripts', 'worktree-launcher', 'desktop-launcher.mjs'),
    'rem',
    'rem  EDITING RULES (both were learned the hard way):',
    'rem   1) CRLF line endings only. LF-only makes cmd.exe resync in the',
    'rem      middle of a line and execute text fragments as commands.',
    'rem   2) ASCII text only -- no Chinese in the file OR in its name.',
    'rem ===========================================================',
    'setlocal',
    'set "WT=' + worktree + '"',
    'set "ENTRY=%WT%\\' + ENTRY_REL.replace(/\//g, '\\') + '"',
    '',
    'if not exist "%ENTRY%" goto gone',
    '',
    'call "%ENTRY%"',
    'exit /b %ERRORLEVEL%',
    '',
    ':gone',
    'echo [launcher] Worktree not found: %WT%',
    'echo [launcher] This shortcut deletes itself now.',
    'timeout /t 2 /nobreak >nul 2>&1',
    '(goto) 2>nul & del /f /q "%~f0"',
    'exit /b 1',
    ''
  ]
  return L.join('\r\n')
}

/** Generated files must satisfy both hard rules; checked before we claim success. */
function check(text) {
  const problems = []
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) problems.push('non-ASCII byte in content')
  if (/(^|[^\r])\n/.test(text)) problems.push('bare LF line ending (CRLF required)')
  return problems
}

/**
 * .desktop 薄壳（Linux）。只做一件事：把 worktree 的 scripts/start-desktop.sh 挂到
 * 应用网格里。真逻辑仍在版本控制的入口脚本里，与本文件的 Windows 分支同一口径。
 *
 * Terminal=true 是必须的：入口脚本与 start-desktop.js 都会往控制台打失败原因，
 * 而这正是「窗口一闪就没」时唯一还能留下的现场。
 */
function desktopFileText(worktree, branch) {
  const entry = path.join(worktree, ENTRY_REL)
  return [
    '# Phrontis dev launcher -- GENERATED FILE, do not edit.',
    '# worktree : ' + worktree,
    '# branch   : ' + (branch || '(unknown)'),
    '# ' + MARKER + ' worktree=' + worktree,
    '# Real launch logic (version controlled): ' + entry,
    '# Regenerate / remove with this very script (list | clean).',
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Phrontis (dev ' + suffixOf(worktree) + ')',
    'Comment=Phrontis dev worktree: ' + worktree + ' (branch ' + (branch || 'unknown') + ')',
    // Desktop Entry 规范要求带空格的参数用双引号包起来；JSON.stringify 顺手把反斜杠也转义了
    'Exec=' + JSON.stringify(entry),
    'Path=' + worktree,
    'Terminal=true',
    'Categories=Development;',
    'Icon=' + path.join(worktree, 'build', 'icon.png'),
    MARKER_KEY + '=' + worktree,
    ''
  ].join('\n')
}

/**
 * .desktop 的硬约束与 .bat **相反**：必须 LF（CRLF 会变成值尾的 \r，解析出来的路径全带脏字符），
 * 且允许 UTF-8（.desktop 规范就是 UTF-8）。别把 .bat 的检查照搬过来。
 */
function checkDesktop(text) {
  const problems = []
  if (/\r/.test(text)) problems.push('CR present (LF required for .desktop)')
  if (!/^\[Desktop Entry\]$/m.test(text)) problems.push('missing [Desktop Entry] group')
  // 逐行校验：只允许 空行 / # 注释 / [组名] / Key=Value（含 Name[zh_CN] 这类 locale 后缀）
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    if (/^\[[^\]]+\]$/.test(line)) continue
    if (/^[A-Za-z0-9-]+(\[[^\]]*\])?=/.test(line)) continue
    problems.push('malformed line: ' + line.slice(0, 40))
  }
  return problems
}

function branchOf(worktree) {
  try {
    const head = fs.readFileSync(path.join(worktree, '.git'), 'utf8')
    const m = head.match(/^gitdir:\s*(.+)$/m)
    if (!m) return null
    const gitdir = path.resolve(worktree, m[1].trim())
    const ref = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim()
    return ref.replace(/^ref:\s*refs\/heads\//, '')
  } catch {
    return null
  }
}

/**
 * 扫出本工具生成过的薄壳（两种格式都认：Windows .bat/.cmd 与 Linux .desktop）。
 * 判定依据是各自的 marker，不是文件名 —— 文件名可以被用户改。
 */
function scan(desktop) {
  const found = []
  let entries = []
  try {
    entries = fs.readdirSync(desktop)
  } catch {
    return found
  }
  for (const name of entries) {
    const isWin = /\.(bat|cmd)$/i.test(name)
    const isLin = /\.desktop$/i.test(name)
    if (!isWin && !isLin) continue
    const file = path.join(desktop, name)
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const m = isWin
      ? text.match(new RegExp('^rem\\s+' + MARKER + '\\s+worktree=(.+)$', 'm'))
      : text.match(new RegExp('^' + MARKER_KEY + '=(.+)$', 'm'))
    if (!m) continue
    const worktree = m[1].trim()
    found.push({ file, worktree, alive: fs.existsSync(worktree) })
  }
  return found
}

function cmdCreate(args) {
  const worktree = args.worktree ? path.resolve(args.worktree) : null
  if (!worktree) fail('create needs --worktree <abs path>')
  if (!fs.existsSync(worktree)) fail('worktree path does not exist: ' + worktree)
  const entry = path.join(worktree, ENTRY_REL)
  if (!fs.existsSync(entry)) {
    console.warn('[WARN] entry script missing in the worktree: ' + entry)
    console.warn('[WARN] the wrapper will report "Worktree not found" until it exists.')
  }
  const desktop = resolveDesktop(args)
  const name = args.name || defaultName(worktree)
  if (/[^\x20-\x7e]/.test(name)) fail('launcher name must be ASCII: ' + name)
  const file = path.join(desktop, name)

  const isWin = process.platform === 'win32'
  const text = isWin ? wrapperText(worktree, branchOf(worktree)) : desktopFileText(worktree, branchOf(worktree))
  const problems = isWin ? check(text) : checkDesktop(text)
  if (problems.length) fail('generated wrapper violates the rules: ' + problems.join('; '))

  fs.writeFileSync(file, text, isWin ? { encoding: 'ascii' } : { encoding: 'utf8', mode: 0o755 })

  const written = fs.readFileSync(file, 'utf8')
  const after = isWin ? check(written) : checkDesktop(written)
  if (after.length) fail('written file violates the rules: ' + after.join('; '))

  if (!isWin) {
    // 让应用网格立刻刷出这条（没装 update-desktop-database 也不影响，只是晚一点出现）
    try { spawnSync('update-desktop-database', [desktop], { stdio: 'ignore' }) } catch { /* best effort */ }
  }

  console.log('[OK]   wrapper : ' + file)
  console.log('[OK]   worktree: ' + worktree)
  if (isWin) {
    console.log('[INFO] rules   : ASCII-only content, CRLF endings, no non-ASCII name')
  } else {
    console.log('[INFO] rules   : UTF-8 content, LF endings, no non-ASCII name')
    console.log('[INFO] note    : written to the XDG applications dir, so it shows up in the')
    console.log('[INFO]           app grid. For a desktop ICON instead, pass --desktop ~/Desktop')
    console.log('[INFO]           and mark it trusted: gio set <file> metadata::trusted true')
  }
  console.log('[INFO] cleanup : delete this file when the worktree is destroyed, or run')
  console.log('[INFO]           node ' + path.join('.AGENT', 'scripts', 'worktree-launcher', 'desktop-launcher.mjs') + ' clean')
}

function cmdList(args) {
  const desktop = resolveDesktop(args)
  const found = scan(desktop)
  console.log('[INFO] desktop : ' + desktop)
  if (!found.length) {
    console.log('[INFO] no wrapper with marker ' + MARKER + ' found')
    return
  }
  for (const item of found) {
    console.log((item.alive ? '[OK]   ALIVE : ' : '[STALE] GONE : ') + item.file)
    console.log('       worktree: ' + item.worktree)
  }
}

function cmdClean(args) {
  const desktop = resolveDesktop(args)
  const found = scan(desktop)
  const stale = found.filter(f => !f.alive)
  console.log('[INFO] desktop : ' + desktop)
  console.log('[INFO] wrappers: ' + found.length + ' found, ' + stale.length + ' stale')
  for (const item of found) {
    if (item.alive) {
      console.log('[KEEP] ' + item.file)
      continue
    }
    if (args.dryRun) {
      console.log('[DRY]  would delete ' + item.file + ' (worktree gone: ' + item.worktree + ')')
      continue
    }
    try {
      fs.unlinkSync(item.file)
      console.log('[DEL]  ' + item.file)
    } catch (err) {
      console.log('[FAIL] could not delete ' + item.file + ': ' + err.message)
      process.exitCode = 1
    }
  }
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
if (cmd === 'create') cmdCreate(args)
else if (cmd === 'list') cmdList(args)
else if (cmd === 'clean') cmdClean(args)
else fail('usage: desktop-launcher.mjs create --worktree <abs path> | list | clean [--dry-run]')

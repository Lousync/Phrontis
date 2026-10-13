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
 *   node .AGENT/scripts/worktree-launcher/desktop-launcher.mjs create --worktree <abs path> [--name <file.bat>] [--desktop <dir>]
 *   node .AGENT/scripts/worktree-launcher/desktop-launcher.mjs list
 *   node .AGENT/scripts/worktree-launcher/desktop-launcher.mjs clean [--dry-run]
 *
 * Exit codes: 0 = ok, 1 = failure.
 * Output is ASCII-only on purpose (Windows console codepage).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MARKER = 'KB-WORKTREE-LAUNCHER'
const ENTRY_REL = path.join('scripts', 'start-desktop.bat')
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

/** Desktop folder: --desktop, then KB_DESKTOP, then the usual Windows spots. */
function resolveDesktop(args) {
  const explicit = args.desktop || process.env.KB_DESKTOP
  if (explicit) {
    const dir = path.resolve(explicit)
    if (!fs.existsSync(dir)) fail('desktop folder does not exist: ' + dir)
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

/** Default name: Phrontis-dev-<worktree suffix>.bat, always ASCII. */
function defaultName(worktree) {
  const base = path.basename(worktree)
  const suffix = base.replace(/^KnowledgeRecorder-?/, '') || 'main'
  return `Phrontis-dev-${suffix}.bat`
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

function scan(desktop) {
  const found = []
  let entries = []
  try {
    entries = fs.readdirSync(desktop)
  } catch {
    return found
  }
  for (const name of entries) {
    if (!/\.(bat|cmd)$/i.test(name)) continue
    const file = path.join(desktop, name)
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const m = text.match(new RegExp('^rem\\s+' + MARKER + '\\s+worktree=(.+)$', 'm'))
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

  const text = wrapperText(worktree, branchOf(worktree))
  const problems = check(text)
  if (problems.length) fail('generated wrapper violates the rules: ' + problems.join('; '))

  fs.writeFileSync(file, text, { encoding: 'ascii' })

  const written = fs.readFileSync(file, 'utf8')
  const after = check(written)
  if (after.length) fail('written file violates the rules: ' + after.join('; '))
  console.log('[OK]   wrapper : ' + file)
  console.log('[OK]   worktree: ' + worktree)
  console.log('[INFO] rules   : ASCII-only content, CRLF endings, no non-ASCII name')
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

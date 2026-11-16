/**
 * 终端只读通道（P1-2 `builtin.terminal.inspect`）—— 主进程实现。
 *
 * 为什么不全靠 spawn：Phrontis 主战场是 Windows，`ls/cat/head/tail/wc/find/file/which`
 * 在 Windows 上没有对应可执行文件（`find` 还是另一个程序）。这些命令用 Node 原生实现，
 * 跨平台且能直接复用 AI 文件策略 / 作用域；`git` 与 `rg` 才 spawn，且**直呼 argv、不走 shell**。
 *
 * 安全边界（与 terminal.exec 的区别）：
 *  - 只读白名单 + 参数白名单（见 `terminalInspectPure`），没有 shell 解析；
 *  - 所有文件路径必须是仓库内相对路径，再过 `assertCanRead` / `evaluateAiFile`；
 *  - 作用域收窄（scopeAll=false）时只允许原生文件命令，`git` / `rg` 这类整仓命令直接拒绝；
 *  - 无逐条确认，因此不写终端 AI 执行记录（普通工具审计仍然记录）。
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'fs'
import { delimiter, extname, join } from 'path'
import * as iconv from 'iconv-lite'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { getVaultIgnore, isDirIgnored } from 'phrontis-core/kbStore/ignoreFile'
import { resolveSafe, detectBinary } from './workspaceManager'
import { evaluateAiDir, evaluateAiFile, type AiFilePolicy } from './aiFilePolicyPure'
import { getAiFilePolicy } from './aiFilePolicy'
import { assertCanRead, canRead, scopeOf } from './aiAssistantScope'
import { decodeTextFile } from './textFileCodecPure'
import { TEXT_VIEWABLE_EXTS } from '../../src/lib/aiTextExts'
import { globToRegExp } from './vaultFindPure'
import {
  clampInspectTimeout, normalizeInspectRel, truncateInspectOutput, validateInspectCall,
  INSPECT_RAW_CAP, type InspectProgram,
} from './terminalInspectPure'
import type { ToolInvokeCtx } from './aiTools'

export interface AiInspectInput {
  program?: unknown
  args?: unknown
  timeoutMs?: unknown
}

export interface AiInspectOutput {
  ok: true
  program: InspectProgram
  args: string[]
  output: string
  truncated: boolean
  durationMs: number
  cwd: string
  /** 外部进程的退出码；原生命令恒 0 */
  exitCode?: number | null
  note?: string
}

const FIND_LIMIT = 500
const FIND_DEFAULT_DEPTH = 8
const FIND_MAX_DEPTH = 20
const DOC_EXTS = new Set(['pdf', 'pptx'])

function vaultRootOrThrow(): string {
  const cur = getCurrentVault()
  if (!cur?.rootPath) throw new Error('仓库上下文未就绪')
  return cur.rootPath
}

function policy(): AiFilePolicy {
  return getAiFilePolicy()
}

/** 目录是否可能有用户作用域内的内容（收窄作用域时用于 ls / find 的目录裁剪） */
function dirRelevant(rel: string, ctx?: ToolInvokeCtx): boolean {
  const scope = scopeOf(ctx)
  if (!scope) return true
  if (scope.length === 0) return false
  return scope.some((s) => rel === '' || s === rel || s.startsWith(`${rel}/`) || rel.startsWith(`${s}/`))
}

function assertDirAllowed(rel: string): void {
  if (!rel) return // 仓库根
  const d = evaluateAiDir(rel, policy())
  if (!d.allow) throw new Error(d.reason ?? `目录不可访问: ${rel}`)
}

function statKind(abs: string): 'file' | 'dir' | 'none' {
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return 'none'
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'none'
  } catch { return 'none' }
}

interface ResolvedTarget {
  rel: string
  abs: string
  kind: 'file' | 'dir'
}

function resolveTarget(raw: string, ctx: ToolInvokeCtx | undefined, need: 'file' | 'dir' | 'any' = 'any'): ResolvedTarget {
  const rel = normalizeInspectRel(raw)
  if (rel === null) throw new Error(`只接受仓库内相对路径: ${raw}`)
  const root = vaultRootOrThrow()
  const abs = rel ? resolveSafe(root, rel) : root
  if (!abs) throw new Error(`路径非法或越出仓库: ${raw}`)
  const kind = statKind(abs)
  if (kind === 'none') throw new Error(`路径不存在或不可读: ${raw || '.'}`)
  if (need !== 'any' && kind !== need) throw new Error(`${need === 'dir' ? '需要一个目录' : '需要一个文件'}: ${raw}`)
  if (kind === 'dir') {
    assertDirAllowed(rel)
    if (!dirRelevant(rel, ctx)) throw new Error(`目录超出本次任务的作用域: ${rel || '.'}`)
  } else {
    // 文件：作用域 + AI 文件策略（密钥 / 点目录 / 大小 / 二进制 / 扩展名）
    assertCanRead(rel, ctx)
    const st = statSync(abs)
    const dec = evaluateAiFile({ rel, op: 'read', size: st.size }, policy())
    if (!dec.allow) throw new Error(`${dec.reason ?? '该文件不可读'}: ${rel}`)
    if (!DOC_EXTS.has(dec.ext)) {
      try {
        const buf = readFileSync(abs)
        if (detectBinary(buf)) throw new Error(`检测到二进制内容，只读通道只处理文本: ${rel}`)
      } catch (e) {
        if (e instanceof Error && /二进制/.test(e.message)) throw e
      }
    }
  }
  return { rel, abs, kind }
}

function readText(rel: string, abs: string): { text: string; size: number } {
  const st = statSync(abs)
  const buf = readFileSync(abs)
  const dec = decodeTextFile(buf)
  if (!dec.ok) throw new Error(`${dec.error}: ${rel}`)
  return { text: dec.text, size: st.size }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** ls / find 共用的目录读取：隐藏点目录 / 应用内部目录 / 忽略目录 / 策略外文件 */
function visibleEntries(dirAbs: string, dirRel: string, ctx?: ToolInvokeCtx): Array<{ name: string; rel: string; abs: string; type: 'file' | 'dir'; size: number }> {
  const ign = getVaultIgnore().ign
  const pol = policy()
  const out: Array<{ name: string; rel: string; abs: string; type: 'file' | 'dir'; size: number }> = []
  let names: string[] = []
  try { names = readdirSync(dirAbs) } catch { return out }
  for (const name of names) {
    if (out.length >= 2000) break // 超大目录保险丝（find/ls 最终还会按 500 / 8000 字符截）
    if (name.startsWith('.')) continue // 点文件 / 点目录对 AI 关闭
    const rel = dirRel ? `${dirRel}/${name}` : name
    const abs = join(dirAbs, name)
    const kind = statKind(abs)
    if (kind === 'none') continue
    if (kind === 'dir') {
      if (ign && isDirIgnored(ign, rel)) continue
      const d = evaluateAiDir(rel, pol)
      if (!d.allow) continue
      if (!dirRelevant(rel, ctx)) continue
      out.push({ name, rel, abs, type: 'dir', size: 0 })
    } else {
      if (ign && ign.ignores(rel)) continue
      if (!canRead(rel, ctx)) continue
      let size = 0
      try { size = statSync(abs).size } catch { continue }
      const d = evaluateAiFile({ rel, op: 'read', size }, pol)
      if (!d.allow && !DOC_EXTS.has(d.ext)) continue
      out.push({ name, rel, abs, type: 'file', size })
    }
  }
  out.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

// ---- Node 原生命令 ----

function cmdLs(args: string[], ctx?: ToolInvokeCtx): string {
  let long = false
  const paths: string[] = []
  for (const a of args) {
    if (a === '-l' || a === '--long') { long = true; continue }
    if (a === '-a' || a === '--all') continue // 点目录仍受策略限制，这里只是兼容常用参数
    if (a.startsWith('-')) throw new Error(`ls 不支持参数: ${a}`)
    paths.push(a)
  }
  const targets = paths.length > 0 ? paths : ['.']
  const lines: string[] = []
  for (const p of targets) {
    const t = resolveTarget(p, ctx, 'any')
    if (t.kind === 'file') {
      let size = 0
      try { size = statSync(t.abs).size } catch { /* ignore */ }
      lines.push(long ? `- ${String(size).padStart(9)} ${t.rel}` : t.rel)
      continue
    }
    if (targets.length > 1) lines.push(`${t.rel || '.'}:`)
    for (const e of visibleEntries(t.abs, t.rel, ctx)) {
      lines.push(long
        ? `${e.type === 'dir' ? 'd' : '-'} ${String(e.size).padStart(9)} ${e.name}${e.type === 'dir' ? '/' : ''}`
        : `${e.name}${e.type === 'dir' ? '/' : ''}`)
    }
  }
  return lines.join('\n')
}

function cmdCat(args: string[], ctx?: ToolInvokeCtx): string {
  const paths = args.filter((a) => a !== '--')
  for (const a of paths) if (a.startsWith('-')) throw new Error(`cat 不支持参数: ${a}`)
  if (paths.length === 0) throw new Error('cat 需要至少一个文件路径')
  if (paths.length > 20) throw new Error('cat 一次最多 20 个文件')
  const parts: string[] = []
  let chars = 0
  for (const p of paths) {
    const t = resolveTarget(p, ctx, 'file')
    const { text } = readText(t.rel, t.abs)
    parts.push(paths.length > 1 ? `==> ${t.rel} <==\n${text}` : text)
    chars += text.length
    if (chars > 200_000) break // 进程级保险丝：最终还会截到 8000 给模型
  }
  return parts.join(paths.length > 1 ? '\n\n' : '')
}

function parseLineCount(args: string[]): { n: number; path: string } {
  let n = 10
  let path = ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-n' || a === '--lines') {
      const v = Number(args[++i])
      if (!Number.isFinite(v) || v <= 0) throw new Error('行数必须是正整数')
      n = Math.floor(v)
      continue
    }
    if (/^-\d+$/.test(a)) { n = Math.floor(Number(a.slice(1))); continue }
    if (a.startsWith('-')) throw new Error(`不支持参数: ${a}`)
    if (path) throw new Error('head / tail 一次只接受一个文件')
    path = a
  }
  if (!path) throw new Error('缺少文件路径')
  return { n: Math.min(n, 10_000), path }
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

function cmdHead(args: string[], ctx?: ToolInvokeCtx): string {
  const { n, path } = parseLineCount(args)
  const t = resolveTarget(path, ctx, 'file')
  const { text } = readText(t.rel, t.abs)
  const lines = splitLines(text)
  return lines.slice(0, n).join('\n')
}

function cmdTail(args: string[], ctx?: ToolInvokeCtx): string {
  const { n, path } = parseLineCount(args)
  const t = resolveTarget(path, ctx, 'file')
  const { text } = readText(t.rel, t.abs)
  const lines = splitLines(text)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

function cmdWc(args: string[], ctx?: ToolInvokeCtx): string {
  const flags = new Set<string>()
  const paths: string[] = []
  for (const a of args) {
    if (a === '-l' || a === '-w' || a === '-c' || a === '-m') { flags.add(a); continue }
    if (a.startsWith('-')) throw new Error(`wc 不支持参数: ${a}`)
    paths.push(a)
  }
  if (paths.length === 0) throw new Error('wc 需要至少一个文件路径')
  if (paths.length > 20) throw new Error('wc 一次最多 20 个文件')
  const all = flags.size === 0 ? ['-l', '-w', '-c'] : [...flags]
  const lines: string[] = []
  for (const p of paths) {
    const t = resolveTarget(p, ctx, 'file')
    const { text, size } = readText(t.rel, t.abs)
    const l = text === '' ? 0 : splitLines(text).length - (text.endsWith('\n') ? 1 : 0)
    const w = text.trim() ? text.trim().split(/\s+/).length : 0
    const parts: string[] = []
    if (all.includes('-l')) parts.push(String(l))
    if (all.includes('-w')) parts.push(String(w))
    if (all.includes('-c')) parts.push(String(size))
    if (all.includes('-m')) parts.push(String(text.length))
    lines.push(`${parts.join(' ')} ${t.rel}`)
  }
  return lines.join('\n')
}

function findExecutable(name: string): string | null {
  if (!name || /[\\/]/.test(name)) return null
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const lowerName = name.toLowerCase()
      const lowerExt = ext.toLowerCase()
      const abs = join(dir, lowerName.endsWith(lowerExt) ? name : `${name}${ext}`)
      try {
        if (existsSync(abs) && statSync(abs).isFile()) {
          if (process.platform !== 'win32') {
            try { if (!(statSync(abs).mode & 0o111)) continue } catch { continue }
          }
          return abs
        }
      } catch { /* skip */ }
    }
  }
  return null
}

function cmdWhich(args: string[]): string {
  return args.map((name) => `${name}: ${findExecutable(name) ?? 'not found'}`).join('\n')
}

function cmdFile(args: string[], ctx?: ToolInvokeCtx): string {
  if (args.length > 50) throw new Error('file 一次最多 50 个路径')
  const out: string[] = []
  for (const p of args) {
    const t = resolveTarget(p, ctx, 'any')
    if (t.kind === 'dir') { out.push(`${t.rel || '.'}: directory`); continue }
    const st = statSync(t.abs)
    const ext = extname(t.abs).replace(/^\./, '').toLowerCase()
    let label = ext ? `${ext.toUpperCase()} file` : 'file'
    if (DOC_EXTS.has(ext)) label = ext === 'pdf' ? 'PDF document' : 'PPTX document'
    else {
      try {
        const buf = readFileSync(t.abs)
        label = detectBinary(buf) ? 'binary data' : 'text'
      } catch { /* 读不到就只报类型 */ }
    }
    out.push(`${t.rel}: ${label} (${fmtBytes(st.size)})`)
  }
  return out.join('\n')
}

interface FindOpts { path: string; pattern: string; insensitive: boolean; type: 'f' | 'd' | ''; maxDepth: number }

function parseFind(args: string[]): FindOpts {
  const opts: FindOpts = { path: '.', pattern: '', insensitive: false, type: '', maxDepth: FIND_DEFAULT_DEPTH }
  let i = 0
  if (args[0] && !args[0].startsWith('-')) opts.path = args[i++]
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-name' || a === '-iname') {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} 缺少模式`)
      if (v.includes('/')) throw new Error('-name 只匹配文件名（不含 /）；按路径查找请用 vault.find')
      opts.pattern = v
      opts.insensitive = a === '-iname'
      continue
    }
    if (a === '-type') {
      const v = args[++i]
      if (v !== 'f' && v !== 'd') throw new Error("-type 只支持 f 或 d")
      opts.type = v
      continue
    }
    if (a === '-maxdepth') {
      const v = Number(args[++i])
      if (!Number.isFinite(v) || v < 0) throw new Error('-maxdepth 必须是非负整数')
      opts.maxDepth = Math.min(Math.floor(v), FIND_MAX_DEPTH)
      continue
    }
    throw new Error(`find 只支持 -name / -iname / -type / -maxdepth（当前：${a}）`)
  }
  return opts
}

function cmdFind(args: string[], ctx?: ToolInvokeCtx): string {
  const opts = parseFind(args)
  const base = resolveTarget(opts.path, ctx, 'dir')
  const re = opts.pattern ? globToRegExp(opts.pattern) : null
  const out: string[] = []
  let truncated = false
  // -name 是 basename 语义（与 find 一致）：模式里的目录段会自然匹配不到
  const matchName = (name: string): boolean => !re || re.test(name)
  const walk = (dirAbs: string, dirRel: string, depth: number): void => {
    if (out.length >= FIND_LIMIT) { truncated = true; return }
    const entries = visibleEntries(dirAbs, dirRel, ctx)
    for (const e of entries) {
      if (out.length >= FIND_LIMIT) { truncated = true; return }
      const nameMatch = matchName(e.name)
      const typeMatch = !opts.type || (opts.type === 'd' ? e.type === 'dir' : e.type === 'file')
      if (nameMatch && typeMatch) out.push(e.type === 'dir' ? `${e.rel}/` : e.rel)
      if (e.type === 'dir' && depth < opts.maxDepth) walk(e.abs, e.rel, depth + 1)
    }
  }
  walk(base.abs, base.rel, 0)
  if (truncated) out.push(`…（结果超过 ${FIND_LIMIT} 条，已截断；请缩小路径或加深模式）`)
  return out.join('\n')
}

// ---- 外部进程（git / rg）----

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // ripgrep 会读 RIPGREP_CONFIG_PATH；空值防止外部配置注入 --pre 等执行型参数
    RIPGREP_CONFIG_PATH: '',
  }
}

function decodeOutput(chunks: Buffer[]): string {
  const buf = Buffer.concat(chunks)
  const text = buf.toString('utf8')
  if (process.platform === 'win32' && text.includes('\uFFFD')) {
    const gbk = iconv.decode(buf, 'gbk')
    if (!gbk.includes('\uFFFD')) return gbk
  }
  return text
}

function killChild(child: ChildProcess): void {
  try { child.kill('SIGKILL') } catch { /* 已退出 */ }
}

function runProcess(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; text: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { cwd, windowsHide: true, env: childEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      reject(new Error(`进程启动失败：${(e as Error).message}`))
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let timedOut = false
    const collect = (d: Buffer | string): void => {
      const buf = typeof d === 'string' ? Buffer.from(d, 'utf8') : d
      chunks.push(buf)
      total += buf.length
      if (total > INSPECT_RAW_CAP) { timedOut = false; killChild(child) }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => { timedOut = true; killChild(child) }, timeoutMs)
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, text: decodeOutput(chunks), timedOut })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`无法执行 ${file}：${e.message}`))
    })
  })
}

async function cmdGit(args: string[], cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number | null; note?: string }> {
  const sub = args[0]
  const rest = args.slice(1)
  const noTextconv = sub === 'diff' || sub === 'log' || sub === 'show'
  const argv = ['--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', sub, ...(noTextconv ? ['--no-textconv'] : []), ...rest]
  const r = await runProcess('git', argv, cwd, timeoutMs)
  return {
    output: r.text,
    exitCode: r.code,
    ...(r.timedOut ? { note: `命令超过 ${timeoutMs}ms，已终止` } : {}),
  }
}

async function cmdRg(args: string[], cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number | null; note?: string }> {
  const exe = findExecutable('rg')
  if (!exe) throw new Error('未找到 rg（ripgrep）。请改用 vault.search 做内容检索，或安装 rg 后重试')
  if (/\.(cmd|bat)$/i.test(exe)) throw new Error('找到的 rg 是 .cmd/.bat 包装脚本，无法在不经过 shell 的情况下执行；请安装原生 rg.exe 或改用 vault.search')
  // 只让 rg 搜索 AI 可读的文本扩展名；用户的 -g / -t 已在纯校验里拒绝
  const globs: string[] = []
  for (const ext of TEXT_VIEWABLE_EXTS) globs.push('-g', `*.${ext}`)
  const argv = ['--color', 'never', ...args, ...globs]
  const r = await runProcess(exe, argv, cwd, timeoutMs)
  return {
    output: r.text,
    exitCode: r.code,
    ...(r.timedOut ? { note: `命令超过 ${timeoutMs}ms，已终止` } : {}),
  }
}

// ---- 入口 ----

export async function aiInspect(input: AiInspectInput, ctx?: ToolInvokeCtx): Promise<AiInspectOutput> {
  const call = validateInspectCall(input?.program, input?.args)
  if (!call.ok) throw new Error(call.error)
  const root = vaultRootOrThrow()
  const timeoutMs = clampInspectTimeout(input?.timeoutMs)
  const started = Date.now()
  const scope = scopeOf(ctx)
  if (!call.native && scope) {
    throw new Error('本次任务的文件作用域已收窄，不能运行 git / rg 这类整仓命令；请用 ls / find / cat 或 vault.search 定向查看')
  }

  let raw = ''
  let exitCode: number | null | undefined
  let note: string | undefined
  switch (call.program) {
    case 'git': {
      const r = await cmdGit(call.args, root, timeoutMs)
      raw = r.output
      exitCode = r.exitCode
      note = r.note
      break
    }
    case 'rg': {
      const r = await cmdRg(call.args, root, timeoutMs)
      raw = r.output
      exitCode = r.exitCode
      note = r.note
      break
    }
    case 'ls': raw = cmdLs(call.args, ctx); break
    case 'cat': raw = cmdCat(call.args, ctx); break
    case 'head': raw = cmdHead(call.args, ctx); break
    case 'tail': raw = cmdTail(call.args, ctx); break
    case 'wc': raw = cmdWc(call.args, ctx); break
    case 'find': raw = cmdFind(call.args, ctx); break
    case 'file': raw = cmdFile(call.args, ctx); break
    case 'which': raw = cmdWhich(call.args); break
    case 'pwd': raw = root; break
    default: throw new Error(`未实现的只读命令: ${call.program}`)
  }
  const capped = truncateInspectOutput(raw)
  return {
    ok: true,
    program: call.program,
    args: call.args,
    output: capped.text,
    truncated: capped.truncated,
    durationMs: Date.now() - started,
    cwd: root,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(note ? { note } : {}),
  }
}

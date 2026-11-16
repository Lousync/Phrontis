/**
 * 终端只读通道（P1-2 `builtin.terminal.inspect`）**纯逻辑**。
 *
 * 设计（2026-11-16）：
 *  - **不走 shell**：工具入参是 `program + args[]`，由主进程直接 spawn（git / rg）或用 Node
 *    原生实现（ls / cat / head / tail / wc / find / file / which / pwd），没有管道、重定向、
 *    通配符展开，也没有命令拼接；
 *  - **白名单**：只允许只读命令与只读参数；写文件、执行任意程序的选项一律拒绝；
 *  - **无需逐条确认**：只读通道不弹终端确认（模块权限 / 文件域 / 作用域仍在）；
 *  - 文件路径必须是仓库内相对路径，且后续由 `aiAssistantScope` / `aiFilePolicy` 再判一次。
 *
 * 零依赖独立文件：契约脚本 `verify-terminal-inspect.mjs` 直接 import。
 */

export const INSPECT_PROGRAMS = [
  'git', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'find', 'file', 'which', 'pwd',
] as const

export type InspectProgram = (typeof INSPECT_PROGRAMS)[number]

/** Node 原生实现（跨平台，不依赖外部命令） */
export const NATIVE_INSPECT_PROGRAMS: readonly InspectProgram[] = [
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'file', 'which', 'pwd',
]

export const DEFAULT_INSPECT_TIMEOUT_MS = 15_000
export const MAX_INSPECT_TIMEOUT_MS = 60_000
/** 给模型看的输出上限（与 terminal.exec 的 8000 同口径） */
export const INSPECT_OUTPUT_CAP = 8_000
/** 输出失控保险丝（进程还在写就杀） */
export const INSPECT_RAW_CAP = 400_000
const MAX_ARGS = 60
const MAX_ARG_CHARS = 2_000

const GIT_SUBCOMMANDS = ['status', 'diff', 'log', 'show'] as const
const GIT_BLOCKED_OPTS = [
  '--output', '-O', '--ext-diff', '--textconv', '--no-index', '--exec-path',
  '--upload-pack', '--receive-pack', '--open-files-in-pager', '--git-dir', '--work-tree',
]
const RG_ALLOWED_FLAGS = new Set([
  '-i', '--ignore-case', '-n', '--line-number', '-l', '--files-with-matches',
  '-c', '--count', '-F', '--fixed-strings', '-w', '--word-regexp',
  '-S', '--smart-case', '-v', '--invert-match', '--files',
])
const FIND_BLOCKED_PREFIXES = [
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls',
]

export interface InspectCallOk {
  ok: true
  program: InspectProgram
  args: string[]
  /** true = Node 原生实现；false = 外部进程（git / rg） */
  native: boolean
}

export interface InspectCallErr {
  ok: false
  error: string
}

export type InspectCall = InspectCallOk | InspectCallErr

/** 仓库相对路径归一：'' = 仓库根；null = 非法（绝对路径 / ..） */
export function normalizeInspectRel(raw: unknown): string | null {
  let s = String(raw ?? '').trim().replace(/\\/g, '/')
  if (s === '' || s === '.') return ''
  while (s.startsWith('./')) s = s.slice(2)
  if (!s || s === '.') return ''
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  if (s.split('/').some((seg) => seg === '..')) return null
  return s.replace(/\/+$/, '')
}

function isAbsoluteLike(arg: string): boolean {
  return arg.startsWith('/') || /^[A-Za-z]:/.test(arg)
}

export function isBlockedGitOption(arg: string): boolean {
  return GIT_BLOCKED_OPTS.some((opt) => arg === opt || arg.startsWith(`${opt}=`))
}

function validateGit(args: string[]): string | null {
  const sub = args[0]
  if (!sub) return 'git 缺少子命令（只支持 status / diff / log / show）'
  if (!(GIT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return `git 子命令只读白名单：${GIT_SUBCOMMANDS.join(' / ')}（当前：${sub}）`
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (isBlockedGitOption(arg)) return `git 参数被拒绝（可能写出文件或执行外部程序）：${arg}`
    if (isAbsoluteLike(arg)) return `git 参数不能是绝对路径：${arg}`
  }
  // `--` 之后是路径：必须是仓库相对路径
  const dd = args.indexOf('--')
  if (dd >= 0) {
    for (const p of args.slice(dd + 1)) {
      if (normalizeInspectRel(p) === null) return `git 路径必须是仓库内相对路径：${p}`
    }
  }
  return null
}

function validateRg(args: string[]): string | null {
  let patternSeen = false
  const filesMode = args.includes('--files')
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return 'rg 不支持 --（路径请直接写成仓库相对路径）'
    if (arg.startsWith('-')) {
      if (!RG_ALLOWED_FLAGS.has(arg)) return `rg 参数不在只读白名单内：${arg}`
      continue
    }
    // 第一个非选项参数 = 搜索模式（--files 模式下全部是路径）
    if (!filesMode && !patternSeen) { patternSeen = true; continue }
    if (normalizeInspectRel(arg) === null) return `rg 路径必须是仓库内相对路径：${arg}`
  }
  if (!filesMode && !patternSeen) return 'rg 缺少搜索模式'
  return null
}

function validateFind(args: string[]): string | null {
  for (const arg of args) {
    if (isAbsoluteLike(arg)) return `find 参数不能是绝对路径：${arg}`
    if (FIND_BLOCKED_PREFIXES.some((p) => arg === p || arg.startsWith(`${p}=`))) {
      return `find 参数被拒绝（可能执行程序或写文件）：${arg}`
    }
  }
  return null
}

/** 文件操作类命令的路径实参校验由 fs 层做；这里只挡明显的绝对路径 / `..` */
function hasUnsafePathArg(args: string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    if (normalizeInspectRel(arg) === null) return `路径必须是仓库内相对路径：${arg}`
  }
  return null
}

export function validateInspectCall(programRaw: unknown, argsRaw: unknown): InspectCall {
  const program = String(programRaw ?? '').trim().toLowerCase()
  if (!program) return { ok: false, error: '缺少必填参数: program' }
  if (!(INSPECT_PROGRAMS as readonly string[]).includes(program)) {
    return { ok: false, error: `只读命令白名单：${INSPECT_PROGRAMS.join(' / ')}（当前：${program}）` }
  }
  const args = argsRaw === undefined || argsRaw === null ? [] : argsRaw
  if (!Array.isArray(args)) return { ok: false, error: 'args 必须是字符串数组' }
  if (args.length > MAX_ARGS) return { ok: false, error: `参数过多（>${MAX_ARGS} 个）` }
  const out: string[] = []
  for (const item of args) {
    if (typeof item !== 'string') return { ok: false, error: 'args 必须是字符串数组' }
    if (item.length > MAX_ARG_CHARS) return { ok: false, error: `单个参数过长（>${MAX_ARG_CHARS} 字符）` }
    if (/[\u0000\r\n]/.test(item)) return { ok: false, error: '参数不能包含 NUL / 换行（不支持多行命令）' }
    out.push(item)
  }

  let err: string | null = null
  if (program === 'git') err = validateGit(out)
  else if (program === 'rg') err = validateRg(out)
  else if (program === 'find') err = validateFind(out)
  else if (program === 'pwd' && out.length > 0) err = 'pwd 不接受参数'
  else if (program === 'which' && out.length === 0) err = 'which 需要至少一个程序名'
  else if (program === 'file' && out.length === 0) err = 'file 需要至少一个文件路径'
  else if (program === 'cat' && out.length === 0) err = 'cat 需要至少一个文件路径'
  else if (program === 'cat' || program === 'file' || program === 'head' || program === 'tail' || program === 'wc' || program === 'ls') {
    err = hasUnsafePathArg(out)
    if (!err && program === 'tail' && out.some((a) => a === '-f' || a === '--follow')) {
      err = 'tail -f 不支持（只读通道不跟踪实时输出）'
    }
  }
  if (err) return { ok: false, error: err }
  return {
    ok: true,
    program: program as InspectProgram,
    args: out,
    native: NATIVE_INSPECT_PROGRAMS.includes(program as InspectProgram),
  }
}

export function clampInspectTimeout(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_INSPECT_TIMEOUT_MS
  return Math.max(1_000, Math.min(MAX_INSPECT_TIMEOUT_MS, Math.floor(n)))
}

export function truncateInspectOutput(text: string, cap = INSPECT_OUTPUT_CAP): { text: string; truncated: boolean } {
  const s = String(text ?? '')
  if (s.length <= cap) return { text: s, truncated: false }
  return { text: `${s.slice(0, cap)}\n…（输出已截断，共 ${s.length} 字符）`, truncated: true }
}

/** find 的 `-name` 模式 → 正则（basename 语义；交给 vaultFindPure 的同一套 glob 规则） */
export function isFindFlag(arg: string): boolean {
  return arg === '-name' || arg === '-iname' || arg === '-type' || arg === '-maxdepth'
}

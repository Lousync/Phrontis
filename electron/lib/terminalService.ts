/**
 * 终端模块主进程服务（docs/terminal-module-design.md）。
 *
 * 职责：pty 会话表（真源）· 三平台 shell 解析 · AI 执行命令的门控与落执行。
 * 与 IPC 解耦：本文件不含 ipcMain；注册层在 electron/database/repositories/terminalRepo.ts。
 *
 * 安全模型：
 *  - 渲染层零进程能力，只有 term:* 通道；pty 只由主进程持有（不变量 3）；
 *  - 会话 cwd 固定为当前仓库根（无仓库回落用户主目录），**不由渲染层指定**；
 *  - AI 执行（aiExec）四道门：设置开关（agentService 视野过滤）→ 模块权限（aiModulePermissions）
 *    → 支线会话硬拦（agentService 既有）→ 每条命令行内确认（本文件 pendingConfirms）。
 *    高危启发式 isRiskyCommand 只是「把确认升级为严重警告弹窗」，不是沙箱 —— 真边界是用户确认；
 *  - 会话与应用同生命周期：应用退出 = 全部回收（Windows ConPTY / posix SIGHUP 由 OS 兜底）。
 */
import { spawn as cpSpawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir, release as osRelease } from 'os'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import * as nodePty from '@lydell/node-pty'
import * as iconv from 'iconv-lite'
import { getCurrentVault } from './kbStore/vaultContext'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'

// ===== shell 解析（三平台） =====

export interface TerminalShellInfo { file: string; args: string[]; label: string }

/**
 * Windows PowerShell 5.1 交互会话的启动参数：卸掉 PSReadLine，行编辑退回控制台**原生 cooked 模式**。
 * 依据：2026-10-04 用户拍板「终端输入按原生终端那样，不要 PSReadLine 那套」——PSReadLine 2.0
 * 在 ConPTY 上的 CJK 宽字符重画 bug（PSReadLine#779）是输入区垃圾字符的机制源（探针
 * .AGENT/scripts/terminal/probe-pty-echo.mjs 证实：稳定尺寸下 cooked 模式流干净且更省）。
 * pwsh 7 不受影响：自带新版 PSReadLine，保留完整行编辑体验。
 */
const PS51_INTERACTIVE_ARGS = ['-NoExit', '-Command', 'Remove-Module PSReadLine -ErrorAction SilentlyContinue']

let pwshPath: string | null | undefined/**
 * 探测 pwsh 7：先 `where`（PATH），未命中再查标准安装目录（MSI 装的 7.x 不一定进 PATH）。
 * 返回可执行文件路径（PATH 命中时为裸名，目录命中时为全路径）或 null。
 * 5.1 是 ConPTY 渲染重灾区（自带 PSReadLine 2.0 的 CJK 宽字符 bug），能上 7 就上 7。
 */
function findPwsh(): string | null {
  if (pwshPath !== undefined) return pwshPath
  try {
    if (spawnSync('where', ['pwsh'], { timeout: 3000 }).status === 0) {
      pwshPath = 'pwsh.exe'
      return pwshPath
    }
  } catch { /* PATH 探测失败，继续查目录 */ }
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const localAppData = process.env['LocalAppData'] ?? ''
  const candidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
    ...(localAppData ? [join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
  ]
  pwshPath = candidates.find(p => existsSync(p)) ?? null
  return pwshPath
}

/**
 * 解析 shell。`forExec=false` 为交互会话（pty），`true` 为 AI 一次性执行（非交互参数）。
 * pref 来自设置 `terminal.shell`（auto/pwsh/powershell/cmd/zsh/bash/fish），auto/未知值按平台默认。
 * label 只给**占位短名**（不含版本号）—— 版本由 displayShellLabel 异步实测补全（用户 2026-10-05：
 * 版本要按系统变化，不能写死），会话签页用短名保持紧凑。
 */
export function resolveShell(prefRaw?: string, forExec = false): TerminalShellInfo {
  const pref = (prefRaw ?? '').trim()
  if (process.platform === 'win32') {
    const execArgs = ['-NoProfile', '-NonInteractive', '-Command']
    if (pref === 'cmd') return { file: 'cmd.exe', args: forExec ? ['/d', '/s', '/c'] : [], label: 'cmd' }
    if (pref === 'powershell') return { file: 'powershell.exe', args: forExec ? execArgs : PS51_INTERACTIVE_ARGS, label: 'PowerShell' }
    if (pref === 'pwsh') return { file: findPwsh() ?? 'pwsh.exe', args: forExec ? execArgs : [], label: 'pwsh' }
    // auto：pwsh 7 探测 → PowerShell 5.1 兜底（Windows 系统必有）
    const pwsh = findPwsh()
    if (pwsh) return { file: pwsh, args: forExec ? execArgs : [], label: 'pwsh' }
    return { file: 'powershell.exe', args: forExec ? execArgs : PS51_INTERACTIVE_ARGS, label: 'PowerShell' }
  }
  const known = pref === 'zsh' || pref === 'bash' || pref === 'fish' ? pref : ''
  const file = known || process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: forExec ? ['-c'] : ['-l'], label: basename(file) || file }
}

// ===== shell 展示名（实测版本，仅展示层消费） =====

/** 按可执行文件缓存的标签 Promise（in-flight 去重：term:defaultShell 与后续查询并发只探一次） */
const labelCache = new Map<string, Promise<string>>()

function firstSemver(text: string): string | null {
  const m = text.match(/\d+(?:\.\d+)+/)
  return m ? m[0] : null
}

/** 一次性探测（非 pty、stdin 关死防挂起）：取 stdout 首个非空行；超时/失败返回空串，永不 reject */
function probeLine(file: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = cpSpawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    } catch { resolve(''); return }
    const chunks: Buffer[] = []
    let done = false
    child.stdout?.on('data', d => chunks.push(d as Buffer))
    const finish = () => {
      if (done) return
      done = true
      try { child.kill() } catch { /* 已退出 */ }
      resolve(decodeOutput(chunks).split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '')
    }
    child.on('close', finish)
    child.on('error', () => { done = true; resolve('') })
    setTimeout(finish, timeoutMs)
  })
}

/**
 * 展示标签 = 占位名 + 实测版本。pwsh `--version` 自报 "PowerShell 7.x.y" 直接采用；
 * 5.1 问 $PSVersionTable 得 "5.1.x.y.z" 拼在 PowerShell 后；posix 取 `--version` 首行里的首个版本号。
 * 探测失败回落占位名 —— 宁可少显示，不编造版本。
 */
export function displayShellLabel(file: string, fallback: string): Promise<string> {
  const key = `${process.platform}|${file.toLowerCase()}`
  let p = labelCache.get(key)
  if (!p) {
    p = (async () => {
      let out = ''
      if (process.platform === 'win32') {
        if (/powershell\.exe$/i.test(file)) {
          out = await probeLine(/[/\\]/.test(file) ? file : 'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
        } else if (/pwsh(\.exe)?$/i.test(file)) {
          out = await probeLine(file, ['--version'])
        }
      } else {
        out = await probeLine(file, ['--version'])
      }
      if (!out) return fallback
      if (/^PowerShell\s/i.test(out)) return out
      const v = firstSemver(out)
      return v ? `${fallback} ${v}` : fallback
    })()
    labelCache.set(key, p)
  }
  return p
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (!env.TERM) env.TERM = 'xterm-256color'
  return env
}

function vaultCwd(): string {
  return getCurrentVault()?.rootPath || homedir()
}

/** Windows 构建号（如 26200）：渲染层据此设 xterm 的 windowsPty 选项（ConPTY 兼容缓冲行实现，VS Code 同款） */
export function windowsBuildNumber(): number | undefined {
  if (process.platform !== 'win32') return undefined
  const build = Number(osRelease().split('.')[2])
  return Number.isFinite(build) && build > 0 ? build : undefined
}

// ===== 交互会话（pty） =====

export interface TerminalSessionInfo {
  id: string
  shell: string
  cwd: string
  pid: number
  /** 创建时的列/行数（渲染层据此免掉同尺寸的启动期 resize） */
  cols: number
  rows: number
  exited: boolean
  exitCode: number | null
}
export interface TerminalCreateResult extends TerminalSessionInfo { backlog: string }

interface Session { info: TerminalSessionInfo; pty: nodePty.IPty; backlog: string[]; backlogChars: number }

const sessions = new Map<string, Session>()
/** 与渲染层原型的上限一致（铁律：行为与已确认的原型对齐） */
const MAX_SESSIONS = 4
/** attach 回放缓冲上限（字符）——环形丢弃最旧块 */
const BACKLOG_MAX_CHARS = 200_000

function pushBacklog(s: Session, chunk: string): void {
  s.backlog.push(chunk)
  s.backlogChars += chunk.length
  while (s.backlogChars > BACKLOG_MAX_CHARS && s.backlog.length > 1) {
    s.backlogChars -= s.backlog.shift()!.length
  }
}

export function createSession(opts: { cols?: number; rows?: number; shellPref?: string }): TerminalCreateResult {
  const alive = [...sessions.values()].filter(s => !s.info.exited).length
  if (alive >= MAX_SESSIONS) throw new Error(`最多同时 ${MAX_SESSIONS} 个终端会话，请先结束一个`)
  const shell = resolveShell(opts.shellPref)
  const cwd = vaultCwd()
  const cols = clampInt(opts.cols, 80, 2, 500)
  const rows = clampInt(opts.rows, 24, 2, 200)
  const pty = nodePty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv(),
  })
  const info: TerminalSessionInfo = { id: randomUUID(), shell: shell.label, cwd, pid: pty.pid, cols, rows, exited: false, exitCode: null }
  const s: Session = { info, pty, backlog: [], backlogChars: 0 }
  sessions.set(info.id, s)
  pty.onData(chunk => {
    pushBacklog(s, chunk)
    broadcast(BROADCAST_CHANNEL.termData, { id: info.id, data: chunk })
  })
  pty.onExit(({ exitCode }) => {
    s.info.exited = true
    s.info.exitCode = exitCode
    broadcast(BROADCAST_CHANNEL.termExit, { id: info.id, exitCode })
  })
  return { ...info, backlog: '' }
}

/** 重挂回放：渲染层 Tab 重开 / 切换后按 id 取 backlog */
export function attach(id: string): { backlog: string } | null {
  const s = sessions.get(id)
  if (!s) return null
  return { backlog: s.backlog.join('') }
}

export function write(id: string, data: string): void {
  if (typeof data !== 'string' || data.length > 100_000) return
  sessions.get(id)?.pty.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  try { sessions.get(id)?.pty.resize(clampInt(cols, 80, 2, 500), clampInt(rows, 24, 2, 200)) } catch { /* 会话已退出等，静默 */ }
}

export function kill(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try { s.pty.kill() } catch { /* 已退出 */ }
  if (!s.info.exited) {
    s.info.exited = true
    broadcast(BROADCAST_CHANNEL.termExit, { id, exitCode: null })
  }
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].map(s => ({ ...s.info }))
}

// ===== AI 执行命令（builtin.terminal.exec 的实现） =====

export type TerminalAiStatus = 'pending' | 'running' | 'ok' | 'denied' | 'timeout' | 'error'

export interface TerminalAiRecord {
  reqId: string
  cmd: string
  cwd: string
  risky: boolean
  status: TerminalAiStatus
  exitCode: number | null
  durationMs: number | null
  outputPreview: string
  time: string
}

const aiRecords: TerminalAiRecord[] = []
const AI_RECORDS_MAX = 50
const AI_CONFIRM_TIMEOUT_MS = 90_000
/** 给模型的自截上限（框架 MAX_TOOL_RESULT_CHARS=24000 之前先自守，铁律 17「拿得少」） */
const AI_OUTPUT_CAP = 8_000
/** UI 记录里留存的输出预览上限 */
const AI_PREVIEW_CAP = 2_000

const pendingConfirms = new Map<string, (approved: boolean) => void>()

export function aiRespond(reqId: string, approved: boolean): void {
  const resolve = pendingConfirms.get(reqId)
  if (resolve) {
    pendingConfirms.delete(reqId)
    resolve(approved)
  }
}

export function listAiRecords(): TerminalAiRecord[] {
  return aiRecords.map(r => ({ ...r }))
}

/** 高危启发式：命中 → 渲染层把行内确认升级为严重警告弹窗（铁律 25 允许的唯一弹窗形态） */
const RISKY_RE = new RegExp([
  'rd\\s', 'rmdir', '\\bdel\\b', 'erase', 'remove-item', '\\brm\\b', '\\bformat\\b', 'mkfs', '\\bdd\\b',
  'diskpart', 'shutdown', 'restart-computer', 'stop-process', 'taskkill', 'reg(\\.exe)?\\s+delete',
  'clear-content', 'git\\s+push\\b.*--force', 'git\\s+reset\\s+--hard', 'git\\s+clean\\b.*f',
].join('|'), 'i')

export function isRiskyCommand(cmd: string): boolean {
  return RISKY_RE.test(cmd)
}

function upsertRecord(rec: TerminalAiRecord): void {
  const i = aiRecords.findIndex(r => r.reqId === rec.reqId)
  if (i >= 0) aiRecords[i] = rec
  else aiRecords.unshift(rec)
  if (aiRecords.length > AI_RECORDS_MAX) aiRecords.pop()
  broadcast(BROADCAST_CHANNEL.termAiRecord, { record: { ...rec } })
}

export interface AiExecInput { command: string; timeoutMs?: number; shellPref?: string }
export interface AiExecOutput {
  approved: boolean
  exitCode: number | null
  durationMs: number | null
  output: string
  truncated: boolean
  shell: string
  cwd: string
  message?: string
}

function totalLen(chunks: Buffer[]): number {
  let n = 0
  for (const c of chunks) n += c.length
  return n
}

function killChild(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // shell 会再派生子进程，taskkill /T 连树一起杀
    try { cpSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* 兜底 kill */ }
  }
  try { child.kill('SIGKILL') } catch { /* 已退出 */ }
}

/** UTF-8 解码；Windows 下出现替换符时按 GBK 回落重解（PowerShell 5.1 默认代码页 GBK） */
function decodeOutput(chunks: Buffer[]): string {
  const buf = Buffer.concat(chunks)
  const text = buf.toString('utf8')
  if (process.platform === 'win32' && text.includes('\uFFFD')) {
    const gbk = iconv.decode(buf, 'gbk')
    if (!gbk.includes('\uFFFD')) return gbk
  }
  return text
}

/**
 * AI 一次性执行：广播确认请求 → 等行内确认（90s 超时 = 拒绝）→ 非 TTY 落执行 → 输出自截返回。
 * 抛错只用于「根本没到确认那一步」（参数非法/开关未开）；确认后被拒/超时返回 approved:false。
 */
export async function aiExec(input: AiExecInput): Promise<AiExecOutput> {
  const cmd = input.command.trim()
  if (!cmd) throw new Error('命令为空')
  if (cmd.length > 4000) throw new Error('命令过长（>4000 字符），拒绝执行')
  const timeoutMs = clampInt(input.timeoutMs, 30_000, 1_000, 300_000)
  const cwd = vaultCwd()
  const reqId = randomUUID()
  const rec: TerminalAiRecord = {
    reqId, cmd, cwd, risky: isRiskyCommand(cmd), status: 'pending',
    exitCode: null, durationMs: null, outputPreview: '', time: hhmm(),
  }
  upsertRecord(rec)

  let timedOut = false
  const approved = await new Promise<boolean>(resolve => {
    pendingConfirms.set(reqId, resolve)
    setTimeout(() => {
      if (pendingConfirms.delete(reqId)) { timedOut = true; resolve(false) }
    }, AI_CONFIRM_TIMEOUT_MS)
  })
  if (!approved) {
    rec.status = timedOut ? 'timeout' : 'denied'
    rec.outputPreview = timedOut ? '（确认超时，未执行）' : '（用户拒绝，未执行）'
    upsertRecord(rec)
    return {
      approved: false, exitCode: null, durationMs: null, output: '', truncated: false, shell: '', cwd,
      message: timedOut ? '用户在 90 秒内未确认，命令未执行' : '用户拒绝执行该命令。请如实告知未执行，不要声称已完成',
    }
  }
  rec.status = 'running'
  upsertRecord(rec)

  const shell = resolveShell(input.shellPref, true)
  const started = Date.now()
  const result = await new Promise<{ code: number | null; text: string }>(resolve => {
    let child: ChildProcess
    try {
      child = cpSpawn(shell.file, [...shell.args, cmd], { cwd, windowsHide: true, env: childEnv() })
    } catch (e) {
      resolve({ code: null, text: `进程启动失败：${(e as Error).message}` })
      return
    }
    const chunks: Buffer[] = []
    const collect = (d: Buffer | string) => {
      chunks.push(typeof d === 'string' ? Buffer.from(d, 'utf8') : d)
      if (totalLen(chunks) > 400_000) killChild(child) // 输出失控保险丝
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    let done = false
    const timer = setTimeout(() => { killChild(child) }, timeoutMs)
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, text: decodeOutput(chunks) })
    }
    child.on('close', code => finish(code))
    child.on('error', () => finish(-1))
  })
  const durationMs = Date.now() - started
  rec.status = 'ok'
  rec.exitCode = result.code
  rec.durationMs = durationMs
  rec.outputPreview = result.text.slice(0, AI_PREVIEW_CAP)
  upsertRecord(rec)
  return {
    approved: true,
    exitCode: result.code,
    durationMs,
    output: result.text.slice(0, AI_OUTPUT_CAP),
    truncated: result.text.length > AI_OUTPUT_CAP,
    shell: shell.label,
    cwd,
  }
}

function hhmm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

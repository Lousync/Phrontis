/**
 * 契约验证：终端模块（docs/terminal-module-design.md §8）。
 *
 * A 段：静态接线断言 —— 渲染层三处（types/appModules/workbench/App）、preload 三层同名、
 *       主进程（terminalService/terminalRepo/windowBus/main 挂载）、AI 工具（builtinTools/
 *       agentService 过滤链）、设置三项、打包（asarUnpack / xterm 分桶）。
 * B 段：pty 冒烟 —— plain Node 下用 @lydell/node-pty 真 spawn 一个 shell 回显标记串，
 *       验证平台子包预编译二进制可用（Electron ABI 的最终验证在 dev 首跑，见方案 §8）。
 *
 * 运行：node .AGENT/scripts/terminal/verify-terminal.mjs [仓库路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repo = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
)
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail })

// ===== A1 渲染层接线 =====
const types = read('src/types/index.ts')
check('types: TabName 含 terminal', /export type TabName = [^\n]*'terminal'/.test(types))
check('types: TerminalAiRecord 契约', types.includes('export interface TerminalAiRecord'))
check('types: ElectronAPI term 桥（termCreate/onTermData）', types.includes('termCreate:') && types.includes('onTermData:'))

const modules = read('src/lib/appModules.ts')
check('appModules: 终端条目（工作台内模块）', /\{ id: 'terminal', label: '终端'/.test(modules))

const layout = read('src/lib/workbenchLayout.ts')
check('workbench: RailModule 成员', /\| 'terminal'/.test(layout))
check('workbench: 书签条目', /\{ key: 'terminal', label: '终端', tab: 'terminal' \}/.test(layout))
check('workbench: BOOKMARK_COLORS 配色', /terminal: \{ fg:/.test(layout))

const app = read('src/App.tsx')
check('App.tsx: case terminal 挂载 TerminalModule', app.includes("case 'terminal':") && app.includes('TerminalModule'))

const preload = read('electron/preload/index.ts')
for (const k of ['termCreate', 'termAttach', 'termWrite', 'termResize', 'termKill', 'termList',
  'termDefaultShell', 'termAiRecords', 'termAiRespond', 'onTermData', 'onTermExit', 'onTermAiRecord']) {
  check(`preload: ${k}`, preload.includes(`${k}:`))
}

// ===== A2 主进程 =====
const svc = read('electron/lib/terminalService.ts')
for (const k of ['termData', 'termExit', 'termAiRecord']) {
  check(`terminalService: 广播 ${k}`, svc.includes(`BROADCAST_CHANNEL.${k}`))
}
check('terminalService: 会话真源 + backlog 回放', svc.includes('createSession') && svc.includes('attach'))
check('terminalRepo: 注册层含全部通道', ['term:create', 'term:attach', 'term:write', 'term:resize',
  'term:kill', 'term:list', 'term:defaultShell', 'term:aiRecords', 'term:aiRespond']
  .every(ch => read('electron/database/repositories/terminalRepo.ts').includes(`'${ch}'`)))

const mainIdx = read('electron/main/index.ts')
check('main: registerTerminalHandlers 挂载', mainIdx.includes('registerTerminalHandlers('))

const bus = read('electron/main/windowBus.ts')
check('windowBus: term 通道真相源', bus.includes("termData: 'term:data'")
  && bus.includes("termExit: 'term:exit'") && bus.includes("termAiRecord: 'term:ai-record'"))

// ===== A3 AI 工具门控链 =====
const tools = read('electron/lib/builtinTools.ts')
check('builtinTools: builtin.terminal.exec 注册', tools.includes("name: 'builtin.terminal.exec'"))
check('builtinTools: ondemand / requires write / module terminal', /builtin\.terminal\.exec[\s\S]{0,900}?tier: 'ondemand'/.test(tools)
  && /builtin\.terminal\.exec[\s\S]{0,900}?requires: 'write'/.test(tools)
  && /builtin\.terminal\.exec[\s\S]{0,900}?module: 'terminal'/.test(tools))
check('builtinTools: tool.request 清单补 terminal.exec', tools.includes('booksource.draft / terminal.exec'))
check('builtinTools: handler 侧设置兜底', /builtin\.terminal\.exec[\s\S]{0,1600}?terminal\.aiExec/.test(tools))

const agent = read('electron/lib/agentService.ts')
check('agentService: terminalAiExec 关 = 不进视野', agent.includes("t.module === 'terminal' && reader('terminal.aiExec') !== true"))

// ===== A4 设置 =====
const settings = read('src/lib/settings.ts')
check('settings: terminalAiExec 默认 false', /terminalAiExec: \{ default: false/.test(settings))
check('settings: aiModulePermissions 默认含 terminal:write', settings.includes('"terminal":"write"'))
check('settings: terminalShell + terminalFontSize', settings.includes('terminalShell:') && settings.includes('terminalFontSize:'))

// ===== A5 打包与构建 =====
const pkg = JSON.parse(read('package.json'))
check('package.json: asarUnpack 覆盖 node-pty', JSON.stringify(pkg.build?.asarUnpack ?? []).includes('@lydell/node-pty'))
check('package.json: 三依赖在列', !!(pkg.dependencies?.['@lydell/node-pty']
  && pkg.dependencies?.['@xterm/xterm'] && pkg.dependencies?.['@xterm/addon-fit']))
const vite = read('electron.vite.config.ts')
check('vite: @xterm 独立分桶', vite.includes("return 'xterm'"))

// ★ 根因回归位（2026-10-04）：xterm.css 漏引 = 字符测量元素可见（boot 屏 >>>> 乱码）、光标/布局全坏
check('TerminalPane: xterm.css 已引入', /import '@xterm\/xterm\/css\/xterm\.css'/.test(read('src/modules/terminal/TerminalPane.tsx')))
check('TerminalPane: windowsPty ConPTY 选项', read('src/modules/terminal/TerminalPane.tsx').includes('windowsPty'))
// ★ 根因回归位 2（2026-10-05）：term.onData → termWrite 接线丢失 = 终端完全无法输入（v2 重写时遗失）
const pane = read('src/modules/terminal/TerminalPane.tsx')
check('TerminalPane: onData → termWrite 接线在位', pane.includes('term.onData(') && pane.includes('ipc.termWrite(session.id, data)'))
check('TerminalPane: 主题对比度按背景亮度选字色', pane.includes('hexLuminance') && pane.includes("#1f2328' : '#d4d4d4'"))

// ★ 用户反馈回归位（2026-10-05）：shell 版本按系统实测不写死 + 提示按帮助披露规范收敛
check('terminalService: 标签不写死版本号', !/label: '(PowerShell 5\.1|pwsh 7)'/.test(svc))
check('terminalService: 版本实测通道（PSVersionTable / --version）', svc.includes('displayShellLabel') && svc.includes('$PSVersionTable.PSVersion.ToString()'))
check('terminalRepo: defaultShell 走实测标签', read('electron/database/repositories/terminalRepo.ts').includes('displayShellLabel'))
const termIdx = read('src/modules/terminal/index.tsx')
check('index: 侧栏底栏 nvim 提示已删（教学内容保留在 help 语料）', !termIdx.includes('nvim 等 TUI'))
check('index: 侧栏底栏 swap-bar（默认 ⓘ 悬停展开）', termIdx.includes('group-hover:opacity-0') && termIdx.includes('<Info size={13} />'))
check('index: 会话条保活文案只收不删（悬停层）', termIdx.includes('会话随 Tab 保活，关闭应用即回收'))
check('index: 工具栏去重（新建会话入口仅侧栏按钮 + 会话条＋，Toast 失败文案除外）', (termIdx.match(/新建会话(?!失败)/g) || []).length === 2)

// ===== B 段 pty 冒烟 =====
async function ptySmoke() {
  const pty = createRequire(path.join(repo, 'package.json'))('@lydell/node-pty')
  const MARK = 'TERM_SMOKE_OK_9137'
  const p = process.platform === 'win32'
    ? pty.spawn('cmd.exe', ['/c', 'echo', MARK], {})
    : pty.spawn('/bin/sh', ['-c', `echo ${MARK}`], {})
  let out = ''
  return await new Promise((resolve) => {
    p.onData(d => { out += d })
    p.onExit(({ exitCode }) => resolve({ ok: out.includes(MARK), detail: `exit=${exitCode} out="${out.trim().slice(0, 60)}"` }))
    setTimeout(() => resolve({ ok: false, detail: '10s 超时无退出' }), 10_000)
  })
}

const smoke = await ptySmoke().catch(e => ({ ok: false, detail: String(e) }))
check('pty 冒烟（plain Node 预编译二进制）', smoke.ok, smoke.detail)

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail ? ' —— ' + c.detail : ''}`)
}
console.log(failed === 0 ? `PASS —— ${checks.length}/${checks.length} 断言通过` : `FAIL —— ${checks.length - failed}/${checks.length} 断言通过`)
process.exit(failed === 0 ? 0 : 1)

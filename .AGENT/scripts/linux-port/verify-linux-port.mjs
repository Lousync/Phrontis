/**
 * 契约脚本：Linux 平台化的落码约束（v3.9.2-linux）
 *
 * 为什么需要它：这一批改动全是**平台分叉 + 静默失效**型风险 ——
 *   · 硬编码 `electron.exe` → 非 Windows 上 `npm start` 直接 ENOENT；
 *   · 靠 appendSwitch 关沙箱 / 钉显示后端 → 实测**无效**，但代码看着完全合理；
 *   · 字体回退与 worktree 薄壳 → 错了也不报错，只是「字难看」「双击没反应」。
 * 这些都没法靠 tsc 发现（tsc 过 ≠ 行为对），所以用断言把结论钉住。
 *
 * 用法：node .AGENT/scripts/linux-port/verify-linux-port.mjs
 * 输出惯例：纯文字标记 [OK] / [FAIL]，结尾 PASS / FAIL（禁 emoji，见 AGENTS.md「工作流」）。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 收集器：name + 真假 + 可选细节 */
const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail })
}

const require_ = createRequire(import.meta.url)
const srcLaunch = read('scripts/launch.js')
const srcStartDesktop = read('scripts/start-desktop.js')
const srcMain = read('electron/main/index.ts')
const srcCss = read('src/styles/index.css')
const srcLauncher = read('.AGENT/scripts/worktree-launcher/desktop-launcher.mjs')
const pkg = JSON.parse(read('package.json'))

/**
 * 剥掉注释再跑**负向**断言。
 * 不做这一步会得到假失败：为了说明清楚，代码注释里必然会写「不再写死 electron.exe」
 * 「不能靠 appendSwitch 兜底」这类字样，而负向断言要判的是**代码里还有没有**，不是注释里有没有。
 * 行注释匹配刻意避开 `://`，免得 URL 里的双斜杠把后半行吃掉。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
const codeLaunch = stripComments(srcLaunch)
const codeStartDesktop = stripComments(srcStartDesktop)
const codeMain = stripComments(srcMain)
const codeLauncher = stripComments(srcLauncher)

// ─────────────────────────────────────────────────────────────
console.log('\n=== A. Electron 可执行文件解析（scripts/electron-bin.js）===')
let eb = null
try {
  eb = require_(join(ROOT, 'scripts/electron-bin.js'))
} catch (e) {
  check('A0 模块可加载', false, String(e.message))
}
if (eb) {
  check('A0 模块可加载', true)
  for (const fn of ['electronDistDir', 'electronBinary', 'linuxSandboxUsable', 'needsNoSandbox', 'warnNoSandbox']) {
    check(`A1 导出 ${fn}`, typeof eb[fn] === 'function')
  }
  const bin = eb.electronBinary(ROOT)
  check('A2 解析出的可执行文件存在', existsSync(bin), bin)
  check('A2 解析结果与 electron 包 path.txt 一致', (() => {
    const want = readFileSync(join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
    return basename(bin) === basename(want)
  })(), basename(bin))
  check('A3 非 Windows 下不再是 electron.exe', process.platform === 'win32' || !bin.endsWith('.exe'), bin)
  check('A3 linuxSandboxUsable 对不存在的 dist 返回 false（不抛）', eb.linuxSandboxUsable('/nonexistent-root') === false)
  // 覆盖开关：排障入口，必须双向可覆盖
  const keep = process.env.KNOWBASE_NO_SANDBOX
  process.env.KNOWBASE_NO_SANDBOX = '1'
  const f1 = eb.needsNoSandbox(ROOT) === true
  process.env.KNOWBASE_NO_SANDBOX = '0'
  const f2 = eb.needsNoSandbox(ROOT) === false
  if (keep === undefined) delete process.env.KNOWBASE_NO_SANDBOX
  else process.env.KNOWBASE_NO_SANDBOX = keep
  check('A4 KNOWBASE_NO_SANDBOX=1 强制关沙箱', f1)
  check('A4 KNOWBASE_NO_SANDBOX=0 强制保沙箱', f2)
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== B. 启动器 scripts/launch.js ===')
check('B1 走 electron-bin 解析可执行名', /require\('\.\/electron-bin'\)/.test(srcLaunch))
check('B1 负向：代码里不再出现 electron.exe 字面量', !/electron\.exe/.test(codeLaunch))
check('B2 Linux 下钉 ozone=x11', /ELECTRON_OZONE_PLATFORM_HINT\s*=\s*'x11'/.test(srcLaunch))
check('B2 负向：不用 auto（Wayland 会话下会主动选 Wayland）', !/ELECTRON_OZONE_PLATFORM_HINT\s*=\s*'auto'/.test(srcLaunch))
check('B2 负向：代码里不靠 appendSwitch 钉显示后端（实测无效）', !/appendSwitch/.test(codeLaunch))
check('B3 dev 分支经 NO_SANDBOX=1 注入', /env\.NO_SANDBOX\s*=\s*'1'/.test(srcLaunch))
check('B4 start 分支带 --no-sandbox', /'--no-sandbox'/.test(srcLaunch))
check('B5 start 分支缺产物时给明确报错（原先静默 spawn 失败）', /先跑 npm run build/.test(srcLaunch))

console.log('\n=== C. 启动器 scripts/start-desktop.js + start-desktop.sh ===')
check('C1 start-desktop.js 走同一解析模块', /require\('\.\/electron-bin'\)/.test(srcStartDesktop))
check('C1 负向：代码里不再硬编码 electron.exe', !/electron\.exe/.test(codeStartDesktop))
check('C2 POSIX 临时目录 TMPDIR 已设', /TMPDIR:\s*DEV_TMP/.test(srcStartDesktop))
const shPath = join(ROOT, 'scripts/start-desktop.sh')
check('C3 start-desktop.sh 在场', existsSync(shPath))
if (existsSync(shPath)) {
  const srcSh = readFileSync(shPath, 'utf8')
  check('C3 start-desktop.sh 可执行', (statSync(shPath).mode & 0o111) !== 0)
  check('C3 start-desktop.sh 自定位（dirname $0）', /dirname\s+"\$0"/.test(srcSh))
  check('C3 start-desktop.sh 调 start-desktop.js', /scripts\/start-desktop\.js/.test(srcSh))
  check('C3 start-desktop.sh 保留现场（退出前等待）', /read -r/.test(srcSh))
  check('C3 负向：.sh 里没有 electron.exe', !/electron\.exe/.test(srcSh))
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== D. 主进程 electron/main/index.ts ===')
check('D1 Linux 下按实际后端告警', /getSwitchValue\('ozone-platform'\)/.test(srcMain))
check('D1 告警文案指向 env/命令行开关', /ELECTRON_OZONE_PLATFORM_HINT=x11/.test(srcMain))
check('D2 负向：主进程代码里不 appendSwitch ozone-platform（实测无效，写了等于假安全感）',
  !/appendSwitch\(\s*'ozone-platform'/.test(codeMain))
check('D3 KNOWBASE_DISABLE_GPU 块保留', /KNOWBASE_DISABLE_GPU === '1'/.test(srcMain))
check('D3 其 no-sandbox 在 Linux 无效已标注', /appendSwitch\('no-sandbox'\)[\s\S]{0,400}?无效/.test(srcMain))

console.log('\n=== E. 渲染层字体栈 src/styles/index.css ===')
const sansLine = (srcCss.match(/--font-sans:[^\n]*/) || [''])[0]
const monoLine = (srcCss.match(/--font-mono:[^\n]*/) || [''])[0]
check('E1 sans 补了 CJK 回退', /Noto Sans CJK SC/.test(sansLine), sansLine.slice(0, 60))
check('E1 sans 保留 Windows 段（不回退既有平台）', /Microsoft YaHei/.test(sansLine) && /Segoe UI/.test(sansLine))
check('E2 mono 补了 POSIX 等宽回退', /DejaVu Sans Mono/.test(monoLine), monoLine.slice(0, 60))
check('E2 mono 保留 Windows 段', /Cascadia Code/.test(monoLine) && /Consolas/.test(monoLine))

// ─────────────────────────────────────────────────────────────
console.log('\n=== F. worktree 启动器 desktop-launcher.mjs ===')
check('F1 薄壳扩展名按平台分叉', /WRAPPER_EXT\s*=/.test(srcLauncher) && /\.desktop/.test(srcLauncher))
check('F1 入口脚本按平台分叉（.bat / .sh）', /ENTRY_REL\s*=/.test(srcLauncher) && /start-desktop\.sh/.test(srcLauncher))
check('F2 有 .desktop 生成器', /function desktopFileText/.test(srcLauncher))
check('F2 .desktop 生成器含规范必备键', ['Type=Application', 'Exec=', 'Path=', 'Terminal=true', 'Icon=']
  .every(k => srcLauncher.includes(k)))
check('F3 checkDesktop 拒绝 CR（LF 强制）', /CR present \(LF required/.test(srcLauncher))
check('F3 负向：checkDesktop 不套用 ASCII 规则（.desktop 允许 UTF-8）', (() => {
  const seg = srcLauncher.slice(srcLauncher.indexOf('function checkDesktop'))
  const body = seg.slice(0, seg.indexOf('\n}\n'))
  return !/x20-\\x7e/.test(body)
})())
check('F4 scan 认两种 marker（.bat rem 行 / .desktop 自定义键）',
  /MARKER_KEY/.test(srcLauncher) && /rem\\\\s\+' \+ MARKER/.test(srcLauncher))
check('F5 defaultName 剥两个主仓前缀（Phrontis 与 KnowledgeRecorder）',
  /\(Phrontis\|KnowledgeRecorder\)/.test(srcLauncher))
check('F6 Linux 默认落 XDG applications（避开 ~/Desktop 的 trusted 陷阱）',
  /XDG_DATA_HOME/.test(srcLauncher) && /'applications'/.test(srcLauncher))

const pkgName = pkg.name
check('F7 佐证：包名仍为 knowbase（平台化不改 npm 包名）', pkgName === 'knowbase', String(pkgName))

// ─────────────────────────────────────────────────────────────
// G. AI 工具面的平台中性（2026-10-19 专项审计结论）
//
// 审计口径：AI 工具是「主进程里能碰 OS 的地方」，最该防的是**悄悄长出平台假设**。
// 全量审计结果 —— 28 个 builtin 工具里 0 处 process.platform、0 处 shell 执行、0 处 Windows 专属命令；
// skill.* 是纯提示词工具（readOnly，返回字符串）零 OS 耦合；vault.* 全走 workspaceManager + pathGuard。
// 唯一碰 OS 的是 terminal.exec，它转发给 terminalService（已按平台取 shell）。
// MCP 的 stdio 启动由 @modelcontextprotocol/sdk 内部的 cross-spawn 处理（它专治 Windows 的 .cmd 解析），
// 所以**不要**自己在 mcpManager 里再包一层 cmd /c —— 那是双包装。
// 这一节把上述结论钉住：将来新加工具若需要平台分叉，必须走共享服务层，不能就地分叉。
console.log('\n=== G. AI 工具面的平台中性 ===')
const srcBuiltin = stripComments(read('electron/lib/builtinTools.ts'))
check('G1 负向：builtinTools.ts 代码里无 process.platform（工具不得就地平台分叉）',
  !/process\.platform/.test(srcBuiltin))
check('G2 负向：builtinTools.ts 代码里无 shell 执行（须转发给 terminalService 等共享服务）',
  !/child_process|execSync|execFileSync|spawnSync|spawn\(/.test(srcBuiltin))
check('G3 工具描述若提 Windows，必须同时给出 POSIX 口径',
  !/Windows/.test(srcBuiltin) || /macOS\/Linux/.test(srcBuiltin))
const srcMcp = stripComments(read('electron/lib/mcpManager.ts'))
check('G4 负向：mcpManager 不自建 cmd/shell 包装（SDK 内 cross-spawn 已处理）',
  !/shell:\s*true/.test(srcMcp) && !srcMcp.includes('cmd /c') && !srcMcp.includes('cmd.exe'))
const srcToolsView = read('src/modules/settings/views/AiToolsView.tsx')
check('G5 负向：MCP 命令占位不得给 Windows 盘符路径示例（平台中性）',
  !srcToolsView.includes('C:\\') && !srcToolsView.includes('.exe'))
check('G5 正向：MCP 命令占位给的是可跨平台执行的示例',
  /例如 node/.test(srcToolsView))

// ─────────────────────────────────────────────────────────────
// H. 阶段 1：Linux 桌面语义（托盘宿主 / 快捷键 / 密文三态 / 环境自检 / AI 面排序）
//
// 这一节钉的全是「错了不报错」型的结论：
//   · 关窗语义反了 → 窗口藏起来却唤不回（该真退出时反而常驻），或该常驻时直接退出；
//   · 不看 `globalShortcut.register` 的返回值 → 用户「按了没反应」，日志里也查不到；
//   · safeStorage 密文头按 Windows 假定 → Linux 上每次启动一条**假故障**；
//   · 密文解不开仍返回空串 → 「条目都在、密码全空」。
// 另注：secretBox 与 passwordRepo 是**有意**互不引用的两份拷贝（格式兼容但不耦合），
// 所以这里额外锁「两份同步」，否则会出现「密码本有提示、LLM 账户页静默」这种没人发现的漂移。
console.log('\n=== H. 阶段 1：Linux 桌面语义 ===')
const srcLinuxDesktop = read('electron/lib/linuxDesktop.ts')
const codeLinuxDesktop = stripComments(srcLinuxDesktop)
const codePasswordFiller = stripComments(read('electron/main/passwordFiller.ts'))
const codeDayPanel = stripComments(read('electron/main/dayPanelWindow.ts'))
const srcSecretBox = read('electron/lib/secretBox.ts')
const codeSecretBox = stripComments(srcSecretBox)
const srcPasswordRepo = read('electron/database/repositories/passwordRepo.ts')
const codePasswordRepo = stripComments(srcPasswordRepo)
const srcAppNotice = read('electron/lib/appNotice.ts')
const srcFsWatcher = read('electron/lib/fsWatcher.ts')
const codeFsWatcher = stripComments(srcFsWatcher)
const srcSuggestPure = read('electron/lib/aiAssistantScopeSuggestPure.ts')
const codeSuggestPure = stripComments(srcSuggestPure)
const codeAiTools = stripComments(read('electron/lib/aiTools.ts'))
const srcPreload = read('electron/preload/index.ts')
const srcTypes = read('src/types/index.ts')
const srcApp = read('src/App.tsx')
const srcVault = read('src/modules/toolbox/components/PasswordVault.tsx')
const srcModelsTab = read('src/modules/settings/views/AiModelsTab.tsx')

// H1 托盘宿主探测：判据必须是 D-Bus 名，不能是 GNOME 扩展名
check('H1 linuxDesktop 导出宿主探测与同步缓存读法',
  /export async function detectStatusNotifierHost/.test(srcLinuxDesktop) && /export function statusNotifierHostCached/.test(srcLinuxDesktop))
check('H1 探测走 gdbus + org.kde.StatusNotifierWatcher', /gdbus/.test(srcLinuxDesktop) && /org\.kde\.StatusNotifierWatcher/.test(srcLinuxDesktop))
check('H1 探测有超时（不许拖住启动）', /PROBE_TIMEOUT_MS\s*=\s*\d+/.test(srcLinuxDesktop) && /timeout:\s*timeoutMs/.test(srcLinuxDesktop))
check('H1 负向：不按 GNOME 扩展名判定（宿主由系统预装扩展提供，扩展名列表里查不到）',
  !/enabled-extensions|enabled_extensions|getEnabledExtensions/.test(codeLinuxDesktop))
check('H1 非 Linux 平台明确按 false 处理（该探测不是「通用托盘可用性」）',
  /process\.platform !== 'linux'[\s\S]{0,120}?cachedHost = false/.test(codeLinuxDesktop))
check('H1 KNOWBASE_FORCE_TRAY 排障开关在场', /KNOWBASE_FORCE_TRAY/.test(srcLinuxDesktop))

// H2 关窗语义：Linux 上没有可用托盘就真退出（决策 #3）
check('H2 主进程 close 用「Linux 且确有托盘」作隐藏前提',
  /process\.platform === 'linux' && !\(tray && statusNotifierHostCached\(\)\)/.test(stripComments(read('electron/main/index.ts'))))
check('H2 无托盘时直接放行关闭（不 preventDefault）', (() => {
  const seg = stripComments(read('electron/main/index.ts'))
  const i = seg.indexOf("mainWindow.on('close'")
  if (i < 0) return false
  const body = seg.slice(i, i + 700)
  // 前提判断出现在 preventDefault 之前，且那句是 return（放行）而不是 hide
  return /process\.platform === 'linux'[\s\S]*?\)\)\s*return/.test(body) && /e\.preventDefault\(\)[\s\S]*?mainWindow\?\.hide\(\)/.test(body)
})())
check('H2 负向：close 里不再是无条件劫持（旧的 if (!isQuitting) { preventDefault(); hide() }）',
  !/if \(!isQuitting\) \{\s*e\.preventDefault\(\)/.test(stripComments(read('electron/main/index.ts'))))
check('H2 无宿主时不创建托盘（建了也看不见，却会让窗口藏了回不来）',
  /process\.platform === 'linux'[\s\S]{0,400}?detectStatusNotifierHost\(\)[\s\S]{0,400}?if \(!host\)/.test(stripComments(read('electron/main/index.ts'))))

// H3 全局快捷键：结论看 register 的返回值（原先只 try/catch，失败静默）
check('H3 PasswordFiller 检查 register 返回值并提示',
  /const ok = globalShortcut\.register\(/.test(codePasswordFiller) && /if \(ok\)/.test(codePasswordFiller) && /pushAppNotice\(/.test(codePasswordFiller))
check('H3 DayPanel 三个快捷键逐一检查返回值并聚合成一条提示',
  /const bind = \(accel: string, fn: \(\) => void\)/.test(codeDayPanel) && /if \(!globalShortcut\.register\(accel, fn\)\) failed\.push\(accel\)/.test(codeDayPanel) && /pushAppNotice\(/.test(codeDayPanel))
check('H3 负向：两处都不得再有「调 register 但不接收返回值」的裸语句',
  !/(^|\n)\s*globalShortcut\.register\(/.test(codePasswordFiller) && !/(^|\n)\s*globalShortcut\.register\(/.test(codeDayPanel))

// H4 safeStorage：密文头按平台断言（原先硬断言 v10 ⇒ Linux 上每条启动一条假故障）
check('H4 secretBox 有按平台的期望头表', /KNOWN_CIPHER_HEADS/.test(srcSecretBox))
check('H4 win32 期望 v10 保留', /win32:\s*\[\s*'v10'\s*\]/.test(srcSecretBox))
check('H4 linux 期望收 v10 + v11（gnome_libsecret 实测 v11；无钥匙串退回 basic_text 时是 v10）',
  /linux:\s*\[\s*'v10',\s*'v11'\s*\]/.test(srcSecretBox))
check('H4 负向：自检里不再硬断言 head !== \'v10\'', !/head !== 'v10'/.test(codeSecretBox))
check('H4 后端名可读（basic_text = 无系统钥匙串，弱保护）',
  /export function secretStorageBackend/.test(srcSecretBox) && /basic_text/.test(srcSecretBox))
check('H4 启动期把后端名打出来（跨平台排障第一手线索）',
  /secretStorageBackend\(\)/.test(stripComments(read('electron/main/index.ts'))))

// H5 跨平台密文三态：两份拷贝都必须是三态，且都透出「解不开」这个信号
check('H5 secretBox 三态（empty / plaintext / encrypted / undecryptable）',
  /'undecryptable'/.test(codeSecretBox) && /export function decodeSecret/.test(srcSecretBox) && /export function isSecretUndecryptable/.test(srcSecretBox))
check('H5 passwordRepo 三态拷贝同步', /'undecryptable'/.test(codePasswordRepo) && /export function decodePassword/.test(srcPasswordRepo))
check('H5 两份拷贝都标了「必须同步改」的说明', /两份/.test(srcSecretBox) && /两份/.test(srcPasswordRepo))
check('H5 passwordRepo 行结构透出 passwordUndecryptable', /passwordUndecryptable:\s*dec\.state === 'undecryptable'/.test(codePasswordRepo))
check('H5 小密码本（fillPopup）也透出该标志（否则弹窗里给的是空密码）',
  /passwordUndecryptable:\s*dec\.state === 'undecryptable'/.test(codePasswordFiller))
check('H5 负向：passwordRepo 里不再有「解密失败 → 返回空串」的裸 catch',
  !/catch \{\s*return '' \/\/ 解密失败/.test(codePasswordRepo))
check('H5 LLM 账号信息透出 keyUnreadable（解不开的 Key 不许显示成「已配置」）',
  /keyUnreadable:\s*!!unreadable/.test(stripComments(read('electron/lib/llmAccountPure.ts'))))
check('H5 llmService 用 isSecretUndecryptable 计算该标志', /isSecretUndecryptable\(a\.keyEncrypted\)/.test(stripComments(read('electron/lib/llmService.ts'))))
check('H5 llmService 区分「没配 Key」与「解不开」两种 NO_KEY',
  /Key 在本机无法解密/.test(stripComments(read('electron/lib/llmService.ts'))))
check('H5 密码本界面：行内标记 + 顶部提示条', /passwordUndecryptable/.test(srcVault) && /无法解密/.test(srcVault) && /条密码在本机无法解密/.test(srcVault))
check('H5 LLM 账户界面：行内标记 + 顶部提示条', /a\.keyUnreadable/.test(srcModelsTab) && /Key 无法解密/.test(srcModelsTab) && /个账号的 API Key 在本机无法解密/.test(srcModelsTab))
check('H5 提示条可关闭（「知道了」），且关掉不隐藏条目上的常驻标记',
  /setUnreadableNoticeOpen\(false\)/.test(srcVault) && /setUnreadableKeyNoticeOpen\(false\)/.test(srcModelsTab)
  && /无法解密/.test(srcVault) && /Key 无法解密/.test(srcModelsTab))
check('H5 类型汇点：PasswordEntry 透出该字段', /passwordUndecryptable\?: boolean/.test(srcTypes))
check('H5 类型汇点：LlmAccountInfo 透出该字段', /keyUnreadable: boolean/.test(srcTypes))
check('H5 负向：渲染层不用 alert / confirm（反馈一律走 Toast / 行内提示）',
  !/\balert\(|\bconfirm\(/.test(srcVault) && !/\balert\(|\bconfirm\(/.test(srcModelsTab))
check('H5 IPC 三件套齐（密文平台信息 / 告警取走 / 告警订阅），三处名字一致',
  /secret:platformInfo/.test(srcPreload) && /app:takeNotices/.test(srcPreload) && /onAppNotice/.test(srcPreload)
  && /'secret:platformInfo'/.test(srcSecretBox) && /'app:takeNotices'/.test(srcAppNotice)
  && /secretPlatformInfo: \(\) => Promise<SecretPlatformInfo>/.test(srcTypes) && /takeAppNotices: \(\) => Promise<AppNoticeInfo\[\]>/.test(srcTypes))

// H6 告警通道：队列 + 广播（启动期告警早于渲染层监听）
check('H6 appNotice 有渲染层就绪标记（就绪后只广播，避免旧告警下次启动再弹）', /rendererReady/.test(srcAppNotice))
check('H6 appNotice 队列有上限（坏状态下不无界增长）', /MAX_QUEUE\s*=\s*\d+/.test(srcAppNotice))
check('H6 takeAppNotices 取走即删', /unlinkSync/.test(srcAppNotice))
check('H6 主进程启动期注册该通道', /registerAppNoticeHandlers\(\)/.test(stripComments(read('electron/main/index.ts'))))
check('H6 渲染层**先订阅后取队列**并按 id 去重', (() => {
  const i = srcApp.indexOf('const off = onAppNotice(show)')
  const j = srcApp.indexOf('takeAppNotices().then')
  return i > 0 && j > i && /shown\.has\(n\.id\)/.test(srcApp)
})())

// H7 inotify 上限：过低提醒一次；ENOSPC 归因到配额
check('H7 fsWatcher 读 /proc/sys/fs/inotify/max_user_watches', /\/proc\/sys\/fs\/inotify\/max_user_watches/.test(srcFsWatcher))
check('H7 有阈值且有「只提醒一次」的守卫', /INOTIFY_WATCH_WARN_THRESHOLD\s*=\s*\d+/.test(srcFsWatcher) && /inotifyWarned/.test(srcFsWatcher))
check('H7 ENOSPC 归因到配额并给用户提示',
  /\/ENOSPC\/i\.test\(reason\)/.test(codeFsWatcher) && /inotify 配额不足/.test(srcFsWatcher))
check('H7 预检挂在挂监听之前（不是等到失败才说）', (() => {
  // 只看 syncVaultWatcher 内部：函数定义那行本身就含 `checkInotifyLimitOnce(`，
  // 全文件 indexOf 会命中定义、把「调用被删掉」漏过去（变异测试抓出来的）。
  const seg = codeFsWatcher.slice(codeFsWatcher.indexOf('export function syncVaultWatcher'))
  const i = seg.indexOf('checkInotifyLimitOnce()')
  const j = seg.indexOf('watch(nextPath')
  return i > 0 && j > i
})())

// H8 回收站自检：判据是 XDG 目录可写性（trash 包在 Linux 自己实现 XDG Trash，不依赖 gio/trash-cli）
check('H8 linuxDesktop 有 XDG 回收站自检', /export function checkXdgTrash/.test(srcLinuxDesktop) && /XDG_DATA_HOME/.test(srcLinuxDesktop))
check('H8 XDG_DATA_HOME 按规范要求绝对路径', /isAbsolute\(dataHome\)/.test(codeLinuxDesktop))
check('H8 负向：自检不靠 gio / trash-cli 判定（那是已核实的错误前提）',
  !/trash-cli|which gio|'gio'/.test(codeLinuxDesktop))
check('H8 启动期自检并把不可用告知用户', /checkXdgTrash\(\)/.test(stripComments(read('electron/main/index.ts'))) && /回收站不可用/.test(read('electron/main/index.ts')))

// H9 AI 面排序确定性（台账 F-10 拍板：只改 AI 面；人类列表保留 'zh-Hans' 钉死档）
check('H9 负向：建议作用域排序代码里不得出现 localeCompare',
  !/localeCompare/.test(codeSuggestPure))
check('H9 负向：工具清单排序（aiTools）代码里不得出现 localeCompare',
  !/localeCompare/.test(codeAiTools))
check("H9 人类列表仍走 'zh-Hans' 钉死档（没有被顺手改掉）",
  /localeCompare\(b\.name, 'zh-Hans-CN'\)/.test(read('src/lib/treeSort.ts')))

// H9 真跑：同一份数据在三种 locale 下必须给出**完全相同的**行序（F-9 的同类判据）
const suggestPureUrl = pathToFileURL(join(ROOT, 'electron/lib/aiAssistantScopeSuggestPure.ts')).href
const pureProbe = `
  import { suggestScope, compareSuggestStable } from ${JSON.stringify(suggestPureUrl)}
  import { sanitizeAccountInfo } from ${JSON.stringify(pathToFileURL(join(ROOT, 'electron/lib/llmAccountPure.ts')).href)}
  const entries = [
    { relPath: 'p/4.md', title: '指针 阿', entryKind: 'page' },
    { relPath: 'p/3.md', title: '指针 乙', entryKind: 'page' },
    { relPath: 'p/1.md', title: '指针 Z', entryKind: 'page' },
    { relPath: 'p/2.md', title: '指针 a', entryKind: 'page' },
  ]
  const order = suggestScope('指针', entries, 8).map((s) => s.title)
  const acct = { id: 'a1', name: '工作号', keyEncrypted: 'enc1:SECRET-CIPHER', enabled: true }
  const masked = sanitizeAccountInfo(acct, true)
  const maskedDefault = sanitizeAccountInfo(acct)
  console.log(JSON.stringify({
    order,
    cmp: [compareSuggestStable('a', 'b'), compareSuggestStable('b', 'a'), compareSuggestStable('a', 'a')],
    unreadable: masked.keyUnreadable,
    unreadableDefault: maskedDefault.keyUnreadable,
    hasKey: masked.hasKey,
    leak: JSON.stringify(masked).includes('SECRET-CIPHER') || JSON.stringify(masked).includes('enc1:') || ('keyEncrypted' in masked),
  }))
`
function runPureProbe(locale) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', pureProbe], {
    env: { ...process.env, LC_ALL: locale }, encoding: 'utf8', timeout: 30000,
  })
  if (r.status !== 0) return { error: String(r.stderr || r.error || 'exit ' + r.status).slice(0, 300) }
  try {
    return { data: JSON.parse(String(r.stdout).trim().split('\n').pop() || '') }
  } catch (e) {
    return { error: 'stdout 解析失败: ' + String(r.stdout).slice(0, 200) }
  }
}
const probeC = runPureProbe('C')
const probeZh = runPureProbe('zh_CN.UTF-8')
const probeEn = runPureProbe('en_US.UTF-8')
check('H9 真跑：纯模块探测可执行（三种 locale）',
  !probeC.error && !probeZh.error && !probeEn.error,
  probeC.error || probeZh.error || probeEn.error || '')
if (!probeC.error && !probeZh.error && !probeEn.error) {
  const a = JSON.stringify(probeC.data.order)
  const b = JSON.stringify(probeZh.data.order)
  const c = JSON.stringify(probeEn.data.order)
  check('H9 真跑：LC_ALL=C / zh_CN.UTF-8 / en_US.UTF-8 三处行序完全一致',
    a === b && b === c, `C=${a} zh=${b} en=${c}`)
  check('H9 真跑：同分并列按码点序（Z < a < 乙 < 阿）',
    a === JSON.stringify(['指针 Z', '指针 a', '指针 乙', '指针 阿']), a)
  check('H9 真跑：compareSuggestStable 是码点序（-1 / 1 / 0）',
    JSON.stringify(probeC.data.cmp) === JSON.stringify([-1, 1, 0]), JSON.stringify(probeC.data.cmp))
  check('H9 真跑：sanitizeAccountInfo 透出 keyUnreadable，且默认 false、密文不外泄',
    probeC.data.unreadable === true && probeC.data.unreadableDefault === false && probeC.data.hasKey === true && probeC.data.leak === false,
    JSON.stringify(probeC.data))
}

// ─────────────────────────────────────────────────────────────
// I. 阶段 2：打包与发布（v3.9.2 · deb + 独立 tag + Linux 关更新）
//
// 这一节防的是「打包配置看着对、产物不能用」与「Linux 悄悄去请求 Windows 的更新通道」：
//   · author 缺 email → deb 直接打不出来（builder 抛 Please specify author 'email'）；
//   · description 带「Windows」→ 写进 .desktop 的 Comment，Linux 用户第一眼就看到「外来户」；
//   · afterInstall 里的未定义宏 → builder 打包期抛错（写花括号 shell 变量就会踩）；
//   · Linux 不关更新 → 去比 Windows 的 releases/latest，或在 deb 安装位置上做原地替换。
console.log('\n=== I. 阶段 2：打包与发布 ===')
const srcAfterInstall = read('build/linux-after-install.sh')
const srcPublish = read('scripts/publish-release.py')
const srcPackMjs = read('scripts/pack.mjs')
const srcUpdateService = read('electron/lib/updateService.ts')
const codeUpdateService = stripComments(srcUpdateService)
const srcPlatformLib = read('src/lib/platform.ts')
const srcUpdateStore = read('src/lib/updateStore.ts')
const srcTitleBar = read('src/components/shared/TitleBar.tsx')
const srcAboutView = read('src/modules/settings/views/AboutView.tsx')
const srcChangelog = read('CHANGELOG.md')
const srcReleaseData = read('electron/lib/releaseNotes/data.ts')

// I1 package.json：deb 必需的元数据 + 平台中性文案
check('I1 顶层 author 带 email（deb 的 Maintainer 由此而来，缺了 builder 直接抛错）',
  typeof pkg.author === 'object' && !!pkg.author?.email, JSON.stringify(pkg.author))
check('I1 description 平台中性（会进 .desktop 的 Comment）',
  typeof pkg.description === 'string' && pkg.description.length > 0 && !/Windows/i.test(pkg.description))
check('I1 版本号＝发版线 3.9.2', pkg.version === '3.9.2', String(pkg.version))
check('I1 build.linux 里目标只有 deb', Array.isArray(pkg.build?.linux?.target)
  && pkg.build.linux.target.length === 1 && pkg.build.linux.target[0]?.target === 'deb',
  JSON.stringify(pkg.build?.linux?.target))
check('I1 build.linux 可执行名 / 图标 / 分类 / maintainer / 产物命名齐备',
  pkg.build?.linux?.executableName === 'phrontis' && pkg.build?.linux?.icon === 'build/icon.png'
  && pkg.build?.linux?.category === 'Office;TextEditor;' && !!pkg.build?.linux?.maintainer
  && pkg.build?.linux?.artifactName === 'Phrontis-${version}-${arch}.${ext}')
check('I1 desktopName + syncDesktopName 成对（GNOME 才能把窗口关联到 phrontis.desktop）',
  pkg.desktopName === 'phrontis.desktop' && pkg.build?.linux?.syncDesktopName === true)
check('I1 负向：Windows 侧配置一行未动（win / nsis / extraResources / asarUnpack / npmRebuild / electronDist）',
  pkg.build?.win?.target?.[0]?.target === 'nsis' && pkg.build?.nsis?.oneClick === false
  && Array.isArray(pkg.build?.extraResources) && pkg.build.extraResources.length === 6
  && pkg.build.extraResources.some((e) => e?.from === 'scripts/desktop-bridge' && e?.to === 'desktop-bridge')
  && pkg.build?.asarUnpack?.[0] === '**/node_modules/@lydell/node-pty*/**'
  && pkg.build?.npmRebuild === false && pkg.build?.electronDist === 'node_modules/electron/dist')
check('I1 deb.afterInstall 指向真实存在的脚本文件',
  pkg.build?.deb?.afterInstall === 'build/linux-after-install.sh' && existsSync(join(ROOT, pkg.build.deb.afterInstall)))

// I2 postinst：默认模板行为 + AppArmor 装不上时回退 4755
check('I2 postinst 有 AppArmor 干跑（parse 不过就跳过安装）', /apparmor_parser --skip-kernel-load --debug/.test(srcAfterInstall))
check('I2 postinst 记录 profile 是否真装成（AA_INSTALLED）', /AA_INSTALLED=1/.test(srcAfterInstall))
check('I2 postinst 兜底：profile 没装成且内核限制 userns → chmod 4755',
  /chmod 4755 '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/.test(srcAfterInstall)
  && /apparmor_restrict_unprivileged_userns/.test(srcAfterInstall))
check('I2 postinst 保留默认模板的软链 / MIME / 桌面库刷新',
  /update-alternatives --install/.test(srcAfterInstall) && /update-mime-database/.test(srcAfterInstall)
  && /update-desktop-database/.test(srcAfterInstall))
check('I2 ★ postinst 只用 builder 会替换的两个宏（多写一个未定义宏 = 打包直接抛错）', (() => {
  const names = [...new Set([...srcAfterInstall.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]))].sort()
  return names.length > 0 && names.every((n) => n === 'executable' || n === 'sanitizedProductName')
})(), [...new Set([...srcAfterInstall.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((m) => m[1]))].sort().join(','))

// I3 pack.mjs：按平台选目标（用例在 verify-pack-dir.mjs，这里只钉接线与交叉打包守卫）
check('I3 pack 走 resolveTargetFlag（不再硬编码 --win）',
  /resolveTargetFlag\(process\.platform, argv\)/.test(srcPackMjs) && !/electron-builder --win/.test(stripComments(srcPackMjs)))
check('I3 交叉打包默认中止（逃生门 KNOWBASE_ALLOW_CROSS_PACK）',
  /isCrossPack\(process\.platform, flag\)/.test(srcPackMjs) && /KNOWBASE_ALLOW_CROSS_PACK/.test(srcPackMjs))
check('I3 打包前拦下 symlink 的 node_modules（实测：会静默漏掉传递依赖，装上一启动即崩）',
  // 断言必须是**调用点**的形状：函数定义那行本身就含 `nodeModulesIsSymlink(repoRoot)`，
  // 只做 includes 的话「闸门被删掉」会被定义顶成绿的（变异测试抓出来的，同 §H 的 inotify 一条）。
  /if \(nodeModulesIsSymlink\(repoRoot\) && process\.env\.KNOWBASE_ALLOW_SYMLINK_NODE_MODULES !== '1'\) \{/.test(stripComments(srcPackMjs))
  && /export function nodeModulesIsSymlink\(repoRoot\)/.test(srcPackMjs))

// I4 publish-release.py：独立 tag + Linux 两件套门 + Windows 逻辑保留
check('I4 支持 --platform（auto / win / linux）', /--platform/.test(srcPublish) && /choices=\['auto', 'win', 'linux'\]/.test(srcPublish))
check('I4 Linux tag 走 v<ver>-linux', /def platform_tag/.test(srcPublish) && /v%s-linux/.test(srcPublish))
check('I4 Linux 门 1 校验 deb + latest-linux.yml（deb 没有 .blockmap）',
  /'latest-linux\.yml'/.test(srcPublish) && /Phrontis-%s-\[a-z0-9\]\+\\\.deb/.test(srcPublish))
check('I4 Linux 额外核对 deb control 的 Version（防「抬了版本号但没重打包」）', /dpkg-deb/.test(srcPublish) && /control Version/.test(srcPublish))
check('I4 tag 钉在本地 HEAD（gh 缺省建在默认分支 HEAD，会让 tag 指到没含本版的 commit）',
  /--target', head\]/.test(srcPublish) && /def local_head_sha/.test(srcPublish))
check('I4 双 tag 一致性校验（决策 #10：v<ver> 与 v<ver>-linux 必须同一 commit）',
  // 钉**调用点**：函数定义 `def check_counterpart_tag(ver, platform, head):` 与调用点逐字同形，
  // 只做子串匹配时「把调用删掉」会被定义顶成绿的（变异测试抓出来的，本批第三次踩同一个坑）。
  /^[ \t]+check_counterpart_tag\(ver, platform, head\)$/m.test(srcPublish)
  && /def check_counterpart_tag/.test(srcPublish))
check('I4 负向：Windows 分支仍要求 exe + .blockmap + latest.yml 三件套（逻辑未被平台化改坏）',
  /blockmap_name = exe_name \+ '\.blockmap'/.test(srcPublish) && /yml_name = 'latest\.yml'/.test(srcPublish)
  && /缺 latest-linux\.yml/.test(srcPublish))

// I5 应用内更新：Linux 下直接返回、不发网络请求
check('I5 updateService 有平台开关（IN_APP_UPDATE_UNAVAILABLE）',
  /const IN_APP_UPDATE_UNAVAILABLE = process\.platform === 'linux'/.test(srcUpdateService))
check('I5 update:check 的守卫在网络请求之前（Linux 一个请求都不发）', (() => {
  const seg = codeUpdateService.slice(codeUpdateService.indexOf("ipcMain.handle('update:check'"))
  const guard = seg.indexOf('if (IN_APP_UPDATE_UNAVAILABLE) return updateUnavailableResult(currentVersion)')
  const fetchAt = seg.indexOf('net.fetch(API_LATEST')
  return guard >= 0 && fetchAt > guard
})())
check('I5 update:download / update:install 同样硬拒',
  /IN_APP_UPDATE_UNAVAILABLE\) return \{ success: false, message: '本平台不提供应用内更新/.test(codeUpdateService)
  && (codeUpdateService.match(/IN_APP_UPDATE_UNAVAILABLE\) return \{ success: false/g) || []).length >= 2)
check('I5 负向：不再用 `downloads + 反斜杠` 拼前缀（POSIX 上恒判「路径不受信任」的现成 bug）',
  !/downloads\.endsWith\('\\\\'\)/.test(codeUpdateService) && !/downloads \+ '\\\\'/.test(codeUpdateService))
check('I5 安装包路径判定改走相对路径（平台无关）', /relative\(downloads, resolved\)/.test(codeUpdateService))

// I6 渲染层：平台暴露 + 更新入口隐藏 + 设置页改手动下载
check('I6 preload 暴露 api.platform（进程平台直传）', /platform: process\.platform,/.test(srcPreload))
check('I6 ElectronAPI 声明 platform 字段', /platform: string/.test(srcTypes))
check('I6 平台判据唯一出处 src/lib/platform.ts',
  /export const IN_APP_UPDATE_SUPPORTED = !IS_LINUX/.test(srcPlatformLib) && /export const IS_LINUX = APP_PLATFORM === 'linux'/.test(srcPlatformLib))
check('I6 updateStore 两条路径都按平台提前返回（不发起检查 IPC）',
  (srcUpdateStore.match(/if \(!IN_APP_UPDATE_SUPPORTED\) return/g) || []).length >= 2,
  String((srcUpdateStore.match(/if \(!IN_APP_UPDATE_SUPPORTED\) return/g) || []).length))
check('I6 标题栏更新入口在 Linux 恒不可见，且不发起启动检查',
  /const showEntry = IN_APP_UPDATE_SUPPORTED && \(/.test(srcTitleBar) && /if \(IN_APP_UPDATE_SUPPORTED\) updateStartupCheck\(\)/.test(srcTitleBar))
check('I6 设置页 Linux 给「打开发布页」而不是「检查更新」',
  /IN_APP_UPDATE_SUPPORTED \? \(/.test(srcAboutView) && /RELEASES_URL/.test(srcAboutView) && /不提供应用内自动更新/.test(srcAboutView))
check('I6 负向：设置页不得在 Linux 分支里仍然渲染检查更新按钮', (() => {
  const i = srcAboutView.indexOf('不提供应用内自动更新')
  const j = srcAboutView.indexOf("onClick={() => void updateCheck()}")
  // updateCheck 的按钮必须在 IN_APP_UPDATE_SUPPORTED 三元的第一支里（即出现在说明文案之前）
  return i > 0 && j > 0 && j < i
})())

// I7 CHANGELOG 与生成数据同步（生成器本身由 release-notes 契约验，这里只钉「别忘了重跑」）
check('I7 CHANGELOG 有 v3.9.2 段且写明 Linux 自 3.9.2 起',
  /## v3\.9\.2（2026-10-19）/.test(srcChangelog) && /Linux 版（deb，自 3\.9\.2 起）/.test(srcChangelog))
check('I7 负向：data.ts 已重跑（含 3.9.2 条目，不是停在上一版）',
  /"version": "3\.9\.2"/.test(srcReleaseData))

// ─────────────────────────────────────────────────────────────
const failed = checks.filter(c => !c.pass)
for (const c of checks) console.log(`${c.pass ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? '  -> ' + c.detail : ''}`)
console.log('\n========================================')
console.log(failed.length === 0
  ? `PASS —— ${checks.length}/${checks.length} 断言通过`
  : `FAIL —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)

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
const failed = checks.filter(c => !c.pass)
for (const c of checks) console.log(`${c.pass ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? '  -> ' + c.detail : ''}`)
console.log('\n========================================')
console.log(failed.length === 0
  ? `PASS —— ${checks.length}/${checks.length} 断言通过`
  : `FAIL —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)

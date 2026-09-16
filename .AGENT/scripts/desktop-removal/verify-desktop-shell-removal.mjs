// 契约验证：桌面外壳（磁贴工作台）已从 3.2.0 发版线整条剥离
//
// 为什么需要它：这次删除有三处「看起来同源、其实不同源」的陷阱，删错一个就出事 ——
//   ① `DayPanel` 的 `desktop-widget`（独立小窗形态）名字里也有 desktop，但**与磁贴工作台无关**；
//   ② `scripts/launch.js` 那批改动虽随桌面分支进来，实际是修 Windows「双击没反应」的启动器重构；
//   ③ `ai-teaching` 的禅模式按钮被删，是因为入口上移到了标题栏 —— 删了 UI 但能力必须在别处还在。
// 所以本脚本除「负向零残留」外，还钉死这三条保留面。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/desktop-removal/verify-desktop-shell-removal.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

const checks = []
const ok = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail })

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const stripOf = (p) => stripComments(read(p))

/* ---------------- 0. 守卫：别扫了个空目录还全绿 ---------------- */

const allFiles = walkSourceFiles(ROOT, {
  skip: (p) => /[\\/](node_modules|dist|out|tmp|\.git|dist-electron[^\f]*)[\\/]/.test(p),
})
const srcFiles = allFiles.filter((p) => p.includes(`${'src'}\\`) || p.includes('/src/'))
ok('守卫：扫描根可读且命中源码文件（防止扫空导致假绿）', srcFiles.length > 200, `扫到 ${srcFiles.length} 个源码文件`)

/* ---------------- 1. 负向：剥离物零残留 ---------------- */

// 已删的文件 / 目录
for (const d of ['src/modules/desktop', '.AGENT/scripts/desktop']) {
  ok(`已删目录不存在：${d}`, !existsSync(join(ROOT, d)))
}
for (const f of [
  'src/modules/desktop/index.tsx',
  'src/modules/desktop/layout.ts',
  'src/modules/desktop/tiles.tsx',
  'src/modules/desktop/useDesktopData.ts',
]) {
  ok(`已删文件不存在：${f}`, !existsSync(join(ROOT, f)))
}

// 标识符残留（剥注释后扫全仓）
const NEEDLES = [
  ['DesktopModule', '桌面模块组件'],
  ['useDesktopData', '桌面数据 hook'],
  ['DesktopPreset', '桌面布局预设类型'],
  ['TileLayout', '磁贴布局类型'],
  ['DESK_MODULES', '磁贴模块清单'],
  ['desktopPresets', '设置项：桌面布局预设'],
  ['desktopActivePreset', '设置项：当前桌面预设'],
  ["from './modules/desktop'", 'App 对桌面模块的 import'],
  ["case 'desktop'", 'App 的桌面 Tab 分支'],
  ["id: 'desktop'", '模块清单里的桌面项'],
]
// ⚠️ 排除脚本自身：NEEDLES 数组里就写着这些标识符，不排除会自证失败
const SELF = fileURLToPath(import.meta.url)
const haystack = allFiles.filter((p) => p !== SELF).map((p) => stripComments(readFileSync(p, 'utf8'))).join('\n')
for (const [needle, label] of NEEDLES) {
  const n = (haystack.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  ok(`残留为零：${label}（${needle}）`, n === 0, `命中 ${n} 次`)
}

// TabName 联合类型里不再有 desktop
const typesSrc = stripOf('src/types/index.ts')
ok('TabName 已不含 desktop', !/export type TabName =[^;\n]*'desktop'/.test(typesSrc))
ok('TabName 仍含 editor / aiTeaching 等 14 项', (typesSrc.match(/export type TabName =([^;\n]*)/)?.[1].match(/'/g) || []).length === 28,
  `实际引号数 ${(typesSrc.match(/export type TabName =([^;\n]*)/)?.[1].match(/'/g) || []).length}`)

// CSS 里 desk-* 令牌清零
ok('样式表已无 desk-* 令牌', !/desk-/.test(stripOf('src/styles/index.css')))

/* ---------------- 2. 正向：保留面（删前 grep 证明过不依赖被删项） ---------------- */

const daypanel = stripOf('src/daypanel/DayPanel.tsx')
const dayWin = stripOf('src/daypanel/DayPanelWindowApp.tsx')
const mainIdx = stripOf('electron/main/dayPanelWindow.ts')
const panelModes = (daypanel.match(/desktop-widget/g) || []).length
  + (dayWin.match(/desktop-widget/g) || []).length
  + (mainIdx.match(/desktop-widget/g) || []).length
ok('保留面①：DayPanel 的 desktop-widget 小窗形态完好（名字像但不同源，没被误删）', panelModes >= 3, `命中 ${panelModes} 处`)

const launch = stripOf('scripts/launch.js')
ok('保留面②：启动器重构仍在（spawnElectronVite，修 Windows「双击没反应」）', launch.includes('spawnElectronVite'))

const aiTeach = stripOf('src/modules/ai-teaching/index.tsx')
const titleBar = stripOf('src/components/shared/TitleBar.tsx')
ok('保留面③：禅模式入口已上移标题栏（本模块只消费档位）',
  aiTeach.includes('onZenLevelChange') && /布局|zenLevel/.test(titleBar),
  `aiTeach 有 onZenLevelChange=${aiTeach.includes('onZenLevelChange')} / TitleBar 有布局入口=${/布局|zenLevel/.test(titleBar)}`)

/* ---------------- 3. 正向：相邻能力未误伤 ---------------- */

const blogRepo = stripOf('electron/lib/kbStore/blogVaultRepo.ts')
ok('相邻未误伤：层级总结文件化仍在（summaries 目录）', blogRepo.includes('SUMMARY_DIR') || blogRepo.includes('summaries'))
ok('相邻未误伤：总结 IPC 通道仍在', (stripOf('electron/database/repositories/blogSummaryRepo.ts')).includes('blog:listSummaries'))
ok('相邻未误伤：总结文档视图仍在', existsSync(join(ROOT, 'src/modules/blog/views/SummaryDoc.tsx')))
ok('相邻未误伤：第 13 项打卡统计纯函数仍在', existsSync(join(ROOT, 'electron/lib/kbStore/habitStats.ts')))
ok('相邻未误伤：编辑器双态标签策略仍在', existsSync(join(ROOT, 'src/modules/editor/tabPolicy.ts')))
ok('相邻未误伤：DayPanel 四个 Tab 仍在',
  ['task', 'habit', 'pomo', 'nav'].every((t) => daypanel.includes(`'${t}'`)))

// 启动落点：桌面没了之后必须落到编辑器，绝不能回到「回收站」
const appMod = stripOf('src/lib/appModules.ts')
ok('启动兜底不再是桌面（改为编辑器）',
  /return 'editor'/.test(appMod) && !/return 'desktop'/.test(appMod))
ok('活动栏首位是编辑器（无人为插队）',
  /\{\s*id:\s*'editor'/.test(appMod.slice(0, 3000)) && !/unshift\('desktop'\)/.test(appMod))

/* ---------------- 输出 ---------------- */

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.pass || !c.detail ? '' : '  → ' + c.detail}`)
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${checks.length - failed}/${checks.length}`)
process.exit(failed === 0 ? 0 : 1)

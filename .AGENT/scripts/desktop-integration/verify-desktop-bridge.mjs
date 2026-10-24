// 契约：桌面集成阶段 1（D-Bus 核心通路 + 托盘 + CLI + deb 注入）
//
// 背景（2026-10-20）：A+B+C 形态已拍板，阶段 1 = C（托盘）+ 对外接口地基（D-Bus + CLI）。
// 本批只做核心通路：GetToday / ToggleTodo / CheckIn / OpenApp / Search / GetCapabilities；
// 番茄钟控制（PomodoroControl）留给下一批 —— 权威状态机在渲染层，需要下行命令通道。
//
// 覆盖：
//   ① daySnapshotPure 纯函数用例（去重 / 排序 / 时钟解析 / 番茄反推）
//   ② D-Bus 契约面：总线名 / 对象路径 / 接口版本 / 方法签名（与 interface.md 对齐）
//   ③ 写入口唯一性：托盘、D-Bus、IPC 共用 action；写后必须广播
//   ④ 打包注入：.service / CLI / StartupWMClass / afterRemove 的升级保护
//   ⑤ 负向：D-Bus 层不得直接写文件（只读 + action）
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/desktop-integration/verify-desktop-bridge.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))

// ===== ① 纯函数 =====
console.log('\n--- ① daySnapshotPure ---')
const {
  buildDaySnapshot,
  isAgendaTodo,
  parseClockSeconds,
  pomoFromSource,
} = await import('../../../src/lib/daySnapshotPure.ts')

check('12:34 → 754', parseClockSeconds('12:34') === 754)
check('1:02:03 → 3723', parseClockSeconds('1:02:03') === 3723)
check('坏输入 → 0', parseClockSeconds('ab:cd') === 0 && parseClockSeconds('') === 0)

const day = buildDaySnapshot({
  date: '2026-10-20',
  todos: [
    { id: 'done', title: '已办', status: 'done', date: '2026-10-20', sort_order: 0, created_at: 'a' },
    { id: 'b', title: '后办', status: 'pending', date: '2026-10-20', sort_order: 2, created_at: 'b' },
    { id: 'a', title: '先办', status: 'pending', date: '2026-10-20', sort_order: 1, created_at: 'c' },
    { id: 'a', title: '重复', status: 'pending', date: '2026-10-21', sort_order: 9, created_at: 'd' },
  ],
  habits: [
    { id: 'h1', name: '阅读', doneToday: true, streak: 3, target: 5 },
    { id: 'h2', name: '运动', doneToday: false, streak: 0, target: 3 },
  ],
  pomo: { visible: true, running: false, display: '12:30', progress: 0.5 },
})

check('★ 按 id 去重（先到先得）', day.todos.length === 3 && day.todos.filter(t => t.id === 'a').length === 1)
check('未完成排在已完成之前', day.todos[day.todos.length - 1].id === 'done')
check('同状态按 sort_order', day.todos[0].id === 'a' && day.todos[1].id === 'b')
check('Todo 字段映射', day.todos[0].text === '先办' && day.todos[0].due === '2026-10-20' && day.todos[0].quadrant === 1)
check('Habit 字段映射', day.habits[0].doneToday === true && day.habits[0].streak === 3 && day.habits[0].target === 5)
check('番茄：暂停态 = 2', day.pomo.state === 2, String(day.pomo.state))
check('番茄：leftSeconds = 750', day.pomo.leftSeconds === 750, String(day.pomo.leftSeconds))
check('番茄：totalSeconds 由 progress 反推 = 1500', day.pomo.totalSeconds === 1500, String(day.pomo.totalSeconds))
check('番茄不可见 → 全零', JSON.stringify(pomoFromSource({ visible: false, running: true, display: '25:00', progress: 0.2 })) === '{"state":0,"leftSeconds":0,"totalSeconds":0}')
check('番茄进行中 = 1', pomoFromSource({ visible: true, running: true, display: '10:00', progress: 0 }).state === 1)

// A 口径（2026-10-20 用户拍板）：今天到期 + 逾期未完成；不含待安排/已完成/子任务
const agenda = (date, status, task_type, parent_id = null) => ({ date, status, task_type, parent_id })
check('A：今天到期（含计划类）→ 收', isAgendaTodo(agenda('2026-10-20', 'pending', 'plan'), '2026-10-20'))
check('A：逾期非计划类 → 收', isAgendaTodo(agenda('2026-10-19', 'pending', 'deadline'), '2026-10-20'))
check('A：逾期计划类（待安排）→ 不收', !isAgendaTodo(agenda('2026-10-19', 'pending', 'plan'), '2026-10-20'))
check('A：未来日期的待安排 → 不收', !isAgendaTodo(agenda('2026-10-25', 'pending', 'plan'), '2026-10-20'))
check('A：已完成 → 不收', !isAgendaTodo(agenda('2026-10-20', 'done', 'plan'), '2026-10-20'))
check('A：子任务 → 不收', !isAgendaTodo(agenda('2026-10-20', 'pending', 'plan', 'p1'), '2026-10-20'))

// ===== ② D-Bus 契约面 =====
console.log('\n--- ② D-Bus 契约面 ---')
const svc = stripComments(read('electron/lib/desktopBridge/dbusService.ts'))
check('总线名（正式）', /DEFAULT_BUS_NAME\s*=\s*'io\.github\.lousync\.Phrontis'/.test(svc))
check('总线名（dev 后缀）', /DEV_BUS_NAME\s*=\s*'io\.github\.lousync\.Phrontis\.Dev'/.test(svc))
check('对象路径', /OBJECT_PATH\s*=\s*'\/io\/github\/lousync\/Phrontis'/.test(svc))
check('接口版本 Core1', /INTERFACE\s*=\s*'io\.github\.lousync\.Phrontis\.Core1'/.test(svc))
check('DO_NOT_QUEUE（不排队）', /NameFlag\.DO_NOT_QUEUE/.test(svc))

const signatures = {
  GetToday: "outSignature: '(sa(ssbsi)a(ssbii)(iii))'",
  ToggleTodo: "inSignature: 's', outSignature: 'b'",
  CheckIn: "inSignature: 'sb', outSignature: 'b'",
  OpenApp: "inSignature: 's', outSignature: 'b'",
  Search: "inSignature: 'si', outSignature: 'as'",
  ToggleDayPanel: "inSignature: '', outSignature: 'b'",
  GetCapabilities: "outSignature: 'as'",
}
for (const [name, sig] of Object.entries(signatures)) {
  check(`方法 ${name} 签名`, svc.includes(`${name}: {`) && svc.includes(sig))
}
check('Changed 信号（scope: s）', /Changed: \{ signature: 's' \}/.test(svc))
check('本批不含 PomodoroControl（阶段边界）', !/PomodoroControl/.test(svc))
check('能力表与实现一致（本批不含番茄控制）', /CAPABILITIES = \['today', 'todo', 'checkin', 'search', 'open', 'dayPanel'\]/.test(svc))

// ===== ③ 写入口唯一性 =====
console.log('\n--- ③ 写入口与广播 ---')
check('ToggleTodo 走 todoActions', /toggleTodoDone/.test(svc))
check('CheckIn 走 habitActions', /setHabitChecked/.test(svc))
check('ToggleTodo 写后广播 schedule', /broadcastDataChanged\('schedule'\)/.test(svc))
check('CheckIn 写后广播 habit', /broadcastDataChanged\('habit'\)/.test(svc))

const habitActions = stripComments(read('electron/lib/habitActions.ts'))
check('打卡推送在同一实现里', /notifyCheckin/.test(habitActions))
const checkinRepo = stripComments(read('electron/database/repositories/checkinRepo.ts'))
check('IPC 打卡也走同一实现', /toggleHabitChecked/.test(checkinRepo) && !/notifyCheckin/.test(checkinRepo))
const todoActions = stripComments(read('electron/lib/todoActions.ts'))
check('完成事件在 action 里', /schedule:todoCompleted/.test(todoActions))

const bus = stripComments(read('electron/main/windowBus.ts'))
check('windowBus 提供内部订阅', /export function subscribeDataChanged/.test(bus))
check('主进程广播也会通知订阅者', /emitDataChanged\(scope\)/.test(bus))
check('渲染层 notify 也会通知订阅者', /emitDataChanged\(\(payload as \{ scope: string \}\)\.scope\)/.test(bus))

// 托盘（2026-10-20 用户拍板）：只保留应用级动作（显示 / 任务栏模式 / 退出），
// 不承载今日区 —— 今日面板归 GNOME 扩展（顶栏入口），托盘菜单不再重复一份。
const main = stripComments(read('electron/main/index.ts'))
check('主进程挂载桌面桥', /initDesktopBridge\(\{ packaged: app\.isPackaged/.test(main))
check('托盘不挂今日区（用户拍板）', !/buildTodayMenuItems|日程小窗/.test(main))
check('托盘保留应用级动作', /label: '显示主窗口'/.test(main) && /label: '退出 Phrontis'/.test(main))
check('任务栏模式已从托盘移除（功能未完成）', !/任务栏模式/.test(main))

// ===== ④ 打包注入 =====
console.log('\n--- ④ deb 注入 ---')
const pkg = readJson('package.json')
const extra = JSON.stringify(pkg.build.extraResources ?? [])
check('extraResources 带 desktop-bridge', extra.includes('scripts/desktop-bridge'))
// 2026-10-20 校正：DBusActivatable 要求桌面文件名 = D-Bus 名（reverse-DNS），
// 本项目的桌面文件是 phrontis.desktop、总线名是 io.github.lousync.Phrontis —— 写了也无效，
// 且会让 GNOME 尝试激活不存在的 `phrontis` 服务。D-Bus 激活由 postinst 的独立 .service 承担。
check('不写无效的 DBusActivatable', !('DBusActivatable' in (pkg.build.linux?.desktop?.entry ?? {})))
check('StartupWMClass 与运行时 WM_CLASS（res_class）一致',
  pkg.build.linux?.desktop?.entry?.StartupWMClass === 'knowbase')
// ★ 不能为了桌面显示名去 app.setName('Phrontis')：Electron 的 safeStorage 在 Linux 上
//   按 app.name 找钥匙串条目，改名 = 存量 API Key / 密码本全部解不开（2026-10-20 实测）。
check('主进程不得改 app.name（safeStorage 钥匙串按它分段）',
  !/app\.setName\(\s*['"]Phrontis['"]\s*\)/.test(stripComments(read('electron/main/index.ts'))))
check('deb.afterRemove 已登记', pkg.build.deb?.afterRemove === 'build/linux-after-remove.sh')

const afterInstall = read('build/linux-after-install.sh')
check('安装 .service', /usr\/share\/dbus-1\/services\/io\.github\.lousync\.Phrontis\.service/.test(afterInstall))
check('按宏重写 Exec', /Exec=\/opt\/\$\{sanitizedProductName\}\/\$\{executable\} --ozone-platform=x11/.test(afterInstall))
check('安装 CLI 到 /usr/bin/phrontis-cli', /\/usr\/bin\/phrontis-cli/.test(afterInstall))
check('不覆盖 GUI 的 /usr/bin/phrontis', !/^\s*install\s[^\n]*\/usr\/bin\/\$\{executable\}/m.test(afterInstall))

const afterRemove = read('build/linux-after-remove.sh')
check('卸载清理 .service', /rm -f \/usr\/share\/dbus-1\/services\/io\.github\.lousync\.Phrontis\.service/.test(afterRemove))
check('升级时不删（upgrade 直接退出）', /upgrade\|failed-upgrade/.test(afterRemove))

const serviceFile = read('scripts/desktop-bridge/io.github.lousync.Phrontis.service')
check('.service 的 Name 与接口一致', /^Name=io\.github\.lousync\.Phrontis$/m.test(serviceFile))
check('.service 的 Exec 指向 /opt', /^Exec=\/opt\/Phrontis\/phrontis/m.test(serviceFile))

// 打包期防线（2026-10-20 实测过一次 app.asar 静默错位：dev 进程还在写 out/）
const packScript = stripComments(read('scripts/pack.mjs'))
check('打包后校验 app.asar 自洽', /verifyPackedAsar\(asarPath\)/.test(packScript))
check('校验失败以 exit 4 中止（不静默）', /process\.exit\(4\)/.test(packScript))

// ===== ⑤ 负向 =====
console.log('\n--- ⑤ 负向断言 ---')
check('D-Bus 层不直接写文件', !/writeFile|writeJson|vaultUpdateTodo|vaultHabitsSave/.test(svc))
check('CLI 不直接写文件', !/writeFile|appendFile/.test(read('scripts/desktop-bridge/phrontis.cjs')))
check('渲染层不接触绝对路径（CLI 只拿 relPath）', !/readFileSync/.test(read('scripts/desktop-bridge/phrontis.cjs')))

console.log(pass ? '\nPASS —— 全部通过' : '\nFAIL —— 有用例未通过')
process.exit(pass ? 0 : 1)

#!/usr/bin/env node
/*
 * Phrontis 命令行（桌面集成阶段 1）
 *
 * 由 `phrontis` 壳脚本以「Electron 的 node 模式」启动（不依赖系统 node）：
 *   ELECTRON_RUN_AS_NODE=1 /opt/Phrontis/phrontis /usr/lib/phrontis/phrontis.cjs today
 *
 * 传输层：`busctl --user --json=short call`（systemd 自带；GNOME 桌面必有）。
 * 为什么不用 node-dbus：CLI 要能在**应用没开**时也给出清楚报错，不该为了几条命令
 * 再往安装包塞一份 D-Bus 依赖；busctl 的 JSON 输出刚好够用。
 *
 * 契约：phrontis-desktop-integration/docs/interface.md（Core1）。
 */

'use strict'

const { execFileSync } = require('child_process')

const BUS = process.env.PHRONTIS_BUS_NAME || 'io.github.lousync.Phrontis'
const OBJ = '/io/github/lousync/Phrontis'
const IFACE = 'io.github.lousync.Phrontis.Core1'

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

function call(method, signature, args) {
  const argv = ['--user', '--json=short', 'call', BUS, OBJ, IFACE, method]
  if (signature) argv.push(signature, ...args)
  let out
  try {
    out = execFileSync('busctl', argv, { encoding: 'utf8' })
  } catch (e) {
    const err = String(e.stderr || e.message || '')
    if (/not provided|UnknownService|No such file|not been provided/i.test(err)) {
      die('Phrontis 没有在运行（或桌面集成未启用）。先启动应用，再试。', 1)
    }
    if (/ENOENT/.test(err)) die('找不到 busctl（systemd 自带，请确认系统完整性）。', 1)
    die(`调用失败：${err.trim() || '未知错误'}`, 1)
  }
  try {
    return JSON.parse(out).data || []
  } catch {
    die('busctl 返回的不是合法 JSON（版本过旧？）', 1)
  }
}

function getToday() {
  const data = call('GetToday')
  const day = data[0]
  if (!Array.isArray(day) || day.length !== 4) die('GetToday 返回结构异常', 1)
  const [date, todos, habits, pomo] = day
  return {
    date,
    todos: todos.map(([id, text, done, due, quadrant]) => ({ id, text, done, due, quadrant })),
    habits: habits.map(([id, name, doneToday, streak, target]) => ({ id, name, doneToday, streak, target })),
    pomo: { state: pomo[0], leftSeconds: pomo[1], totalSeconds: pomo[2] },
  }
}

function clock(seconds) {
  const s = Math.max(0, Math.trunc(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function printToday(day) {
  const done = day.todos.filter(t => t.done).length
  console.log(day.date)
  console.log(`待办 ${done}/${day.todos.length}`)
  for (const t of day.todos) console.log(`  ${t.done ? '[x]' : '[ ]'} ${t.text}`)
  const hd = day.habits.filter(h => h.doneToday).length
  console.log(`打卡 ${hd}/${day.habits.length}`)
  for (const h of day.habits) {
    console.log(`  ${h.doneToday ? '[x]' : '[ ]'} ${h.name}${h.streak > 0 ? ` · 连续 ${h.streak} 天` : ''}`)
  }
  if (day.pomo.state !== 0) {
    console.log(`番茄 ${day.pomo.state === 1 ? '进行中' : '已暂停'} ${clock(day.pomo.leftSeconds)}`)
  }
}

function resolveHabit(day, key) {
  const exact = day.habits.find(h => h.id === key)
  if (exact) return exact
  const byName = day.habits.filter(h => h.name === key)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) die(`有 ${byName.length} 个同名习惯，请改用 id：${byName.map(h => h.id).join(', ')}`, 2)
  die(`找不到习惯：${key}`, 2)
}

function usage() {
  console.log(`Phrontis CLI

用法：
  phrontis-cli today [--json]
  phrontis-cli todo toggle <id>
  phrontis-cli todo done <id> | undo <id>
  phrontis-cli checkin <习惯名|id> | uncheck <习惯名|id>
  phrontis-cli search <关键词> [--limit N] [--json]
  phrontis-cli open [today|pomodoro]
  phrontis-cli daypanel
  phrontis-cli capabilities [--json]

环境：
  PHRONTIS_BUS_NAME  覆盖 D-Bus 总线名（dev 用 io.github.lousync.Phrontis.Dev）
`)
}

function main(argv) {
  const args = argv.slice(2)
  const json = args.includes('--json')
  const positional = args.filter(a => !a.startsWith('--'))
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const cmd = positional[0]

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return }

  if (cmd === 'today') {
    const day = getToday()
    if (json) console.log(JSON.stringify(day, null, 2))
    else printToday(day)
    return
  }

  if (cmd === 'capabilities') {
    const data = call('GetCapabilities')
    const caps = data[0] || []
    console.log(json ? JSON.stringify(caps) : caps.join('\n'))
    return
  }

  if (cmd === 'todo') {
    const action = positional[1]
    const id = positional[2]
    if (!action || !id) die('用法：phrontis todo toggle|done|undo <id>', 1)
    if (action === 'toggle') {
      const data = call('ToggleTodo', 's', [id])
      if (!data[0]) die(`找不到待办或更新失败：${id}`, 2)
      console.log('已翻转')
      return
    }
    if (action === 'done' || action === 'undo') {
      const day = getToday()
      const t = day.todos.find(x => x.id === id)
      if (!t) die(`找不到待办：${id}`, 2)
      const want = action === 'done'
      if (t.done === want) { console.log(want ? '已经是完成状态' : '已经是未完成状态'); return }
      const data = call('ToggleTodo', 's', [id])
      if (!data[0]) die('更新失败', 2)
      console.log(want ? '已完成' : '已取消完成')
      return
    }
    die('用法：phrontis todo toggle|done|undo <id>', 1)
  }

  if (cmd === 'checkin' || cmd === 'uncheck') {
    const key = positional[1]
    if (!key) die(`用法：phrontis ${cmd} <习惯名|id>`, 1)
    const habit = resolveHabit(getToday(), key)
    const value = cmd === 'checkin'
    const data = call('CheckIn', 'sb', [habit.id, value ? 'true' : 'false'])
    if (!data[0]) die('打卡失败（习惯可能已被删除）', 2)
    console.log(`${value ? '已打卡' : '已取消打卡'}：${habit.name}`)
    return
  }

  if (cmd === 'search') {
    const q = positional[1]
    if (!q) die('用法：phrontis search <关键词> [--limit N]', 1)
    const limit = Math.max(1, Math.min(50, Number(flag('--limit')) || 20))
    const data = call('Search', 'si', [q, String(limit)])
    const rows = data[0] || []
    console.log(json ? JSON.stringify(rows) : rows.join('\n'))
    return
  }

  if (cmd === 'daypanel') {
    const data = call('ToggleDayPanel')
    if (!data[0]) die('切换日程小窗失败', 2)
    console.log('已切换日程小窗')
    return
  }

  if (cmd === 'open') {
    const target = positional[1] || ''
    const data = call('OpenApp', 's', [target])
    if (!data[0]) die('打开失败（该目标暂不支持）', 2)
    console.log('已唤起 Phrontis')
    return
  }

  die(`未知命令：${cmd}\n运行 phrontis-cli --help 查看用法`, 1)
}

main(process.argv)

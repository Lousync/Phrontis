/**
 * 一次性探针：实测本机（Windows）Node `fs.watch({ recursive: true })` 的真实行为。
 *
 * 为什么留它：v3.2.0 条目 ④ 的整套设计押在三条平台事实上 ——
 *   ① `recursive` 可用（不抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）；
 *   ② 回调拿到的 `filename` 是**仓库根相对路径**（含深层子目录的完整相对路径）；
 *   ③ 原子写（临时文件 + rename 覆盖）会成对产生事件 → 所以自写抑制与 `.kb-tmp-*` 忽略是必需的。
 * 这三条一旦变动（Electron/Node 升级、换平台），实现里的忽略规则与自写抑制就要重新审。
 * 跑一遍即可核对，不必去读代码猜。
 *
 * 运行：node .AGENT/scripts/editor/probes/probe-fs-watch-recursive.cjs
 * 输出：JSON（recursive 可用性 + 事件序列）；探针目录跑完自动删除。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), `phrontis-watch-probe-${Date.now()}`)
fs.mkdirSync(root, { recursive: true })

const log = []
const record = (eventType, filename) => {
  log.push({ event: eventType, filename: filename == null ? null : String(filename) })
}

let watcher
try {
  watcher = fs.watch(root, { recursive: true })
} catch (e) {
  console.log(JSON.stringify({ recursiveAvailable: false, error: e.message }, null, 2))
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
watcher.on('change', record)
watcher.on('error', (e) => log.push({ event: 'ERROR', filename: e.message }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const d1 = path.join(root, 'notes')
  fs.mkdirSync(d1)
  await sleep(150)

  const d2 = path.join(d1, 'deep')
  fs.mkdirSync(d2)
  await sleep(150)

  // ① 深层子目录内新建文件 —— filename 是否带完整相对路径？
  fs.writeFileSync(path.join(d2, 'a.md'), 'x')
  await sleep(150)

  // ② 原子写（临时文件 + rename 覆盖，等价 writeWorkspaceFile 的手法）
  const target = path.join(d2, 'a.md')
  const tmp = path.join(d2, '.kb-tmp-abc')
  fs.writeFileSync(tmp, 'y')
  fs.renameSync(tmp, target)
  await sleep(150)

  // ③ .knowbase 内部写入 —— 事件照样会来（证明忽略规则必须自己过滤，不能指望平台不发）
  const kb = path.join(root, '.knowbase')
  fs.mkdirSync(kb, { recursive: true })
  await sleep(150)
  fs.writeFileSync(path.join(kb, 'x.json'), 'z')
  await sleep(150)

  // ④ 目录重命名 + 文件删除
  fs.renameSync(d2, path.join(d1, 'deep2'))
  await sleep(150)
  fs.unlinkSync(path.join(d1, 'deep2', 'a.md'))
  await sleep(300)

  watcher.close()
  fs.rmSync(root, { recursive: true, force: true })
  console.log(JSON.stringify({ recursiveAvailable: true, probeRoot: root, events: log }, null, 2))
})()

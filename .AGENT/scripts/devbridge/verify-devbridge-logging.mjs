// 契约验证：日志噪声治理（docs/pending-fixes.md B-19 —— 退出书籍刷 ~266 条 RO 环告警）。
//
// 覆盖（全部是**源码级**断言：capture.ts 顶层 import electron，Node 里跑不起来）：
//   ① capture.ts：recordLog **折叠紧邻同消息**（count 累加 + lastTs 刷新），
//      且只折叠紧邻（不同消息穿插时照常各记一条）；LogItem 带 count / lastTs 字段
//   ② capture.ts：aggregateErrors 认折叠口径（count / lastTs 都得算进去，否则聚合数会缩水）
//   ③ main/index.ts：console-message 转发**按消息去重限流**，且**不是整条静音**（仍有一次放行
//      + 被压条数可见）
//   ④ main/index.ts：did-fail-load 判主帧（子帧的 ERR_ABORTED 是有意取消，不是窗口故障）
//
// 为什么值得单独锁：这批修复的效果「不报错」——没有断言的话，后人把去重删掉不会有任何反馈，
// 而 B-19 的代价（266 条刷屏把 500 条日志环挤爆、吃掉同段其它证据）已经实际发生过一次。
//
// 运行（项目根目录）：
//   node .AGENT/scripts/devbridge/verify-devbridge-logging.mjs

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const readNoComments = (p) => stripComments(read(p))

// ===== ① recordLog：紧邻同消息折叠 =====
console.log('\n--- ① capture.ts：recordLog 折叠紧邻重复 ---')
{
  const src = readNoComments('electron/devbridge/capture.ts')
  const i = src.indexOf('export function recordLog')
  const next = src.indexOf('\nexport ', i + 10)
  const body = i > -1 ? src.slice(i, next > -1 ? next : i + 2000) : ''

  check('recordLog 存在', i > -1)
  check('★ 折叠判据含 scope / level / message 三项', /lastLogItem\.scope === scope/.test(body) && /lastLogItem\.level === level/.test(body) && /lastLogItem\.message === msg/.test(body))
  check('★ 折叠时累加 count', /count = \(lastLogItem\.count \?\? 1\) \+ 1/.test(body))
  check('★ 折叠时刷新 lastTs', /lastLogItem\.lastTs = new Date\(\)\.toISOString\(\)/.test(body))
  check('★ 折叠时不新占条目（折叠分支提前 return）', /\{\s*lastLogItem\.count[\s\S]{0,200}?return\s*\n?\s*\}/.test(body))
  check('非折叠路径仍走 logRing.push 并带 count 初值 1', /logRing\.push\(\{[^}]*count: 1/.test(body))
  check('首现时间不被覆盖（ts 由 Ring.push 定，折叠分支只动 lastTs）', !/lastLogItem\.ts\s*=/.test(body))

  const iface = src.slice(src.indexOf('export interface LogItem'), src.indexOf('export interface LogItem') + 400)
  check('LogItem 声明 count 字段', /count\?: number/.test(iface))
  check('LogItem 声明 lastTs 字段', /lastTs\?: string/.test(iface))
}

// ===== ② aggregateErrors：认折叠口径 =====
console.log('\n--- ② capture.ts：aggregateErrors 认 count / lastTs ---')
{
  const src = readNoComments('electron/devbridge/capture.ts')
  const i = src.indexOf('export function aggregateErrors')
  const next = src.indexOf('\nexport ', i + 10)
  const body = i > -1 ? src.slice(i, next > -1 ? next : i + 3000) : ''
  check('aggregateErrors 存在', i > -1)
  check('★ 累加用 item.count ?? 1（否则折叠掉的条数会丢）', /existing\.count \+= item\.count \?\? 1/.test(body))
  check('★ lastTs 取 item.lastTs ?? item.ts', /existing\.lastTs = item\.lastTs \?\? item\.ts/.test(body))
  check('新建项也用 count / lastTs 口径', /count: item\.count \?\? 1/.test(body) && /lastTs: item\.lastTs \?\? item\.ts/.test(body))
}

// ===== ③ console-message 转发去重限流 =====
console.log('\n--- ③ main/index.ts：渲染层日志转发去重限流 ---')
{
  const src = readNoComments('electron/main/index.ts')
  const i = src.indexOf("on('console-message'")
  const body = i > -1 ? src.slice(i, i + 1400) : ''
  check('console-message 处理器存在', i > -1)
  check('★ 仍转发（不整条静音）', /console\.error\('\[Renderer\]'/.test(body))
  check('★ 有去重窗口常量', /RENDERER_LOG_WINDOW_MS/.test(body))
  check('★ 窗口内同键只放行一次（suppressed 累加 + 提前 return）', /prev\.suppressed \+= 1/.test(body) && /prev\.suppressed \+= 1[\s\S]{0,40}return/.test(body))
  check('★ 被压条数可见（折叠计数回显，不是静默丢弃）', /条同类已折叠/.test(body))
  check('键含来源与消息体（同消息不同来源不误折叠）', /\$\{sourceId\}:\$\{message\}/.test(body))
  check('有防无界增长回收（size 上限 + 过期清理）', /rendererLogSeen\.size > \d+/.test(body) && /rendererLogSeen\.delete\(k\)/.test(body))
  check('level 门槛仍在（< 2 不转发）', /level < 2\) return/.test(body))
}

// ===== ④ did-fail-load 判主帧 =====
console.log('\n--- ④ main/index.ts：did-fail-load 主帧判据 ---')
{
  const src = readNoComments('electron/main/index.ts')
  const i = src.indexOf("on('did-fail-load'")
  const body = i > -1 ? src.slice(i, i + 600) : ''
  check('did-fail-load 处理器存在', i > -1)
  check('★ 取了 isMainFrame 形参', /isMainFrame/.test(body))
  check('★ 子帧直接 return（书籍内容帧的 ERR_ABORTED 属有意取消）', /if \(!isMainFrame\) return/.test(body))
  check('主帧仍报错', /console\.error\('\[Window\] did-fail-load:'/.test(body))
}

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)

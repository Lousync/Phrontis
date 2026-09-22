/**
 * 契约验证：跨窗口数据同步的订阅扇出（B-20，2026-09-22）。
 *
 * 为什么需要它：
 *   改前 `preload.onDataChanged` **每调一次就 `ipcRenderer.on(...)` 一次**，而 `useDataChanged`
 *   全仓有 38 个调用点（工作台左右栏 / 各 widget / 阅读器 / 书架 / 知识库面板…）⇒ 订阅者数
 *   = 同屏挂载数，稳态就十几个，而**沙箱里 ipcRenderer 的上限是 10** ⇒ 每次会话必刷
 *   `MaxListenersExceededWarning: 11 kb:data-changed listeners added`。
 *   这条告警的**唯一价值**是「谁忘了退订」，可它被常态噪声占满后就再也认不出来 ——
 *   B-20 的修法（单点扇出）把常态噪声清零，代价是**electron 自己那条告警也一起没了**。
 *   ⇒ 于是这里必须补上人工防线：既锁住「ipc 上只有一个监听者」，也锁住扇出的行为语义
 *   （广播一次 = 每个订阅者各收到一次、退订真的摘掉、单个订阅者抛错不牵连其余）。
 *   这些性质**静态看不出来**：写成 `for (const cb of dataChangedSubs)` 直接遍历 Set，
 *   回调里退订就会静默漏掉后面的订阅者（表象是「AI 说改好了、界面没反应」那一类）。
 *
 * 做法（与 verify-resizable-panel.mjs 同范式）：从 `electron/preload/index.ts` 里**切出真实的
 *   扇出实现**（`dataChangedSubs` 那一段 + `onDataChanged` 属性体，大括号计数切片 →
 *   stripTypeScriptTypes 剥类型 → 临时 .mjs import），只 stub `ipcRenderer` 与 `console`。
 *   验的是真实行为，不是复刻的判定逻辑。
 *
 * 运行（项目根目录）：
 *   node --no-warnings .AGENT/scripts/shared/verify-data-changed.mjs
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

// ★ 仓库根按**脚本自身位置**解析，不写死绝对路径（同 verify-workbench-shell 的口径）：
//   写死会把「在 worktree 里跑」变成「静默校验主仓」—— 全绿而实际改的是另一棵树。
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
const fails = []
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); return true }
  fails.push(label + (detail ? `  → ${detail}` : ''))
  console.log(` FAIL  ${label}${detail ? `  → ${detail}` : ''}`)
  return false
}

/** 从 `start` 起找 `=> {`，再按大括号计数切出函数体（含首尾花括号） */
function sliceArrowBodyAfter(src, anchor) {
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`切片锚点未命中: ${anchor}`)
  const arrow = src.indexOf('=> {', i)
  if (arrow < 0) throw new Error(`锚点后没有 => { : ${anchor}`)
  const open = src.indexOf('{', arrow)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(open, j + 1)
    }
  }
  throw new Error(`函数体未闭合: ${anchor}`)
}

// ------------------------------------------------------------------ 静态面
const preload = read('electron/preload/index.ts')
const dataChangedTs = read('src/lib/dataChanged.ts')
const typesTs = read('src/types/index.ts')

const onCallCount = (preload.match(/ipcRenderer\.on\('kb:data-changed'/g) || []).length
check('① `ipcRenderer.on(\'kb:data-changed\')` 在 preload 里只出现 1 处（单点扇出，不再按订阅者注册）',
  onCallCount === 1, `实际 ${onCallCount} 处`)
check('② 那一处在 wireDataChanged() 内且带 dataChangedWired 幂等守卫',
  /function wireDataChanged\(\)[\s\S]{0,200}if \(dataChangedWired\) return/.test(preload))
check('③ onDataChanged 不再自己挂 ipc 监听（改为进 Set）',
  /onDataChanged:[\s\S]{0,400}?dataChangedSubs\.add\(cb\)/.test(preload) &&
  !/onDataChanged:[\s\S]{0,400}?ipcRenderer\.on\(/.test(preload))
check('④ 返回的退订函数真的从 Set 里摘（真泄漏防线）',
  /dataChangedSubs\.delete\(cb\)/.test(preload))
check('⑤ 订阅者软上限的提示只提示一次（不变成新的常态噪声）',
  /dataChangedLeakWarned/.test(preload) && /!dataChangedLeakWarned && dataChangedSubs\.size >/.test(preload))

// 渲染侧接线：useDataChanged 的 cleanup 必须退订（漏了就是真泄漏，而 electron 那条告警已被扇出消掉）
check('⑥ useDataChanged 的 effect cleanup 里仍调用 offPush?.()（漏了 = 只增不减）',
  /return \(\) => \{[\s\S]{0,200}?offPush\?\.\(\)/.test(dataChangedTs))
check('⑦ useDataChanged 同时摘掉本窗口的 window 监听（不留半条）',
  /removeEventListener\('kb:data-changed', local\)/.test(dataChangedTs))
check('⑧ preload 暴露的 onDataChanged 签名仍返回退订函数（渲染侧类型契约）',
  /onDataChanged: \(cb: \(payload: \{ scope: string \}\) => void\) => \(\) => void/.test(typesTs))

// ------------------------------------------------------------------ 行为面
const helperStart = preload.indexOf('const dataChangedSubs')
const helperEnd = preload.indexOf('const api = {')
if (helperStart < 0 || helperEnd < 0 || helperEnd < helperStart) {
  console.error('无法定位 preload 里的扇出实现块（dataChangedSubs … const api = {）')
  process.exit(2)
}
const helper = preload.slice(helperStart, helperEnd)
const onDataChangedBody = sliceArrowBodyAfter(preload, 'onDataChanged: (cb:')

const harness = stripTypeScriptTypes(
  `
let warnCalls = []
const console = { warn: (...a) => { warnCalls.push(a.map(String).join(' ')) } }
const listeners = new Map()
const ipcRenderer = {
  on(ch, h) {
    if (!listeners.has(ch)) listeners.set(ch, [])
    listeners.get(ch).push(h)
  },
  removeListener(ch, h) {
    const arr = listeners.get(ch) || []
    const i = arr.indexOf(h)
    if (i >= 0) arr.splice(i, 1)
  },
}
${helper}
export const api = {
  onDataChanged: (cb: (payload: { scope: string }) => void) => {${onDataChangedBody}},
  listenerCount: (ch) => (listeners.get(ch) || []).length,
  emit: (payload) => { for (const h of [...(listeners.get('kb:data-changed') || [])]) h({}, payload) },
  subCount: () => dataChangedSubs.size,
  warns: () => warnCalls,
  reset: () => { warnCalls = []; dataChangedSubs.clear() },
}
`,
  { mode: 'transform' }
)

const tmpDir = path.join(ROOT, 'tmp', 'verify-data-changed')
fs.mkdirSync(tmpDir, { recursive: true })
const tmpFile = path.join(tmpDir, `dc-${Date.now().toString(36)}.mjs`)
fs.writeFileSync(tmpFile, harness, 'utf8')
const { api } = await import(pathToFileURL(tmpFile).href)

// ⑨ ★ B-20 本体：12 个订阅者（正是原告警报的数）→ ipc 上仍只有 1 个监听者
api.reset()
const got = []
const offs = []
for (let i = 1; i <= 12; i++) {
  const me = i
  offs.push(api.onDataChanged((p) => got.push(`${me}:${p.scope}`)))
}
check('⑨ ★ 12 个订阅者（原告警的触发数，> 上限 10）→ ipc 监听者仍为 1',
  api.listenerCount('kb:data-changed') === 1, `实际 ${api.listenerCount('kb:data-changed')}`)
check('⑩ 订阅者全部登记在案', api.subCount() === 12, `实际 ${api.subCount()}`)

// ⑪ 广播一次 → 每个订阅者恰好各收到一次（顺序稳定）
got.length = 0
api.emit({ scope: 'knowledge' })
check('⑪ 广播一次 = 12 个订阅者各收到一次（不重复、不遗漏）',
  got.length === 12 && new Set(got).size === 12, `实际收到 ${got.length} 次 / ${new Set(got).size} 个不同`)

// ⑫ 退订真的摘掉：退掉中间那个（模拟组件卸载）→ 后续广播不再到它
got.length = 0
offs[5]()                       // 第 6 个（下标 5）退订
api.emit({ scope: 'knowledge' })
check('⑫ 退订者不再收到后续广播，其余 11 个照收',
  got.length === 11 && !got.includes('6:knowledge'), `实际 ${got.length} 次，含退订者=${got.includes('6:knowledge')}`)
check('⑬ 退订后 ipc 监听者数不变（仍是 1，不是 0）',
  api.listenerCount('kb:data-changed') === 1, `实际 ${api.listenerCount('kb:data-changed')}`)

// ⑭ 单个订阅者抛错不牵连其余（遍历副本 + try 包裹）
got.length = 0
api.onDataChanged(() => { throw new Error('订阅者内部炸了') })
api.emit({ scope: 'readerState' })
check('⑭ 单个订阅者抛错不影响其余订阅者收到本次广播',
  got.includes('1:readerState') && got.includes('12:readerState'), JSON.stringify(got.slice(0, 4)))

// ⑮ 越过软上限才提示，且只提示一次
api.reset()
for (let i = 0; i < 51; i++) api.onDataChanged(() => {})
check('⑮ 订阅者越过软上限 → 提示 1 次（且只有 1 次，不刷屏）',
  api.warns().length === 1, `实际 ${api.warns().length} 次：${JSON.stringify(api.warns())}`)
check('⑯ 稳态十几个订阅者 → 零提示（常态零噪声，这是本色修法的意义）',
  (() => { api.reset(); for (let i = 0; i < 20; i++) api.onDataChanged(() => {}); return api.warns().length === 0 })())

try { fs.unlinkSync(tmpFile) } catch { /* 尽力清理 */ }

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) {
  console.log(fails.map((f) => ' - ' + f).join('\n'))
  process.exit(1)
}

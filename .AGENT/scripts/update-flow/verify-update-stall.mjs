/**
 * 契约验证：应用更新的「下载进度口径 / 慢通道看门狗 / 通道阶段协议」。
 *
 * 为什么需要它：
 *   v3.1.2 报障「卡在 100% 一动不动」是三条缺陷叠加 ——
 *     ① 进度口径 = Math.round + 「只在整数百分比变化时才推事件」→ 最后一格（真实 99.5%~100%）
 *        内界面彻底冻结，一个事件都不再发；
 *     ② 慢速看门狗比较的是「全程累计字节」而非「窗口增量」→ 首个窗口收过 2MB（正常起步必然
 *        满足）之后永远判不出卡死；
 *     ③ 全链没有超时 → 通道挂在「不回字节也不断开」时 pipeline 永不 settle、downloading 恒为 true。
 *   三条都属于「不报错，只是永远等下去」的静默缺陷，重构时极易被写回去。
 *   另外「通道阶段」这条协议横跨 4 个文件（主进程广播表 / preload / ipc 封装 / 类型声明），
 *   改一处漏三处同样是不报错的静默失效 —— 所以一并纳入回归。
 *
 * 做法（与 verify-snooze-persist.mjs 一致）：从 electron/lib/updateService.ts 切出**真实实现**
 *   （stripTypeScriptTypes 剥类型 → 写临时 .mjs → import），只把 net.fetch 与 broadcast
 *   换成替身；验的是真实 downloadOne，不是复刻品。
 *
 * 运行（项目根目录，无需 --experimental-strip-types）：
 *   node --no-warnings .AGENT/scripts/update-flow/verify-update-stall.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 *
 * 注：看门狗用例把 SLOW_WINDOW_MS 按比例缩小到 1000ms（「前 3MB 迸发后静默」用真实 15s
 *     需要连续两个窗口共 30s 才判得出，测试太慢），SLOW_MIN_BYTES 与其余逻辑原样取自源码；
 *     正常路径用例用的是**未打补丁的真实常量**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const SRC_UPDATE = path.join(ROOT, 'electron/lib/updateService.ts')
const src = fs.readFileSync(SRC_UPDATE, 'utf8')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

// ---------------------------------------------------------------- 静态协议检查
const readIfExists = (rel) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}
const windowBus = readIfExists('electron/main/windowBus.ts')
const preload = readIfExists('electron/preload/index.ts')
const ipcLib = readIfExists('src/lib/ipc.ts')
const typeDecl = readIfExists('src/types/index.ts')
const store = readIfExists('src/lib/updateStore.ts')

check('广播表声明 updateDownloadStage 通道',
  /updateDownloadStage:\s*'update:download-stage'/.test(windowBus))
check('preload 订阅 update:download-stage',
  /ipcRenderer\.on\('update:download-stage'/.test(preload))
check('ipc.ts 导出 onUpdateDownloadStage 封装',
  /export const onUpdateDownloadStage\b/.test(ipcLib))
check('types/index.ts 声明 onUpdateDownloadStage',
  /onUpdateDownloadStage:/.test(typeDecl))
check('updateStore 订阅阶段事件',
  /onUpdateDownloadStage\(/.test(store))
check('两侧 UpdateFailReason 均含 stalled',
  /'stalled'/.test(src) && /'stalled'/.test(store))
check('updateStore 导出 updateStageText（校验中/换镜像文案唯一源）',
  /export function updateStageText\b/.test(store))
check('坏节点 cdn.gh-proxy.com 已摘出候选镜像',
  !sliceConst(src, 'FALLBACK_MIRRORS').includes('cdn.gh-proxy.com'))
check('进度口径不再依赖整数百分比变化（无 lastPct / Math.round(done）',
  !src.includes('lastPct') && !src.includes('Math.round(done'))
check('进度百分比在校验通过前锁 99%',
  /Math\.min\(99,\s*Math\.floor\(/.test(src))
check('看门狗按窗口增量判定（received - windowStart）',
  /const seen = received - windowStart/.test(src))
check('阶段切换在候选通道循环里发出（switched → switching）',
  /pushStage\(switched \? 'switching' : 'downloading'\)/.test(src))
// 镜像巡检口径（2026-09-15 二次修复）：基准 = 设置值的归一化，而不是「当前候选走不走镜像」。
// 判「定义已删」而不是全文 includes —— 修复说明的注释里仍然会提到旧函数名。
check('逐候选前缀推导已删除（mirrorPrefixOf 定义不存在）', !/function mirrorPrefixOf/.test(src))
check('镜像基准归一化：直连 null 与显式空串同口径', /return resolveMirror\(\) \?\? ''/.test(src))
check('镜像巡检比的是「下载开始时的基准」', /if \(mirrorKey\(\) !== mirrorAtStart\)/.test(src))
check('调用点传基准而不再传候选前缀', /partialSize\(dest\), mirrorAtStart\)/.test(src))
check('基准在每轮重算候选时重新捕获', /const mirrorAtStart = mirrorKey\(\)/.test(src))

// ---------------------------------------------------------------- 切出真实实现
/** 按大括号配平切出完整块（从 token 起），能处理 class / 多行函数 */
function sliceBraced(text, token) {
  const from = text.indexOf(token)
  if (from < 0) throw new Error(`未找到 ${token}`)
  const bodyAt = text.indexOf('{', from)
  if (bodyAt < 0) throw new Error(`${token} 没有块起始大括号`)
  let depth = 0
  for (let j = bodyAt; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}') {
      depth--
      if (depth === 0) return text.slice(from, j + 1)
    }
  }
  throw new Error(`${token} 大括号未配平`)
}

/**
 * 切出 `async function name(...) {...}`。
 * 注意不能直接拿 sliceBraced 的返回长度去加：那个返回是从**大括号**起算的，
 * 而参数表 ')' 与大括号之间还有返回类型（`: Promise<void> `），少加这段就会把函数尾部切掉一截
 * （切出来的仍是合法前缀、不报错，只是函数体中途断掉，非常难查）。所以按大括号的绝对位置 + 块长算。
 */
function sliceFn(text, token) {
  const from = text.indexOf(token)
  if (from < 0) throw new Error(`未找到 ${token}`)
  let i = text.indexOf('(', from)
  let paren = 0
  for (; i < text.length; i++) {
    if (text[i] === '(') paren++
    else if (text[i] === ')') { paren--; if (paren === 0) { i++; break } }
  }
  const bodyAt = text.indexOf('{', i)
  if (bodyAt < 0) throw new Error(`${token} 没有函数体起始大括号`)
  const blk = sliceBraced(text.slice(bodyAt), '{') // 从大括号起算 → 返回长度即块长
  return text.slice(from, bodyAt + blk.length)
}

/** 切出单行 `const NAME = ...` */
function sliceConst(text, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*[^\\n]+`).exec(text)
  if (!m) throw new Error(`未找到常量 ${name}`)
  return m[0]
}

/**
 * 组装一个只含 downloadOne 链路的最小模块。windowMs 为 null 时用源码原值。
 * 替身只有三处：net.fetch（喂合成流）、pushProgress / pushStage（录事件）、resolveMirror（固定镜像）。
 */
function buildHarness(windowMs) {
  const realWindow = sliceConst(src, 'SLOW_WINDOW_MS')
  const windowLine = windowMs == null ? realWindow : `const SLOW_WINDOW_MS = ${windowMs}`
  if (windowMs != null && realWindow === windowLine) throw new Error('SLOW_WINDOW_MS 补丁未生效')
  return `
import { Readable } from 'node:stream'
import { createWriteStream, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export const __pushes = { progress: [], stage: [] }
function pushProgress(percent, receivedBytes, totalBytes) {
  __pushes.progress.push({ percent, receivedBytes, totalBytes })
}
function pushStage(stage) { __pushes.stage.push(stage) }

// 主进程 net.fetch 的替身：用例通过 __net.fetch 注入合成响应
export const __net = { fetch: null }
const net = { fetch: (...a) => __net.fetch(...a) }

// 镜像设置值的替身（可用例中途改写 → 模拟「下载中用户换镜像」）
// 与用例里的 MIRROR 常量必须一致：默认值相同，两秒一次的巡检才是 no-op。
export const __mirrorCtl = { value: 'https://gh-proxy.com' }
function resolveMirror() { return __mirrorCtl.value }

${sliceConst(src, 'FALLBACK_MIRRORS')}
${sliceConst(src, 'PROGRESS_MIN_BYTES')}
${sliceConst(src, 'PROGRESS_MIN_INTERVAL_MS')}
${windowLine}
${sliceConst(src, 'SLOW_MIN_BYTES')}
${sliceBraced(src, 'class UpdateError')}
${sliceBraced(src, 'function mirrorKey')}
${sliceFn(src, 'async function downloadOne')}

export { downloadOne, UpdateError }
`
}

const tmpFiles = []
async function loadHarness(windowMs) {
  const ts = buildHarness(windowMs)
  let js
  try {
    js = stripTypeScriptTypes(ts, { mode: 'transform', sourceMap: false })
  } catch (e) {
    // 装配源码本身坏了（切片切歪）时把原文落盘，否则只有一行看不出所以然的报错
    const dump = path.join(os.tmpdir(), `phrontis-update-flow-${process.pid}-${windowMs ?? 'real'}.dump.ts`)
    fs.writeFileSync(dump, ts, 'utf8')
    throw new Error(`${e?.message}（装配源码已写到 ${dump}）`)
  }
  const file = path.join(os.tmpdir(), `phrontis-update-flow-${process.pid}-${windowMs ?? 'real'}.mjs`)
  fs.writeFileSync(file, js, 'utf8')
  tmpFiles.push(file)
  return import(pathToFileURL(file).href)
}

// ---------------------------------------------------------------- 合成流
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = 1024 * 1024
/** 与 harness 里 resolveMirror() 的桩一致：避免两秒一次的镜像巡检被误判成「换了镜像」 */
const MIRROR = 'https://gh-proxy.com'

/**
 * 给下载加硬超时。**必须有**：本项要防的正是「pipeline 永不 settle」，
 * 没这层的话契约脚本自己会陪着旧实现一起挂死，永远跑不出 FAIL。
 */
function withTimeout(p, ms, tag) {
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`__TIMEOUT__ ${tag} 超过 ${ms}ms 仍未结束`)), ms) }),
  ])
}

/**
 * 造一个响应替身。plan 是 [字节数, 该块前的等待毫秒] 序列；silent=true 时最后一块之后
 * **保持连接不关也不发**（模拟「挂着不回也不断」的挂死通道）。
 */
function makeFetch(plan, total, { silent = false } = {}) {
  let cancelled = false
  return async (url) => {
    const node = Readable.from((async function* () {
      for (const [bytes, wait] of plan) {
        if (wait) await sleep(wait)
        if (cancelled) return
        yield Buffer.alloc(bytes)
      }
      if (silent) await new Promise(() => {}) // 永不 settle：流既不结束也不报错
    })())
    const body = Readable.toWeb(node)
    const origCancel = body.cancel.bind(body)
    body.cancel = (reason) => { cancelled = true; return origCancel(reason) }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(total), 'content-type': 'application/octet-stream' }),
      body,
    }
  }
}

function tmpDest(tag) {
  const p = path.join(os.tmpdir(), `phrontis-update-flow-${process.pid}-${tag}.bin`)
  try { fs.unlinkSync(p) } catch { /* 不存在 */ }
  return p
}

// ---------------------------------------------------------------- 运行用例
const REMOTE = 'https://github.com/x/y/releases/download/v1/a.exe'

/**
 * 跑一次真实 downloadOne。返回 { err, dt } —— 失败不抛出，交给断言表达，
 * 这样单个用例挂死/报错不会把后面的用例一起带走（A/B 对照时需要看到全貌）。
 * opts.baseline 覆盖第 6 个实参（镜像基准），用来复现旧调用点的口径。
 */
async function drive(mod, dest, plan, total, timeoutMs, tag, opts = {}) {
  mod.__pushes.progress.length = 0
  mod.__pushes.stage.length = 0
  mod.__net.fetch = makeFetch(plan, total, opts)
  opts.onStart?.()
  const t0 = Date.now()
  let err = null
  try {
    await withTimeout(mod.downloadOne(REMOTE, dest, total, new AbortController().signal, 0, opts.baseline ?? MIRROR), timeoutMs, tag)
  } catch (e) { err = e }
  return { err, dt: Date.now() - t0 }
}

async function run() {
  // ============ A 组：真实常量（正常路径，看门狗不该被触发） ============
  const A = await loadHarness(null)

  // A1 假 100% 回归：真正跑完 99.6% 之后的尾巴，事件里绝不能出现 100
  {
    const dest = tmpDest('a1')
    // 1000 字节总量 / 先 996（= 99.6%，旧口径 Math.round 会打出 100）再 4
    const { err } = await drive(A, dest, [[996, 0], [4, 300]], 1000, 10000, 'A1')
    const ev = A.__pushes.progress
    const last = ev[ev.length - 1]
    check('A1 下载正常结束', !err, err?.message || '')
    check('99.6% 时进度显示 99 而非假的 100', !ev.some((e) => e.percent === 100), ev.map((e) => e.percent).join(','))
    check('最后一格仍在刷新（旧口径会一个事件都不发）', ev.length >= 2, `${ev.length} 个事件`)
    check('尾部字节可见（事件带到总字节数）', !!last && last.receivedBytes === 1000, last && JSON.stringify(last))
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
  }

  // A2 逐字节推进：按字节/时间节流，事件密度与整数百分比变化无关
  {
    const dest = tmpDest('a2')
    const total = 4 * MB
    const plan = Array.from({ length: 16 }, (_, i) => [256 * 1024, i === 0 ? 0 : 50])
    const { err } = await drive(A, dest, plan, total, 10000, 'A2')
    const ev = A.__pushes.progress
    const mono = ev.every((e, i) => i === 0 || e.percent >= ev[i - 1].percent)
    check('A2 下载正常结束', !err, err?.message || '')
    check('4MB 稳定流：事件 ≥10 个且不早报 100%',
      ev.length >= 10 && !ev.some((e) => e.percent === 100),
      `${ev.length} 个事件 / max=${ev.length ? Math.max(...ev.map((e) => e.percent)) : '-'}`)
    check('4MB 稳定流：百分比单调不减', mono)
    check('4MB 稳定流：落盘字节数正确', fs.existsSync(dest) && fs.statSync(dest).size === total)
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
  }

  // ============ B 组：窗口缩至 1000ms（看门狗路径） ============
  const B = await loadHarness(1000)

  // B1 核心回归：前 3MB 迸发后彻底静默 —— 旧实现（累计值比对）在这里永不触发
  {
    const dest = tmpDest('b1')
    const { err, dt } = await drive(B, dest, [[3 * MB, 0]], 12 * MB, 6000, 'B1', { silent: true })
    const reason = err?.reason || ''
    const message = err?.message || ''
    check('挂死通道：以一个窗口为单位判卡并抛出（旧实现永不触发）',
      reason === 'stalled', `reason=${reason || '(无)'} message=${message}`)
    check('挂死通道：判定耗时落在一个窗口 + 缓冲内',
      dt >= 900 && dt <= 3500, `${dt}ms（窗口 1000ms）`)
    check('挂死通道：文案指向通道无响应', message.includes('通道无响应'))
    check('挂死通道：首字节到达过 → 阶段回到 downloading',
      B.__pushes.stage.includes('downloading'), B.__pushes.stage.join(','))
    try { fs.unlinkSync(dest) } catch { /* 可能未落盘 */ }
  }

  // B2 稳定低速通道不得被误杀（窗口内新增 128KB*20 = 2.56MB > 2MB 阈值）
  {
    const dest = tmpDest('b2')
    const total = 8 * MB
    const plan = Array.from({ length: 64 }, (_, i) => [128 * 1024, i === 0 ? 0 : 50])
    const { err } = await drive(B, dest, plan, total, 10000, 'B2')
    check('稳定低速通道（2.56MB/s）：不被误判为卡死', !err, err ? `${err.reason || ''} ${err.message || err}` : '')
    check('稳定低速通道：完整落盘', fs.existsSync(dest) && fs.statSync(dest).size === total)
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
  }

  // ============ B3–B5：镜像巡检口径（2026-09-15 二次修复） ============
  // 统一的流：窗口内新增 256KB*20 = 5.12MB > 2MB，确保慢速看门狗不会抢先介入，
  // 于是用例里唯一可能中止下载的就是两秒一次的镜像巡检。
  const MP = Array.from({ length: 64 }, (_, i) => [256 * 1024, i === 0 ? 0 : 50])
  const MT = 16 * MB // ≈3.15s，跨过至少一次 2s 巡检

  // B3 旧口径复现：调用点把「当前候选的前缀」当基准 —— 直连候选推导出 ''，
  //    而设置里填的是镜像地址 → 恒不相等 → 2s 被判成「用户换了镜像」。
  //    这就是「任何非默认配置下兜底候选都活不过 2s、自动回退直连不可达」的机制。
  {
    const dest = tmpDest('b3')
    const { err, dt } = await drive(B, dest, MP, MT, 8000, 'B3', { baseline: '' })
    check('旧口径复现：候选前缀当基准 → 直连候选 2s 被判「换了镜像」',
      err?.message === 'MIRROR_CHANGED', `message=${err?.message || '(无)'} dt=${dt}ms`)
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
  }

  // B4 修复后：基准 = 设置值 → 同一个直连候选不再自杀，完整下完
  {
    const dest = tmpDest('b4')
    const { err, dt } = await drive(B, dest, MP, MT, 12000, 'B4')
    check('修复后：直连候选不再被误判为换镜像，完整下完',
      !err && fs.existsSync(dest) && fs.statSync(dest).size === MT,
      `${err ? `err=${err.message} ` : ''}dt=${dt}ms`)
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
  }

  // B5 功能没被改坏：下载中真的换了镜像，仍要 2s 内感知并中止（断点由上层续传）
  {
    const dest = tmpDest('b5')
    const { err, dt } = await drive(B, dest, MP, MT, 8000, 'B5', {
      onStart: () => { setTimeout(() => { B.__mirrorCtl.value = 'https://gh.dpik.top' }, 1000) },
    })
    B.__mirrorCtl.value = MIRROR // 复原，免得影响后续用例
    check('下载中换镜像：2s 内感知并抛 MIRROR_CHANGED',
      err?.message === 'MIRROR_CHANGED' && dt >= 1200 && dt <= 4000,
      `message=${err?.message || '(无)'} dt=${dt}ms`)
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
  }
}

try {
  await run()
} catch (e) {
  check('用例执行未抛异常', false, e?.stack || String(e))
} finally {
  // KEEP_HARNESS=1 时保留临时模块，便于手工复现装配结果
  if (!process.env.KEEP_HARNESS) {
    for (const f of tmpFiles) { try { fs.unlinkSync(f) } catch { /* ignore */ } }
  } else {
    for (const f of tmpFiles) console.log('保留临时模块:', f)
  }
}

// ---------------------------------------------------------------- 汇总
const failed = checks.filter((c) => !c.pass)
console.log('\n=== verify-update-stall ===')
console.log(`源文件: ${SRC_UPDATE}`)
console.log(`断言: ${checks.length - failed.length} PASS / ${failed.length} FAIL（共 ${checks.length}）\n`)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
}
if (failed.length) {
  console.log(`\nFAILED: ${failed.map((c) => c.name).join(' | ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)

/**
 * 窗口最大化 / 还原布局探针。
 *
 * 判据：点「最大化」后左/中/右三块 + 活动栏必须去留白/去圆角；再点「还原」必须恢复。
 * 这条链路只靠 tsc 看不出来：主进程的窗口态是异步落定的，事件/读取时序错了就会
 * 正好反过来（最大化仍留白、还原反而贴边）。所以这里用真实渲染层 DOM + 真实
 * `window.api.maximize()` 往返验一遍。
 *
 * 前置：一个开着 devbridge 的 dev 实例（默认 7465；可用 KNOWBASE_DEV_BRIDGE_PORT 覆盖）。
 *
 *   node .AGENT/scripts/window-state/probe-window-max.mjs
 *
 * 成功输出 PASS；失败输出实际读数并以非 0 退出。
 */

const PORT = Number(process.env.KNOWBASE_DEV_BRIDGE_PORT ?? 7465)
const BASE = process.env.KNOWBASE_DEV_BRIDGE_URL ?? `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function action(name, params = {}) {
  const res = await fetch(`${BASE}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, params }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`${name} failed: ${JSON.stringify(json)}`)
  return json.data
}

async function evalJs(code) {
  const data = await action('ui.eval', { code })
  return data.result?.result
}

const READ_STATE = `(async () => {
  const root = document.querySelector('#root')?.firstElementChild
  const ab = document.querySelector('[class*="w-11"][class*="flex-col"]')
  const panels = [...document.querySelectorAll('[data-wb="shell"] > div')]
  return {
    isMax: await window.api.isMaximized(),
    inner: [innerWidth, innerHeight],
    rootRound: !!root?.className.includes('rounded-[var(--window-radius)]'),
    abFound: !!ab,
    abFlush: !!ab && !ab.className.includes('mx-1.5'),
    panelCount: panels.length,
    hasMargin: panels.some((el) => el.className.includes('m-1.5')),
    events: (window.__winMaxProbeEvents ?? []).slice(),
  }
})()`

function assert(checks, label, state) {
  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) {
    console.log(`[PASS] ${label}`)
    return true
  }
  console.log(`[FAIL] ${label}`)
  for (const f of failed) console.log(`       - ${f.name}: ${f.actual}`)
  console.log(`       actual = ${JSON.stringify(state)}`)
  return false
}

async function main() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
  if (!health?.ok) throw new Error(`devbridge not ready at ${BASE}`)

  // 先确保窗口在「还原」态，再清空事件记录
  let state = await evalJs(READ_STATE)
  if (state.isMax) {
    await evalJs('window.api.maximize().then(() => true)')
    await sleep(900)
  }
  await evalJs(`(() => {
    window.__winMaxProbeEvents = []
    if (!window.__winMaxProbeHooked) {
      window.__winMaxProbeHooked = true
      window.api.onMaximizeChange((v) => window.__winMaxProbeEvents.push(v))
    }
    return true
  })()`)
  await sleep(150)

  state = await evalJs(READ_STATE)
  let ok = assert(
    [
      { name: 'restored isMax', ok: state.isMax === false, actual: state.isMax },
      { name: 'restored root rounded', ok: state.rootRound === true, actual: state.rootRound },
      { name: 'restored activitybar found', ok: state.abFound === true, actual: state.abFound },
      { name: 'restored activitybar margin', ok: state.abFlush === false, actual: state.abFlush },
      { name: 'restored panel margin', ok: state.hasMargin === true, actual: state.hasMargin },
    ],
    'initial restored state',
    state,
  )

  await evalJs('window.api.maximize().then(() => true)')
  await sleep(900)
  state = await evalJs(READ_STATE)
  ok = assert(
    [
      { name: 'maximized isMax', ok: state.isMax === true, actual: state.isMax },
      { name: 'maximized root unrounded', ok: state.rootRound === false, actual: state.rootRound },
      { name: 'maximized activitybar flush', ok: state.abFlush === true, actual: state.abFlush },
      { name: 'maximized no panel margin', ok: state.hasMargin === false, actual: state.hasMargin },
      { name: 'maximized last event true', ok: state.events.at(-1) === true, actual: state.events },
    ],
    'maximized state',
    state,
  ) && ok

  await evalJs('window.api.maximize().then(() => true)')
  await sleep(900)
  state = await evalJs(READ_STATE)
  ok = assert(
    [
      { name: 'restored isMax', ok: state.isMax === false, actual: state.isMax },
      { name: 'restored root rounded', ok: state.rootRound === true, actual: state.rootRound },
      { name: 'restored activitybar margin', ok: state.abFlush === false, actual: state.abFlush },
      { name: 'restored panel margin', ok: state.hasMargin === true, actual: state.hasMargin },
      { name: 'restored last event false', ok: state.events.at(-1) === false, actual: state.events },
    ],
    'restored state after round-trip',
    state,
  ) && ok

  if (!ok) process.exitCode = 1
}

main().catch((err) => {
  console.error('[FAIL] probe crashed:', err?.message ?? err)
  process.exitCode = 1
})

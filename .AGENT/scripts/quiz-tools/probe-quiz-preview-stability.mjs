/**
 * 运行期回归探针：B-50 题单「显示 / 收起参考答案」正文乱跳 —— DOM 身份 + 滚动 + 焦点断言。
 *
 * 场景（fixture：题单探针.md，一道选择 + 两道简答，seed-probe-vault 负责造页与清残留）：
 *   1. 知识库模块 → 打开 题单探针.md（md 默认阅读态）→ 等题卡渲染
 *   2. 预览滚到中部，抓住第 2 题（简答）[data-quiz-card] 与其 textarea 的**节点引用**
 *   3. 作答框打字（React 受控 value：原生 setter + input 事件）→ 立即点「显示参考答案」
 *      → 断言：卡片 / textarea 节点身份不变、scrollTop 不变、焦点没掉到 body
 *   4. 再等一拍（>500ms 防抖保存）断言第二轮 —— B-50 的隐藏症状是「只打字不点按钮也整页重挂」
 *   5. 点「收起参考答案」→ 等 220ms 收起动画播完 → 断言同上 + scrollHeight 回落
 *
 * 根因对照（docs/pending-fixes.md B-50）：修复前这里会看到 cardSame/taSame=false、
 * scrollTop 掉到 0 或掉一截、activeIsTa=false（activeElement 变 BODY）。
 *
 * 用法（项目根）：
 *   npm run build
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/quiz-tools/probe-quiz-preview-stability.mjs
 */
const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9333)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* electron 未起，继续等 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
const consoleErrors = []
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
  return r.result?.value
}

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}

const QUIZ_PAGE_ROW = '[data-wb-tree-file="1"][data-wb-tree-path="题单探针.md"]'

// 定位第 2 题（简答）卡片 + 其 textarea + 预览滚动容器，滚到中部，引用存 window.__qb
const SETUP = `(() => {
  const cards = [...document.querySelectorAll('[data-quiz-card]')]
  const card = cards.find((c) => c.querySelector('textarea') && c.dataset.quizNo === '2')
  if (!card) return { err: 'no short card no=2, cards=' + cards.length }
  const ta = card.querySelector('textarea')
  let sc = card.parentElement
  while (sc && sc !== document.body) {
    const oy = getComputedStyle(sc).overflowY
    if (sc.scrollHeight > sc.clientHeight + 10 && (oy === 'auto' || oy === 'scroll')) break
    sc = sc.parentElement
  }
  if (!sc || sc === document.body) return { err: 'scroll container not found' }
  window.__qb = { card, ta, sc }
  sc.scrollTop = Math.floor((sc.scrollHeight - sc.clientHeight) / 2)
  return { scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, cards: cards.length }
})()`

// 作答框打字（React 受控组件：原生 setter 绕过 + 冒泡 input 事件）
const TYPE = `(() => {
  const { ta, sc } = window.__qb
  ta.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '探针作答：验证展开参考答案不打滚。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return { scrollTop: sc.scrollTop, focused: document.activeElement === ta, len: ta.value.length }
})()`

// 点展开 / 收起按钮（传入期望的 aria-expanded 值）
const clickReveal = (expanded) => `(() => {
  const { card, sc } = window.__qb
  const btn = [...card.querySelectorAll('button[aria-expanded]')].find((b) => b.getAttribute('aria-expanded') === '${expanded}')
  if (!btn) return { err: 'reveal button not found, expanded=' + '${expanded}' }
  const topBefore = sc.scrollTop
  btn.click()
  return { topBefore }
})()`

// 身份 + 滚动 + 焦点断言（与 window.__qb 里的引用做 === 比较）
const CHECK = `(() => {
  const { card, ta, sc } = window.__qb
  const now = document.querySelector('[data-quiz-card][data-quiz-no="2"]')
  return {
    cardSame: now === card,
    taSame: card.querySelector('textarea') === ta && ta.isConnected,
    scrollTop: sc.scrollTop,
    activeIsTa: document.activeElement === ta,
    revealed: card.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'),
    scrollHeight: sc.scrollHeight,
  }
})()`

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'exception'].includes(m.params.type)) {
      consoleErrors.push(m.params.args?.map((a) => a.value ?? a.description).join(' '))
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || 'exception')
    }
  }
  await send('Runtime.enable')
  await sleep(1200)

  // 1. 进入知识库模块
  const nav = await evalJs(`(() => {
    const b = document.querySelector('[data-wb-bookmark="knowledge"]')
    if (!b) return 'no-bookmark'
    b.click(); return 'clicked'
  })()`)
  ok('进入知识库模块', nav === 'clicked', String(nav))
  await sleep(1000)

  // 2. 文件树打开 题单探针.md（md 默认阅读态）
  const openRes = await evalJs(`(() => {
    const row = document.querySelector('${QUIZ_PAGE_ROW}')
    if (!row) return 'no-tree-row'
    row.click(); return 'clicked'
  })()`)
  ok('文件树打开 题单探针.md', openRes === 'clicked', String(openRes))
  await sleep(1500)

  // 3. 等题卡出现并布置现场
  let setup = null
  for (let i = 0; i < 10; i++) {
    setup = await evalJs(SETUP)
    if (setup && !setup.err) break
    await sleep(500)
  }
  ok('题卡渲染（1 选择 + 2 简答）', setup && !setup.err, JSON.stringify(setup))
  if (!setup || setup.err) throw new Error('fixture 未就绪：' + JSON.stringify(setup))
  ok('预览可滚动且已滚到中部', setup.scrollTop > 100, `scrollTop=${setup.scrollTop} / ${setup.scrollHeight}`)
  await sleep(300)

  // 3.5 状态归位：quiz 记录跨运行持久（上轮探针点过展开），若参考答案已展开先收起，
  //     保证「点显示参考答案」从 closed 状态出发（探针自足，不依赖外部重跑 seed）
  const resetReveal = await evalJs(`(() => {
    const { card } = window.__qb
    const btn = card.querySelector('button[aria-expanded="true"]')
    if (!btn) return 'already-closed'
    btn.click(); return 'collapsed'
  })()`)
  if (resetReveal === 'collapsed') await sleep(450)

  // 4. 打字 → 立即点「显示参考答案」（toggleReveal 先 flush 未存草稿再展开 —— B-50 主诉路径）
  const typed = await evalJs(TYPE)
  ok('作答框打字且保持焦点', typed.focused && typed.len > 0, JSON.stringify(typed))
  const clickRes = await evalJs(clickReveal('false'))
  ok('点「显示参考答案」', clickRes && !clickRes.err, JSON.stringify(clickRes))
  await sleep(400)

  const afterOpen = await evalJs(CHECK)
  ok('展开后：简答卡节点身份不变', afterOpen.cardSame, `cardSame=${afterOpen.cardSame}`)
  ok('展开后：textarea 节点身份不变', afterOpen.taSame, `taSame=${afterOpen.taSame}`)
  ok('展开后：scrollTop 不跳', Math.abs(afterOpen.scrollTop - setup.scrollTop) <= 1,
    `before=${setup.scrollTop} after=${afterOpen.scrollTop}`)
  ok('展开后：焦点没掉到 body（仍是原作答框）', afterOpen.activeIsTa,
    `activeIsTa=${afterOpen.activeIsTa}`)
  ok('展开后：aria-expanded=true', afterOpen.revealed === 'true', String(afterOpen.revealed))

  // 5. 防抖保存窗口过后再断言一轮（只打字不点按钮的隐藏症状）
  await sleep(700)
  const afterDebounce = await evalJs(CHECK)
  ok('防抖保存后：简答卡节点身份不变', afterDebounce.cardSame, `cardSame=${afterDebounce.cardSame}`)
  ok('防抖保存后：textarea 节点身份不变', afterDebounce.taSame, `taSame=${afterDebounce.taSame}`)
  ok('防抖保存后：scrollTop 不跳', Math.abs(afterDebounce.scrollTop - setup.scrollTop) <= 1,
    `before=${setup.scrollTop} after=${afterDebounce.scrollTop}`)
  ok('防抖保存后：焦点仍在作答框', afterDebounce.activeIsTa, `activeIsTa=${afterDebounce.activeIsTa}`)

  // 6. 收起参考答案 → 220ms 动画播完 → 身份 / 滚动 / 高度回落
  const clickClose = await evalJs(clickReveal('true'))
  ok('点「收起参考答案」', clickClose && !clickClose.err, JSON.stringify(clickClose))
  await sleep(450)
  const afterClose = await evalJs(CHECK)
  ok('收起后：简答卡节点身份不变', afterClose.cardSame, `cardSame=${afterClose.cardSame}`)
  ok('收起后：textarea 节点身份不变', afterClose.taSame, `taSame=${afterClose.taSame}`)
  ok('收起后：scrollTop 不跳', Math.abs(afterClose.scrollTop - setup.scrollTop) <= 1,
    `before=${setup.scrollTop} after=${afterClose.scrollTop}`)
  ok('收起后：aria-expanded=false', afterClose.revealed === 'false', String(afterClose.revealed))
  ok('收起后：正文高度回落', afterClose.scrollHeight <= afterOpen.scrollHeight + 1,
    `open=${afterOpen.scrollHeight} closed=${afterClose.scrollHeight}`)

  if (consoleErrors.length > 0) {
    console.log('\n控制台错误（前 3 条）：')
    for (const e of consoleErrors.slice(0, 3)) console.log('  ', String(e).slice(0, 200))
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: quiz preview stability probe`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2) })

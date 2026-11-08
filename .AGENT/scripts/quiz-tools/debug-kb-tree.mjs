// 一次性诊断：进入知识库模块后 dump 侧栏 / 文件树状态（定位 probe 找不到题单探针.md 的原因）
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

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  await send('Runtime.enable')
  await sleep(1500)

  await evalJs("(() => { const b = document.querySelector('[data-wb-bookmark=\"knowledge\"]'); if (b) b.click(); return 1 })()")
  await sleep(2500)

  const nodeCount = await evalJs("document.querySelectorAll('[data-wb-tree-node]').length")
  console.log('tree node count:', nodeCount)

  const paths = await evalJs(`JSON.stringify(
    [...document.querySelectorAll('[data-wb-tree-node]')]
      .map(function (n) { return n.getAttribute('data-wb-tree-path') })
      .slice(0, 30)
  )`)
  console.log('tree paths (first 30):', paths)

  const textHead = await evalJs("document.body.innerText.slice(0, 600)")
  console.log('--- body text head ---')
  console.log(textHead.replace(/\n/g, ' | '))

  process.exit(0)
}

main().catch((e) => { console.error('DEBUG ERROR:', e); process.exit(2) })

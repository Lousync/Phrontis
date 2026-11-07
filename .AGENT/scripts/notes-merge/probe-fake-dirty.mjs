/**
 * 运行期探针：B-43 打开页面即出现假脏 → 自动保存白写一轮。
 *
 * 观测口径（无侵入）：打开 fixture 页面后**不做任何编辑**，等自动保存防抖（2s）+ 余量，
 * 对比页面文件前后 mtime 与 frontmatter `updated` 字段 —— 被顶掉即假脏实锤。
 * 覆盖三种打开路径：阅读态打开、切页（keep-alive 实例换 pageId）、⋮→查看源码 进编辑态。
 *
 * 用法（项目根）：
 *   npm run build
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/notes-merge/probe-fake-dirty.mjs
 */
import { statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9333)
const FIXTURE = resolve('tmp/vault-fixture')
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

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}

/** 快照：mtime + frontmatter updated */
const snap = (rel) => {
  const p = join(FIXTURE, rel)
  const st = statSync(p)
  let updated = ''
  try {
    const head = readFileSync(p, 'utf8').split('---')[0] ?? ''
    updated = (head.match(/updated:\s*(.+)/) ?? [])[1]?.trim() ?? ''
  } catch { /* 无 frontmatter */ }
  return { mtimeMs: Math.round(st.mtimeMs), updated }
}

async function openPageViaTree(relPath) {
  const clicked = await evalJs(`(() => {
    const row = document.querySelector('[data-wb-tree-file="1"][data-wb-tree-path="${relPath}"]')
    if (!row) return 'no-row'
    row.click(); return 'clicked'
  })()`)
  await sleep(1500)
  return clicked
}

/** 观察 N 秒：期间每 500ms 轮询 mtime，返回是否发生过写盘 */
async function watchNoWrite(rel, ms) {
  const base = statSync(join(FIXTURE, rel)).mtimeMs
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(500)
    if (statSync(join(FIXTURE, rel)).mtimeMs !== base) return { wrote: true }
  }
  return { wrote: false }
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
  await sleep(1200)

  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="knowledge"]')?.click(); return 1 })()`)
  await sleep(1500)

  // ===== 场景 1：阅读态打开 写作面探针.md =====
  const rel1 = '写作面探针.md'
  const before1 = snap(rel1)
  await openPageViaTree(rel1)
  const w1 = await watchNoWrite(rel1, 4500)
  const after1 = snap(rel1)
  ok('S1 阅读态打开：无假保存（mtime 不变）', !w1.wrote,
    `mtime ${before1.mtimeMs} → ${after1.mtimeMs}`)
  ok('S1 frontmatter updated 未被顶掉', after1.updated === before1.updated,
    `${before1.updated} → ${after1.updated}`)

  // ===== 场景 2：keep-alive 切页到 题单探针.md =====
  const rel2 = '题单探针.md'
  const before2 = snap(rel2)
  await openPageViaTree(rel2)
  const w2 = await watchNoWrite(rel2, 4500)
  const after2 = snap(rel2)
  ok('S2 切页打开：无假保存（mtime 不变）', !w2.wrote,
    `mtime ${before2.mtimeMs} → ${after2.mtimeMs}`)
  ok('S2 frontmatter updated 未被顶掉', after2.updated === before2.updated,
    `${before2.updated} → ${after2.updated}`)

  // ===== 场景 3：进编辑态（Monaco/CM6 挂载）后静置 =====
  await evalJs(`(() => {
    const btn = document.querySelector('[data-wb="noteTopViewToggle"]')
    if (!btn) return 'no-toggle'
    btn.click(); return 'toggled'
  })()`)
  await sleep(1000)
  const editMode = await evalJs(`document.querySelector('[data-wb="noteTopViewToggle"]')?.getAttribute('data-view')`)
  ok('S3 已进编辑态', editMode === 'edit', String(editMode))
  const w3 = await watchNoWrite(rel2, 4500)
  const after3 = snap(rel2)
  ok('S3 进编辑态静置：无假保存（mtime 不变）', !w3.wrote,
    `mtime ${after2.mtimeMs} → ${after3.mtimeMs}`)

  console.log(`\n${failed ? 'FAIL' : 'PASS'}: fake dirty probe`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2) })

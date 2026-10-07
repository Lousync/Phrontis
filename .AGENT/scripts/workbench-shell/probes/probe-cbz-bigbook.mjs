/**
 * 大体积 CBZ 探针（B-16「cbz 体积 / 卡顿」）。
 * 用法（**先 seed 再跑**；`electron/` 或 `src/` 有改动时先 build）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --add-big-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-cbz-bigbook.mjs --no-sandbox --disable-gpu
 *
 * 为什么必须单独一个探针：B-16 的修复面**不在阅读器的通用链路上**，而在「整本读入」这一段——
 *   · 读取通道从 base64 换成字节直传（`ws:readRange` → `ws:readRangeBytes`）
 *   · 拼接从 O(n²) 重分配换成预分配就地写入
 *   · 体积分档闸门（静默 ≤128MB / 确认 128–384MB / 拒绝 >384MB）
 * 前三项**只有拿一本真大书才观测得到**（258KB 的探针样书在任一实现下都是 ~550ms 的固定开销），
 * 分档闸门也只有跨过 128MB 才触发。用普通探针加参数做不到：那些探针的 fixture 就是小书。
 *
 * 覆盖：
 *   0) fixture 存在（两本大书；缺则给出 seed 命令 → 断言红，不静默跳过）
 *   1) ★ 新通道**逐字节正确**：整本走 `workspaceReadRangeBytes` 分块读回、就地拼装，
 *      FNV-1a 与 node 侧 `readFileSync` 的同一函数比对（含字节数）。分块 8MB / 1MB 各跑一次
 *      —— 块大小只是内存峰值的旋钮，**不得**改变字节与总耗时口径（B-16 实测：总时长与块大小无关）
 *   2) ★ 静默档：96.2MB 不弹确认框、直接打开；期间有阶段文字（`正在读取 N%` → `正在解包排版…`），
 *      且百分比**非递减**（真进度，不是装饰）
 *   3) ★ 确认档：130.5MB 弹确认框，文案含**真实体积**与耗时 / 内存预估
 *   4) ★ 取消 → error 态 + 「仍要打开」按钮（不是踢回书架）；点它复跑装载 → ready，
 *      且**不再问第二遍**（`bigOkKeyRef` 记住已确认）
 *   5) 耗时表：小书 / 96MB 的「点卡 → ready」墙钟，以及 (96MB − 小书) 的**体积增量**
 *      —— 这条增量是 B-16 的真正判据：改造前 ~1.4s，改造后目标 <0.4s，本探针卡 1000ms 兜底
 *
 * ★ 判据口径：**不要用 long task**。本机 `PerformanceObserver('longtask')` 在 renderer 里
 *   一条都收不到（即便同时跑着 1.5s 的阻塞读链路，实测取证）—— 判据 = 墙钟 + 通道字节比对。
 * ★ 阶段文字是**用户可见反馈**，不是调试输出：它存在的理由（2 秒无反馈 = 像卡死）写在
 *   `EpubReaderView` 加载覆盖层注释里，本探针锁住它别在后续重构里被顺手删掉。
 * ★ 大书 fixture 由 `./make-big-cbz.mjs` 生成（**确定性**：固定种子 PRNG + 固定 zip 时间戳），
 *   体积与 sha256 逐轮相同 ⇒ 下面的等值断言才有意义。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, createAssertions, sleep } from './lib/reader-probe-kit.mjs'
import { BIG_BOOK_FIXTURES } from './make-big-cbz.mjs'

const { ok, note, assertNotFailed, finish } = createAssertions()
const K = await connect()
const { evalJs, backToShelf } = K

/** fixture 仓库 id（`seed-probe-vault.mjs` 写死的行 id；渲染侧只认 {rootId, relPath} 这一对） */
const ROOT_ID = 'probe-vault-01'
const SMALL = '.books/探针样书.cbz'
const BIG = '.books/大样书.cbz'
const HUGE = '.books/超大样书.cbz'
const CHUNK_MAIN = 8 * 1024 * 1024
const CHUNK_ALT = 1024 * 1024

/** FNV-1a 32 位：node 侧与页面侧**同一算法**（不是密码学用途，只做逐字节等值判据） */
function fnv1a(buf) {
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 点书架卡片：**按 relPath 精确匹配**（不能用 `大样书.cbz$` 这种后缀正则 —— 它会先命中「超大样书.cbz」） */
const clickCard = (relPath) => evalJs(`(() => {
  const b = [...document.querySelectorAll('main button[title]')].find((x) => (x.getAttribute('title') || '') === ${JSON.stringify(relPath)})
  if (!b) return 'no-card'
  b.scrollIntoView({ block: 'center' })
  b.click()
  return 'ok'
})()`)

/** 页面侧整本读回：与产品 `readWholeBook` 同一条通道、同一种就地拼装（不 import 产品代码，故复刻） */
const pageHash = (relPath, chunk) => `(async () => {
  const t0 = performance.now()
  const pick = (r) => (r && !('error' in r) && r.bytes) ? r.bytes : null
  const first = await window.api.workspaceReadRangeBytes(${JSON.stringify(ROOT_ID)}, ${JSON.stringify(relPath)}, 0, ${chunk})
  const b0 = pick(first)
  if (!b0) return { err: String((first && first.error) || 'first read failed') }
  const total = first.size
  const out = new Uint8Array(total)
  out.set(b0, 0)
  let off = b0.length
  let chunks = 1
  while (off < total) {
    const r = await window.api.workspaceReadRangeBytes(${JSON.stringify(ROOT_ID)}, ${JSON.stringify(relPath)}, off, ${chunk})
    const b = pick(r)
    if (!b || b.length === 0) break
    out.set(b, off)
    off += b.length
    chunks++
  }
  let h = 0x811c9dc5
  for (let i = 0; i < out.length; i++) { h ^= out[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), bytes: off, total, chunks, ms: Math.round(performance.now() - t0) }
})()`

/** 装载快照（一次求值拿齐所有宿主读数，减少 CDP 往返 → 采样密度更高） */
const snap = () => evalJs(`(() => {
  const r = document.querySelector('[data-wb="epubReader"]')
  const ph = document.querySelector('[data-wb="epubLoadPhase"]')
  const mc = document.querySelector('[data-wb="globalConfirm"]')
  const er = document.querySelector('[data-wb="epubLoadErr"]')
  return {
    state: r ? r.getAttribute('data-wb-state') : null,
    phase: ph ? ph.textContent.trim() : null,
    modal: !!mc,
    err: er ? er.textContent.trim() : null,
    retry: !!document.querySelector('[data-wb="epubBigBookRetry"]'),
  }
})()`)

/**
 * 点卡 → 采样到 ready（或 modal，`stopOnModal` 时）。
 * 40ms 采样：96MB 的读取阶段实测 ~330ms、排版阶段 ~500ms，够取到十几帧。
 */
async function openTimed(relPath, { stopOnModal = false, budgetMs = 12000 } = {}) {
  const t0 = Date.now()
  const clicked = await clickCard(relPath)
  if (clicked !== 'ok') return { clicked, ready: null, phases: [], modalAt: null, modals: 0, last: null }
  const phases = []
  let ready = null
  let modalAt = null
  let modals = 0
  let last = null
  let sawModal = false
  while (Date.now() - t0 < budgetMs) {
    const s = await snap()
    if (s) {
      last = s
      if (s.modal && !sawModal) { sawModal = true; modals++; modalAt = Date.now() - t0 }
      if (!s.modal) sawModal = false
      if (s.phase) phases.push({ at: Date.now() - t0, text: s.phase })
      if (s.state === 'ready') { ready = Date.now() - t0; break }
      if (stopOnModal && s.modal) break
    }
    await sleep(40)
  }
  return { clicked, ready, phases, modalAt, modals, last }
}

/** 确认框内容（锚点见 `GlobalConfirm.tsx`） */
const confirmInfo = () => evalJs(`(() => {
  const box = document.querySelector('[data-wb="globalConfirm"]')
  if (!box) return null
  const q = (s) => { const e = box.querySelector(s); return e ? e.textContent.trim() : null }
  return {
    title: q('[data-wb="globalConfirmTitle"]'),
    message: q('[data-wb="globalConfirmMsg"]'),
    cancel: q('[data-wb="globalConfirmCancel"]'),
    ok: q('[data-wb="globalConfirmOk"]'),
  }
})()`)
const clickConfirm = (which) => evalJs(`(() => {
  const b = document.querySelector('[data-wb="globalConfirm${which}"]')
  if (!b) return 'gone'
  b.click()
  return 'ok'
})()`)

/** 等确认框**整个退场**（usePresence 有 170ms 退场动画，没等干净会让「不再问第二遍」数出假阳性） */
async function waitModalGone(tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (!(await evalJs(`!!document.querySelector('[data-wb="globalConfirm"]')`))) return true
    await sleep(100)
  }
  return false
}

/** 等宿主进入某状态（比固定 sleep 稳） */
async function waitState(want, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const s = await snap()
    if (s && s.state === want) return { hit: true, last: s }
    await sleep(100)
  }
  return { hit: false, last: await snap() }
}

/** 阶段采样摘要：pct 序列是否非递减 */
function phaseSummary(phases) {
  const pcts = phases.map((p) => /(\d+)%/.exec(p.text)).filter(Boolean).map((m) => Number(m[1]))
  let mono = true
  for (let i = 1; i < pcts.length; i++) if (pcts[i] < pcts[i - 1]) mono = false
  return {
    texts: [...new Set(phases.map((p) => p.text))],
    pcts,
    mono,
    hasRead: phases.some((p) => p.text.includes('正在读取')),
    hasOpen: phases.some((p) => p.text.includes('正在解包排版')),
    samples: phases.length,
  }
}

async function main() {
  // ===== 0) fixture 检查（缺了就给命令，别静默跳过）=====
  const files = BIG_BOOK_FIXTURES.map((f) => ({ ...f, path: join(K.FIXTURE, '.books', f.name) }))
  for (const f of files) {
    const okExists = existsSync(f.path)
    ok(`fixture 存在：${f.name}`, okExists,
      okExists ? `${(readFileSync(f.path).length / 1048576).toFixed(1)}MB` : '先跑 seed-probe-vault.mjs --add-books --add-big-books')
  }
  assertNotFailed()
  const sizes = Object.fromEntries(files.map((f) => [f.name, readFileSync(f.path)]))
  const bigName = BIG_BOOK_FIXTURES[0].name
  const hugeName = BIG_BOOK_FIXTURES[1].name
  const bigBytes = sizes[bigName].length
  const hugeBytes = sizes[hugeName].length
  const bigMb = Math.ceil(bigBytes / 1048576)
  const hugeMb = Math.ceil(hugeBytes / 1048576)
  note('两本大书实得体积', `${bigName} ${(bigBytes / 1048576).toFixed(1)}MB / ${hugeName} ${(hugeBytes / 1048576).toFixed(1)}MB`)
  // 档位是**断言的前提**：96MB 必须在静默档内、130MB 必须跨过 128MB 线，否则下面两条白跑
  ok('★ 静默档样本真在 128MB 之内', bigBytes <= 128 * 1024 * 1024, `${(bigBytes / 1048576).toFixed(1)}MB`)
  ok('★ 确认档样本真在 128–384MB 之间', hugeBytes > 128 * 1024 * 1024 && hugeBytes <= 384 * 1024 * 1024, `${(hugeBytes / 1048576).toFixed(1)}MB`)

  // ===== 1) 新通道逐字节正确（小书 + 大书，两种块大小）=====
  for (const [rel, label] of [[SMALL, '小书'], [BIG, '96MB']]) {
    const disk = readFileSync(join(K.FIXTURE, rel))
    for (const [chunk, cname] of [[CHUNK_MAIN, '8MB'], [CHUNK_ALT, '1MB']]) {
      const r = await evalJs(pageHash(rel, chunk))
      if (!r || r.err) { ok(`★ 字节通道 ${label}（${cname} 块）读回成功`, false, JSON.stringify(r)); continue }
      ok(`★ 字节通道 ${label}（${cname} 块）字节数一致`, r.bytes === disk.length && r.total === disk.length,
        `回读 ${r.bytes} / 盘上 ${disk.length}`)
      ok(`★ 字节通道 ${label}（${cname} 块）内容逐字节一致（FNV-1a ${r.hash}）`, r.hash === fnv1a(disk),
        `页面 ${r.hash} / node ${fnv1a(disk)}`)
    }
  }
  assertNotFailed()
  // 块大小只是内存峰值旋钮：总耗时口径不变（B-16 实测 8/16/32/64MB 总时长相同）
  const t8 = await evalJs(pageHash(BIG, CHUNK_MAIN))
  const t1 = await evalJs(pageHash(BIG, CHUNK_ALT))
  note('整本读回耗时（块大小不变量）', `8MB 块 ${t8?.ms}ms（${t8?.chunks} 块） / 1MB 块 ${t1?.ms}ms（${t1?.chunks} 块）`)

  // ===== 2) 静默档：96MB 直接打开 + 阶段文字 =====
  // ★ 每次点卡前必须回书架：书卡在 `main` 里，阅读器一开就整块被换掉（`no-card` 是那种状态下的表象）
  await K.openBookshelf()
  const small = await openTimed(SMALL)
  ok('小书基线打开到 ready', small.ready !== null, `clicked=${small.clicked} ready=${small.ready}`)
  await backToShelf()
  const big = await openTimed(BIG)
  ok('★ 96MB（静默档）不弹确认框，直接打开', big.modals === 0 && big.ready !== null,
    `clicked=${big.clicked} modals=${big.modals} ready=${big.ready} last=${JSON.stringify(big.last)}`)
  const ps = phaseSummary(big.phases)
  note('阶段文字采样', JSON.stringify(ps))
  ok('★ 大书装载期间给出阶段文字（不是白屏等 2 秒）', ps.samples > 0 && ps.hasRead, `${ps.samples} 帧 / ${JSON.stringify(ps.texts)}`)
  ok('★ 阶段文字走完「读取 → 排版」两段', ps.hasOpen, JSON.stringify(ps.texts))
  ok('★ 读取百分比非递减（真进度）', ps.mono && ps.pcts.length >= 2, JSON.stringify(ps.pcts))
  assertNotFailed()

  // ===== 3) 确认档：130MB 弹确认框，文案含真实体积 =====
  await backToShelf()
  const huge = await openTimed(HUGE, { stopOnModal: true })
  const ci = await confirmInfo()
  ok('★ 130MB（确认档）弹应用级确认框', huge.modals === 1 && !!ci, JSON.stringify({ modals: huge.modals, modalAt: huge.modalAt }))
  ok('确认框标题', ci?.title === '打开这本大书？', JSON.stringify(ci?.title))
  ok('★ 文案含真实体积（MB，与实际文件大小同口径）', !!ci && ci.message.includes(`${hugeMb} MB`), `${hugeMb} MB ← ${ci?.message}`)
  ok('文案含耗时预估（秒）与内存预估', !!ci && /约\s*\d+\s*秒/.test(ci.message) && ci.message.includes('内存'), JSON.stringify(ci?.message))
  ok('两个按钮：取消 / 仍要打开', ci?.cancel === '取消' && ci?.ok === '仍要打开', JSON.stringify(ci))
  assertNotFailed()

  // ===== 4) 取消 → error 态 + 仍要打开 → 复跑不再问 =====
  await clickConfirm('Cancel')
  const afterCancel = await waitState('error')
  ok('★ 取消后进 error 态（不是踢回书架）', afterCancel.hit, JSON.stringify(afterCancel.last))
  ok('★ error 文案说明是「已取消打开」', !!afterCancel.last?.err && afterCancel.last.err.includes('已取消打开'), JSON.stringify(afterCancel.last?.err))
  ok('★ error 态给出「仍要打开」按钮', afterCancel.last?.retry === true)
  const modalGone = await waitModalGone()
  ok('确认框退场（退场动画 170ms，等干净再点重试）', modalGone)
  const retryClick = await evalJs(`(() => { const b = document.querySelector('[data-wb="epubBigBookRetry"]'); if (!b) return 'gone'; b.click(); return 'ok' })()`)
  ok('点「仍要打开」', retryClick === 'ok')
  const afterRetry = await openTimedRaw()
  ok('★ 复跑后读到 ready（同一本 130MB 真的打开了）', afterRetry.ready !== null, `${afterRetry.ready}ms`)
  ok('★ 不再问第二遍（已确认过的书不重复弹框）', afterRetry.modals === 0, `modals=${afterRetry.modals}`)
  assertNotFailed()

  // ===== 5) 耗时表 =====
  const inc = (big.ready ?? 0) - (small.ready ?? 0)
  console.log('\n[大书耗时表]')
  console.log(`  小书（258KB）点卡 → ready: ${small.ready}ms`)
  console.log(`  96MB        点卡 → ready: ${big.ready}ms   （体积增量 ${inc}ms）`)
  console.log(`  130MB       点卡 → ready: ${afterRetry.ready}ms（含一次复跑，仅供参考）`)
  note('体积增量判据', `改造前实测 ~1400ms → 改造后实测 ~330ms`);
  ok('★ 体积增量 < 1000ms（改造前 ~1400ms：base64 解码 + O(n²) 拼接已去掉）', inc < 1000, `${inc}ms`)

  finish()
}

/** 复跑装载（点按钮之后）**不再点卡**，只等状态 —— 与 openTimed 的区别仅此一点 */
async function openTimedRaw({ budgetMs = 12000 } = {}) {
  const t0 = Date.now()
  const phases = []
  let ready = null
  let modals = 0
  let sawModal = false
  let last = null
  while (Date.now() - t0 < budgetMs) {
    const s = await snap()
    if (s) {
      last = s
      if (s.modal && !sawModal) { sawModal = true; modals++ }
      if (!s.modal) sawModal = false
      if (s.phase) phases.push({ at: Date.now() - t0, text: s.phase })
      if (s.state === 'ready') { ready = Date.now() - t0; break }
      if (s.err && !s.retry) break
    }
    await sleep(40)
  }
  return { ready, phases, modals, last }
}

await main()

/**
 * ResizeObserver 底噪探针（B-21 的验收与回归位）。
 *
 * 用法（**先 seed 再跑**；`src/` 有改动时先 build）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-ro-noise.mjs --no-sandbox --disable-gpu
 *
 * 覆盖：六种格式各开一次再返回，逐本书量两条判据 ——
 *   ★ 判据 A（治本）：**不留「已不可渲染、却仍被观察」的目标**。
 *     foliate 的 `View` 观察的是内容帧（blob iframe）里的 `body`；帧被摘掉后
 *     `contentDocument` 变 null，上游 `destroy()` 的 `if (this.document)` 恰好在这一刻失效
 *     ⇒ 观察者被永久留在脱离的帧上 ⇒ Chromium **每帧**报一条
 *     `ResizeObserver loop completed with undelivered notifications`（实测 166 条/秒，
 *     与本条现象速率逐字相同），直到那个文档被 GC —— 这正是「同一次会话里时有时无」的来源。
 *     patch ⑧（`src/vendor/foliate/README.md`）把撤销改成按**留存引用**进行。
 *     这条判据不依赖计数、也不受 GC 时机影响：**只要泄漏还在，它就必然 ≥1**。
 *   ★ 判据 B（现象）：开/关一轮里 `ResizeObserver loop` 告警总数为 **0**（修前 epub 单轮 357~615）。
 *   ★ 判据 C（B-19 的回归位）：pdf / txt 同样为 0（B-19 修好后它们本来就是 0，别被本条改回去）。
 *   ★ 判据 D（B-24 的回归位，文件末段「连开 20 次 PDF」）：**每开一次 PDF，构造期新建的 RO 都要在
 *     返回书架时被 disconnect**（`constructed === disconnected`，实测每轮 2/2）、且「良性残留」列恒为 0、
 *     live 恒 0。这不是「告警判据」—— pdfjs 那件图**不产生任何告警**，只能按「观察还在不在」量。
 *     ★ 只读判据 D 的残留列不够：源码级契约曾把「错的顺序」锁绿（见 docs/pending-fixes.md B-24 结案），
 *     所以这条切片必须在**运行期**跑，别拿契约绿当它已验。
 *
 * ★ 为什么不去 devbridge 的日志环读 `/errors`：那口环**折叠紧邻重复**（同消息只留 1 条 + count），
 *   且被 B-19 的 `console-message` 秒级限流压过 —— 一秒钟 166 条在环里只显示成几个 count。
 *   本探针直接在页面里挂 `error` 监听计数，量的是**原始条数**。
 *
 * ★ 为什么不注入 `Page.addScriptToEvaluateOnNewDocument` + reload：那能连启动期建的 RO 一起包住，
 *   但要重载页面（会打乱仓库选择 / 引导态）。foliate 的 RO 全部建于**开书那一刻**，
 *   在开书之前挂好包装即已足够 —— 实测（2026-09-22）两种做法读数一致。
 *
 * ★★ 告警条数**只能在本探针里当判据**（2026-09-22 实测）：把构建产物改回上游门后，同一轮里
 *   `probe-cbz-reader` / `probe-fb2-reader` / `probe-epub-reader` 读到的 RO 告警都是 **0 条**，
 *   而本探针读 **341 条**。所以那三条探针里这一类**只报数、不断言**（写了注释说明会假通过）——
 *   本条的回归位就是这里，别在别处复制「零告警」断言。
 *   本探针读数稳定的一个来源：`live` 表对被观察节点是**强引用**（RO 规范本身也强引用观察目标），
 *   泄漏的文档不会被提前回收 ⇒ 每帧一条的洪水会一直记下去。（未做隔离验证，但反过来说明：
 *   「别的探针读 0」既不等于没漏，也不等于本探针读数被自己造出来 —— 治本判据不看计数。）
 */
import { connect, sleep } from './lib/reader-probe-kit.mjs'

const { ok, note, finish } = (() => {
  let failed = false
  return {
    ok: (n, c, extra = '') => { console.log(`${c ? '  ok  ' : ' fail '} ${n}${c ? '' : `  [${extra}]`}`); if (!c) failed = true },
    note: (n, extra = '') => console.log(`  --   ${n}${extra ? '  [' + extra + ']' : ''}`),
    finish: () => { console.log(failed ? '\n存在失败断言' : '\n全部通过'); process.exit(failed ? 1 : 0) },
  }
})()

const K = await connect()
const { evalJs } = K

const INSTALL = `(() => {
  if (window.__roNoise) return 'already'
  const Orig = window.ResizeObserver
  // element -> { stack, owners:Set<RO> }（当前仍被观察的目标）。
  // ★ 记 owners 而不是「一个元素一条」：同一元素可能被多个观察者同时观察，
  //   任一观察者 disconnect/unobserve 不该把别人的观察一并抹掉。
  const live = new Map()
  const warn = []
  let constructed = 0
  let disconnected = 0
  /**
   * 目标分类。★ 判据只能写成「**文档不是主的，且那个文档的 window 已经没了**」——
   * 2026-09-22 实测定死（变异测试：把 patch ⑧ 改回上游的 this.document 之门，重现 347 条告警）：
   * 泄漏目标 body 的自述是「isConnected === true」（它自己那份文档还认得它）、
   * 「document.defaultView === null」（**帧的浏览上下文已经没了**）、frameElement 取不到。
   * 所以「用 frameElement / isConnected 判断帧还在不在」两条路都会漏 —— 只有 defaultView 为 null 是准的。
   */
  const sel = (el) => (el.tagName || '?').toLowerCase() + (el.id ? '#' + el.id : '')
  const inDeadFrame = (el) => el.ownerDocument !== document && !el.ownerDocument.defaultView
  window.__roNoise = {
    warns: () => warn.length,
    reset: () => { warn.length = 0 },
    /**
     * ★ 治本判据：**帧内节点，而那个帧的 window 已消失**。这正是 B-21 的机制本体 ——
     *   目标脱离了「可交付的文档」，Chromium 于是每帧报一条 loop 告警（实测 166/s）。
     *   判据不依赖告警计数、也不受 GC 时机影响：泄漏还在，这里就必然 ≥1。
     *
     * ⚠ 为什么不把「脱离主文档的普通节点」也算进来：**它们不产生告警**（2026-09-22 微验证实测：
     *   主文档里被观察的 div 摘掉后 0 条/秒；只有帧没了才 166/s）。把两类混在一起，会让
     *   pdfjs 自身的良性残留（PDFViewer 的 #resizeObserver 观察 .kb-pdf-scroll，见 benignDetached）
     *   把判据染红，逼着后来的人去调阈值 —— 判据就废了。
     */
    leakedFrameTargets: () => {
      const out = []
      for (const el of live.keys()) {
        if (inDeadFrame(el)) out.push({ sel: sel(el), stack: live.get(el).stack })
      }
      return out
    },
    /**
     * 已知良性残留（**不作断言，只报数**）：被观察的**主文档**节点在读者卸载后脱离文档。
     * 实测来源只有一处 —— pdfjs 3.11 的 PDFViewer 在构造器里 #resizeObserver.observe(container)
     * 且**没有 destroy()**（node_modules/pdfjs-dist/web/pdf_viewer.js:6003,6021；上游注释也已确认
     * 「官方 viewer 没有 destroy()」，见 pdfViewerKit.detachViewerDocument）⇒ 每开一次 PDF 留一个。
     * 无告警、不在这条 bug 的机制里；要根治得给 pdfjs 打 patch（登记在 docs/pending-fixes.md）。
     */
    benignDetached: () => {
      const out = []
      for (const el of live.keys()) {
        if (el.ownerDocument === document && !el.isConnected) out.push({ sel: sel(el), stack: live.get(el).stack })
      }
      return out
    },
    liveCount: () => live.size,
    /**
     * 计数器（B-24 切片的验收位）：包装 RO **构造**次数 / **收到 disconnect** 次数 / 当前 live 条目数。
     * 判据：本轮 constructed === disconnected（每次开 PDF 建了两个 RO —— 宿主 measure 一个、pdfjs
     * viewer 一个 —— 返回后都得断开），否则就是漏了一个。
     */
    stats: () => ({ constructed, disconnected, live: live.size }),
    resetStats: () => { constructed = 0; disconnected = 0 },
  }
  const short = (s) => String(s || '').split('\\n').slice(1, 4).map((x) => x.trim().replace(/\\s+/g, ' ')).join(' <- ').slice(0, 110)
  class RO {
    constructor(cb) {
      constructed++
      this.__inner = new Orig((es, ob) => {
        // 回调里若把目标改到「不可渲染」再撤观察，是合规的；这里只记录，不判断
        return cb(es, ob)
      })
      this.__stack = short((new Error()).stack)
    }
    observe(el, ...r) {
      if (el) {
        let rec = live.get(el)
        if (!rec) { rec = { stack: this.__stack, owners: new Set() }; live.set(el, rec) }
        rec.owners.add(this)
      }
      return this.__inner.observe(el, ...r)
    }
    unobserve(el, ...r) {
      this.__drop(el)
      return this.__inner.unobserve(el, ...r)
    }
    // 从 live 里摘掉「本实例」对 el 的观察；owners 空了才真正删条目（别抹掉别人的观察）
    __drop(el) {
      const rec = live.get(el)
      if (!rec) return
      rec.owners.delete(this)
      if (rec.owners.size === 0) live.delete(el)
    }
    disconnect(...a) {
      // ★ 按实例清账（B-24 收尾加）：一个观察者只能反查「自己 observe 过谁」，所以在
      //   observe 里把 this 记进 owners（而不是「一个元素一条」）。少了这一步，修复生效后
      //   benignDetached() 仍会报 1 —— 判据假红。B-24 的主判据就靠它区分真假。
      for (const el of [...live.keys()]) this.__drop(el)
      disconnected++
      return this.__inner.disconnect(...a)
    }
  }
  window.ResizeObserver = RO
  window.addEventListener('error', (e) => {
    if (/ResizeObserver loop/.test(e.message || '')) warn.push({ t: Math.round(performance.now()) })
  }, true)
  return 'installed'
})()`

console.log('[注入]', await evalJs(INSTALL))

// ★ 传**文件名**（`openBook` 用 `名称$` 锚定书架卡片的 `title`），**不要**带 `.books/` 前缀 ——
//   带前缀会一个都匹配不上，而「没打开任何书」正好也读数为 0 ⇒ 三条判据全假通过。
//   最后一条断言（reader 必须到 ready）就是为拦这个：2026-09-22 首跑踩过。
const BOOKS = [
  { name: '探针样书.txt', rel: '.books/探针样书.txt', kind: 'txt', eng: 'txt' },
  { name: 'Reader Sample (light).pdf', rel: '.books/Reader Sample (light).pdf', kind: 'pdf', eng: 'pdf' },
  { name: '探针样书.epub', rel: '.books/探针样书.epub', kind: 'epub', eng: 'foliate' },
  { name: '探针样书.fb2', rel: '.books/探针样书.fb2', kind: 'fb2', eng: 'foliate' },
  { name: '探针样书.fbz', rel: '.books/探针样书.fbz', kind: 'fbz', eng: 'foliate' },
  { name: '探针样书.cbz', rel: '.books/探针样书.cbz', kind: 'cbz', eng: 'foliate' },
]

const state = () => evalJs(`document.querySelector('[data-wb="epubReader"]')?.getAttribute('data-wb-state') ?? null`)

/**
 * 三种引擎的「读起来了」判据各不相同，**不能都用 kit 的 `openBook`**（它只等
 * `[data-wb="epubReader"][data-wb-state=ready]`，那是 foliate 系专有）：
 *   foliate → `[data-wb="epubReader"][data-wb-state="ready"]`
 *   txt     → `[data-wb="txtReader"]` 且已排出段落（`p[data-p]`）
 *   pdf     → 左栏三件套切到 pdf（`[data-wb="pdfRailPanel"][data-wb-state="ready"]`）
 *      ★ PDF 阅读面**没有**根 `data-wb` 标记，只有 rail 侧能读到状态；
 *        rail 依赖 `railModule==='bookshelf'`，所以 cycle 里先点左栏书架是可保的。
 * 返回入口三种引擎共用文案「返回书架」（txt/pdf 的按钮没有 data-wb），按文案找即可。
 */
async function waitReady(engine, tries = 40) {
  const sel = engine === 'foliate' ? '[data-wb="epubReader"][data-wb-state="ready"]'
    : engine === 'txt' ? '[data-wb="txtReader"] p[data-p]'
      : '[data-wb="pdfRailPanel"][data-wb-state="ready"]'
  for (let i = 0; i < tries; i++) {
    if (await evalJs(`!!document.querySelector(${JSON.stringify(sel)})`)) return true
    await sleep(250)
  }
  return false
}

/** 书架卡片数（用 `.books/` 前缀判，避开阅读器自身那堆 `button[title]`：目录/缩略图/书签…） */
const shelfCards = () => evalJs(`[...document.querySelectorAll('main button[title]')].filter((b) => (b.getAttribute('title') || '').includes('.books/')).length`)

/**
 * 退到书架并**确认卡片真的在**。连开同一本书时，单次「返回书架」可能没生效
 * （实测：下一轮仍停在阅读器里 ⇒ 点不到卡片，表象是隔次 no-card）——
 * 可能要重复点若干次，必要时再点左栏书签。返回最终是否见到卡片。
 */
async function exitToShelf() {
  for (let i = 0; i < 12; i++) {
    if (await shelfCards() > 0) return true
    const r = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('返回书架'))
      if (!b) return 'no-back'
      b.click(); return 'clicked'
    })()`)
    await sleep(r === 'clicked' ? 700 : 0)
    if (r === 'no-back') { await K.openBookshelf(); await sleep(500) }
  }
  return (await shelfCards()) > 0
}

async function cycle(name, engine) {
  await exitToShelf()
  await evalJs(`window.__roNoise.reset()`)
  let clicked = 'no-card'
  for (let i = 0; i < 4; i++) {
    clicked = await evalJs(`(() => {
      const re = new RegExp(${JSON.stringify(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))} + '$')
      const b = [...document.querySelectorAll('main button[title]')].find((x) => re.test(x.getAttribute('title') || ''))
      if (!b) return 'no-card'
      b.scrollIntoView({ block: 'center' }); b.click(); return 'ok'
    })()`)
    if (clicked === 'ok') break
    await exitToShelf()
  }
  const opened = clicked === 'ok' ? await waitReady(engine) : false
  const st = engine === 'foliate' ? await state() : opened ? 'ready' : null
  const midWarns = await evalJs(`window.__roNoise.warns()`)
  const midDead = await evalJs(`window.__roNoise.leakedFrameTargets()`)
  const midBenign = await evalJs(`window.__roNoise.benignDetached()`)
  const backed = await exitToShelf()
  await sleep(1200)
  const afterWarns = await evalJs(`window.__roNoise.warns()`)
  const afterDead = await evalJs(`window.__roNoise.leakedFrameTargets()`)
  const afterBenign = await evalJs(`window.__roNoise.benignDetached()`)
  return { clicked, opened, st, backed, midWarns, midDead, midBenign, afterWarns, afterDead, afterBenign }
}

// --- 基线与逐本循环 ---
const baseWarns = await evalJs(`window.__roNoise.warns()`)
note('打开任何书之前的告警数（应为 0）', String(baseWarns))

const rows = []
for (const b of BOOKS) {
  const r = await cycle(b.name, b.eng)
  rows.push({ ...b, ...r })
  console.log(`  --   ${b.kind.padEnd(5)} ${b.rel}`)
  console.log(`       打开=${r.opened ? 'ok' : `FAIL(${r.clicked})`}  reader 态=${r.st ?? '—'}`)
  console.log(`       开书期间: 告警 ${r.midWarns}  残留帧观察 ${r.midDead.length}  良性残留 ${r.midBenign.length}`)
  console.log(`       返回之后: 告警 ${r.afterWarns}  残留帧观察 ${r.afterDead.length}  良性残留 ${r.afterBenign.length}`)
  for (const d of r.afterDead) console.log(`         ⚠ 残留帧观察: ${d.sel}   ${d.stack}`)
  for (const d of r.afterBenign) console.log(`         ℹ 良性残留（pdfjs PDFViewer，不产生告警）: ${d.sel}`)
}

// --- 判据 ---
console.log('\n判据：')
for (const r of rows) {
  ok(`${r.kind}：开书期间零 RO 环告警（修前 foliate 系每轮 300~600 条）`,
    r.midWarns === 0, `实际 ${r.midWarns}`)
  ok(`${r.kind}：返回书架后零 RO 环告警`,
    r.afterWarns === 0, `实际 ${r.afterWarns}`)
  ok(`${r.kind}：开书一轮后 ✕ 无「帧已摘掉却仍被观察」的目标（patch ⑧ 的治本判据）`,
    r.afterDead.length === 0, JSON.stringify(r.afterDead))
}
ok('六种格式每次都确实进到 ready —— 挡住「没打开所以没告警」这类假通过',
  rows.every((r) => r.opened && r.st === 'ready'),
  JSON.stringify(rows.map((r) => [r.kind, r.opened, r.st])))

// --- B-24 切片：连开 20 次 PDF，「良性残留」不得累积 ---
// 机制：pdfjs 3.11 的 PDFViewer **每次开书**都在构造期自建一个 RO 并 observe(容器)，且无 destroy()
//   ⇒ 每开一次留一整套 viewer 图（无告警、无自感、单向累积）。补偿 = 宿主 withRoCapture 收下构造期
//   实例、detachViewerDocument 里逐个 disconnect()。
// 判据（治本）：这条链断了，容器脱离文档后仍被观察 ⇒ benignDetached() 每轮 +1 ⇒ 本切片必红。
//   ★ 与判据 A 同风格：不看 GC 时机、不看内存读数，只问「那个观察还在不在」。
const PDF_BOOK = BOOKS.find((b) => b.kind === 'pdf')
const PRE = await evalJs(`window.__roNoise.benignDetached()`)
note('连开 20 次之前的良性残留（应为 0）', String(PRE.length))
const N_OPEN = 20
console.log(`\n连开 ${N_OPEN} 次 PDF（每次开→返回，量 RO 是否累积）：`)
const counts = []
const balance = []
let allReady = true
for (let i = 0; i < N_OPEN; i++) {
  await evalJs(`window.__roNoise.resetStats()`)
  const r = await cycle(PDF_BOOK.name, PDF_BOOK.eng)
  const st = await evalJs(`window.__roNoise.stats()`)
  if (!(r.opened && r.st === 'ready')) allReady = false
  counts.push(r.afterBenign.length)
  // 本轮构造了几个 RO、断了几个：每次开 PDF 应各建 2 个（宿主 measure 一个 + pdfjs viewer 一个）
  // 且返回后都断掉 ⇒ 相等。这是「主判据」的计数形态，补 benignDetached 只看残留。
  balance.push(`${st.constructed}/${st.disconnected}`)
  if (i % 5 === 4 || i === N_OPEN - 1 || i < 3) {
    console.log(`       第 ${i + 1}/${N_OPEN} 次：良性残留 ${r.afterBenign.length}  constructed/disconnected=${st.constructed}/${st.disconnected}  live=${st.live}`)
    for (const d of r.afterBenign) console.log(`         ↳ ${d.sel}  ${d.stack}`)
  }
}
ok(`连开 ${N_OPEN} 次 PDF 每次都确实进到 ready（挡住「没打开所以残留 0」的假通过）`, allReady)
ok(`连开 ${N_OPEN} 次 PDF 每次新建的 RO 都被 disconnect（constructed === disconnected，无漏断）`,
  balance.every((b) => { const [c, d] = b.split('/').map(Number); return c > 0 && c === d }), JSON.stringify(balance))
ok(`连开 ${N_OPEN} 次 PDF 后良性残留恒为 0（PDFViewer 的 RO 每次都被 disconnect，不累积）`,
  PRE.length === 0 && counts.every((c) => c === 0), JSON.stringify(counts))

finish()

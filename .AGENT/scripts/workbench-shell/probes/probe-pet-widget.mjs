/**
 * 桌宠控件运行期探针（2026-09-28，docs/pet-design.md §七 运行时验收）
 *
 * 断的是**契约脚本断不到的那一层**：`verify-workbench-shell.mjs` 只能证明源码里接线都在，
 * 证明不了「点了桌宠图标真的出立绘」「喂食真的落盘并回传」。本探针在真 electron 里跑完整链路：
 *   挂载集 → 切换条点 Cat 图标 → canvas 出非透明像素（立绘已解码绘制）
 *   → window.api.petGet() 往返 + petReset('dog') 归一 → 喂食 → 饱食上升 → pet.json 落盘。
 *
 * 用法：
 *   npm run build                                    # 探针跑 out/ 产物，改 electron/ 或渲染层必重跑
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs \
 *        .AGENT/scripts/workbench-shell/probes/probe-pet-widget.mjs
 *   （隔离宿主自动用 userData `knowbase (dev probe-app)`，需已 seed：
 *     node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9333)
const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const PET_JSON = resolve(ROOT, 'tmp/vault-fixture/.knowbase/modules/pet/pet.json')
const SHOT = resolve(ROOT, 'tmp/probe-pet-widget.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  console.log(`  ✗ ${label}${detail ? '  → ' + detail : ''}`)
  return false
}

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const page = (await res.json()).find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* 等 electron 起来 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((res) => { const id = ++msgId; pending.set(id, { res }); ws.send(JSON.stringify({ id, method, params })) })
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
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id) }
  }

  // 1. 进仓库（未打开仓库时右栏控件区不渲染控件内容）
  for (let i = 0; i < 24; i++) {
    if (await evalJs(`!!document.querySelector('[data-wb-bookmark="editor"]')`).catch(() => false)) break
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/进入|打开|继续/.test(x.textContent)); b?.click(); return true })()`)
    await sleep(500)
  }
  await sleep(600)

  // 2. 展开右栏小工具区（中/下段可见），再切到桌宠控件
  await evalJs(`(() => {
    if (document.querySelector('[data-wb="toolsZone"]')) return true
    const hs = [...document.querySelectorAll('[data-wb="shell"] [title="拖拽或点击展开"]')]
    hs[hs.length - 1]?.click(); return true
  })()`)
  await sleep(700)

  const hasPetBtn = await evalJs(`!!document.querySelector('[data-wb="wsBtn"][data-ws-widget="pet"]')`)
  ok(hasPetBtn, 'P-P1 切换条出现桌宠图标（data-ws-widget=pet，挂载集生效）')
  await evalJs(`document.querySelector('[data-wb="wsBtn"][data-ws-widget="pet"]')?.click()`)
  await sleep(400)

  const hasCanvas = await evalJs(`!!document.querySelector('[data-wb="rightPanel"] canvas')`)
  ok(hasCanvas, 'P-P2 右栏渲染出桌宠 canvas（渲染分支生效）')

  // 3. 等立绘解码绘制：轮询 canvas 非透明像素数
  let painted = 0
  for (let i = 0; i < 30; i++) {
    painted = await evalJs(`(() => {
      const cv = document.querySelector('[data-wb="rightPanel"] canvas'); if (!cv) return -1
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
      let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++
      return n
    })()`).catch(() => -1)
    if (painted > 500) break
    await sleep(400)
  }
  ok(painted > 500, 'P-P3 canvas 出现立绘像素（PNG 已解码并由 rAF 绘制）', `非透明像素=${painted}`)

  const labels = await evalJs(`(() => {
    const t = document.querySelector('[data-wb="rightPanel"]')?.textContent || ''
    return { hunger: /饱食/.test(t), mood: /心情/.test(t), feed: /喂食/.test(t), name: /小狗|小猫/.test(t) }
  })()`)
  ok(labels.hunger && labels.mood && labels.feed, 'P-P4 状态条 + 互动按钮齐（饱食/心情/喂食）', JSON.stringify(labels))

  // 3b. 布局几何（第二轮改版）：内容贴底、工具条置顶、中部留白 —— 契约断不到「看起来对不对」
  const geom = await evalJs(`(() => {
    const tb = document.querySelector('[data-wb="petToolbar"]')
    const bt = document.querySelector('[data-wb="petBottom"]')
    if (!tb || !bt) return null
    const wrap = tb.parentElement
    const r = wrap.getBoundingClientRect(), tr = tb.getBoundingClientRect(), br = bt.getBoundingClientRect()
    return { wrapH: Math.round(r.height), gapTop: Math.round(tr.top - r.top), gapBottom: Math.round(r.bottom - br.bottom) }
  })()`)
  ok(geom && geom.wrapH > 150, 'P-P4b 桌宠撑满槽位整高（h-full 生效，非内容高度）', JSON.stringify(geom))
  ok(geom && geom.gapTop <= 6 && geom.gapBottom <= 6,
    'P-P4c 工具条贴顶 + 底部组贴底（中部留白，内容整体下移）', JSON.stringify(geom))

  // 4. IPC 往返 + 归一（petReset 顺带验证 reset 通道）
  const reset = await evalJs(`window.api.petReset('dog')`)
  ok(reset && reset.hunger === 80 && reset.mood === 80 && reset.stage === 0 && reset.species === 'dog',
    'P-P5 pet:reset 往返（归一到幼年小狗 饱食80/心情80/stage0）', JSON.stringify(reset))
  const snap = await evalJs(`window.api.petGet()`)
  ok(snap && typeof snap.activity === 'number' && typeof snap.ts === 'number' && snap.version === 1,
    'P-P6 pet:get 往返（含 activity/ts/version 结算字段）', JSON.stringify({ activity: snap?.activity, ts: !!snap?.ts }))

  // 5. 喂食：饱食应上升（默认 80 → +30 封顶 100；同时心情 +10）
  const before = await evalJs(`window.api.petGet()`)
  await evalJs(`(() => { const b=[...document.querySelectorAll('[data-wb="rightPanel"] button')].find(x=>/喂食/.test(x.textContent)); b?.click(); return !!b })()`)
  await sleep(900)
  const after = await evalJs(`window.api.petGet()`)
  ok(after.hunger > before.hunger && after.mood > before.mood,
    'P-P7 喂食后饱食与心情上升（点按钮 → pet:feed 落盘 → 回传新快照）',
    `before h=${Math.round(before.hunger)} m=${Math.round(before.mood)} / after h=${Math.round(after.hunger)} m=${Math.round(after.mood)}`)
  ok(after.exp > before.exp, 'P-P8 喂食加成长值（exp 上升）', `exp ${before.exp} → ${after.exp}`)

  // 6. 磁盘落盘：pet.json 唯一真相源
  ok(existsSync(PET_JSON), 'P-P9 pet.json 落盘 .knowbase/modules/pet/pet.json', PET_JSON)
  if (existsSync(PET_JSON)) {
    const disk = JSON.parse(readFileSync(PET_JSON, 'utf8'))
    ok(disk.species === 'dog' && disk.hunger === after.hunger, 'P-P10 磁盘值 = IPC 回传值（主进程结算后写回一致）',
      `disk.hunger=${disk.hunger} ipc=${after.hunger}`)
  }

  // 7. 切换宠物（第二轮）：菜单 UI 可开 + 切品种保留进度 + 每品种名字各记各的
  const beforeSwitch = await evalJs(`window.api.petRename('阿豆')`)   // 给狗起个专属名，验「名字跟着宠物走」
  await evalJs(`document.querySelector('[data-wb="petMenuBtn"]')?.click()`)
  await sleep(350)
  ok(await evalJs(`!!document.querySelector('[data-wb="petMenu"]')`),
    'P-P11 ⋯ 菜单可打开（portal 弹出：切换宠物 / 改名 / 重新养一只）')
  await evalJs(`document.querySelector('[data-pet-species="cat"]')?.click()`)
  await sleep(450)
  const toCat = await evalJs(`window.api.petGet()`)
  ok(toCat.species === 'cat', 'P-P12 点菜单「小猫」完成切换（走 UI 路径，非仅 IPC）', toCat.species)
  ok(Math.round(toCat.exp) === Math.round(beforeSwitch.exp) && Math.round(toCat.hunger) === Math.round(beforeSwitch.hunger) && toCat.stage === beforeSwitch.stage,
    'P-P13 切换**保留进度**：exp/hunger/stage 一位不动（本轮核心不变量）',
    `exp ${beforeSwitch.exp}→${toCat.exp} hunger ${Math.round(beforeSwitch.hunger)}→${Math.round(toCat.hunger)}`)
  ok(toCat.name === '小猫', 'P-P14 切到小猫显示猫自己的名字（不是狗名「阿豆」）', toCat.name)
  const backDog = await evalJs(`window.api.petSwitchSpecies('dog')`)
  ok(backDog.species === 'dog' && backDog.name === '阿豆',
    'P-P15 切回小狗恢复狗自己的名字「阿豆」（名字跟着宠物走，各记各的）', backDog.name)

  // 8. 气泡几何（可见态）：应浮在立绘正上方（底边贴 canvas 顶边）、不压住立绘
  await sleep(1000)   // 等上一个瞬时动画（happy 880ms）结束，否则 onTouch 会被动画闸门挡下、测到旧气泡
  await evalJs(`[...document.querySelectorAll('[data-wb="petToolbar"] button')].find(b=>/摸摸头/.test(b.textContent))?.click()`)
  await sleep(250)
  const bg = await evalJs(`(() => {
    const cv = document.querySelector('[data-wb="rightPanel"] canvas')
    const bub = document.getElementById('pet-widget-bubble')
    if (!cv || !bub) return null
    return { canvasTop: Math.round(cv.getBoundingClientRect().top), bubbleBottom: Math.round(bub.getBoundingClientRect().bottom), bubbleH: Math.round(bub.getBoundingClientRect().height) }
  })()`)
  ok(bg && bg.bubbleH > 20 && bg.bubbleBottom <= bg.canvasTop && bg.canvasTop - bg.bubbleBottom <= 10,
    'P-P16 气泡浮在立绘正上方（底边贴 canvas 顶边 ±10px，用上中部留白）', JSON.stringify(bg))

  // 9. 截图存证
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot?.data) { writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); console.log(`  截图 → ${SHOT}`) }
  } catch { /* 截图非判据 */ }

  console.log(`\n${fails.length === 0 ? '✅' : '❌'} 桌宠探针：${pass} PASS / ${fails.length} FAIL`)
  for (const f of fails) console.log('  · ' + f)
  process.exit(fails.length === 0 ? 0 : 1)
}
main().catch((e) => { console.error('桌宠探针失败:', e.message); process.exit(2) })

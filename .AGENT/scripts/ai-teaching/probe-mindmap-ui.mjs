#!/usr/bin/env node
/**
 * 真机探针：思维导图（Phase 1 只读 + Phase 2 编辑）。
 *
 * 走 devbridge（`KNOWBASE_DEV_BRIDGE=1` 构建 + `run-probe-app.mjs` 隔离实例）：
 *  1) Node 侧直写 fixture 仓库（导图 JSON + mermaid md）
 *  2) `kb-open-note` 打开导图 → 笔记区 PageEditor 按内容识别 → 共享 MindMapView 渲染
 *  3) Phase 1：节点数 / 单击折叠 / ref 跳转 / 源码切换 / mermaid 渲染出 SVG
 *  4) Phase 2：双击改字 / 悬停 + 增子 / 悬停 × 删 / Ctrl+Z 撤销 / 拖拽重挂（防环）
 *
 * ⚠️ 节点交互一律走 CDP 真实鼠标：devbridge 的 text= 定位器对非交互元素会「下钻到内部第一个
 *    可交互后代」，而节点里藏着 hover 才显示的 +/× 按钮（display:none）→ 会误判不可见。
 *
 * 运行（仓库根）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/ai-teaching/probe-mindmap-ui.mjs
 * 前置：① KNOWBASE_DEV_BRIDGE=1 npm run build；② seed 用 --ud "knowbase (dev probe-app)"
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:' + (process.env.KNOWBASE_DEV_BRIDGE_PORT ?? '7465')
const CDP_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -- ' + detail}`)
  if (!ok) fails++
}

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const j = await res.json()
  if (!j.ok) throw new Error(`${path} -> ${JSON.stringify(j.error).slice(0, 300)}`)
  return j.data ?? j
}
const act = (name, params) => api('/action', { name, params })
const evalR = async (code) => { const r = await act('ui.eval', { code }); return r?.result?.result ?? r?.result ?? r }
const shot = async (label) => { const r = await api('/ui/screenshot'); console.log(`[SHOT] ${label} -> ${r.file}`) }
const openNote = (rel) => evalR(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: ${JSON.stringify(rel)}, from: 'knowledge' } })); 'ok'`)
const waitText = (text, timeoutMs = 12000) => act('ui.wait', { text, timeoutMs })

// ---- CDP（节点点击 / 悬停 / 拖拽需要真实鼠标事件）----
let cdp = null
async function connectCdp() {
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json())
  const page = targets.find(t => t.type === 'page' && !/devtools/.test(t.url)) ?? targets.find(t => t.type === 'page')
  if (!page) throw new Error('CDP 无 page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws open 超时')), 5000); ws.onopen = () => { clearTimeout(t); res() }; ws.onerror = () => { clearTimeout(t); rej(new Error('ws 失败')) } })
  let seq = 0; const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  cdp = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq; pending.set(i, (m) => res(m))
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP ${method} 超时`)) } }, 10000)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await cdp('Runtime.enable')
}
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra })
const rectOfNode = async (text) => JSON.parse(await evalR(`JSON.stringify((()=>{ const el=[...document.querySelectorAll('.mm-node')].find(e=>(e.textContent||'').includes(${JSON.stringify(text)})); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })())`))
async function clickNode(text, dbl = false) {
  const a = await rectOfNode(text); if (!a) throw new Error('节点缺失: ' + text)
  await mouse('mousePressed', a.x, a.y, { clickCount: 1 }); await mouse('mouseReleased', a.x, a.y, { clickCount: 1 })
  if (dbl) { await sleep(60); await mouse('mousePressed', a.x, a.y, { clickCount: 2 }); await mouse('mouseReleased', a.x, a.y, { clickCount: 2 }) }
  await sleep(350)
}
async function dragNode(fromText, toText) {
  const a = await rectOfNode(fromText), b = await rectOfNode(toText)
  if (!a || !b) throw new Error(`拖拽靶缺失: ${fromText}->${toText}`)
  await mouse('mousePressed', a.x, a.y, { clickCount: 1 })
  await sleep(60)
  await mouse('mouseMoved', (a.x + b.x) / 2, (a.y + b.y) / 2)
  await sleep(60)
  await mouse('mouseMoved', b.x, b.y)
  await sleep(120)
  await mouse('mouseReleased', b.x, b.y, { clickCount: 1 })
  await sleep(500)
}
async function hoverNodeBtn(nodeText, which) {
  const a = await rectOfNode(nodeText)
  if (!a) throw new Error('hover 靶缺失: ' + nodeText)
  await mouse('mouseMoved', a.x, a.y)
  await sleep(250)
  const r = JSON.parse(await evalR(`JSON.stringify((()=>{ const el=[...document.querySelectorAll('.mm-node')].find(e=>(e.textContent||'').includes(${JSON.stringify(nodeText)})); const bs=el?el.querySelectorAll('.mm-node-act button'):[]; const b=bs[${which === 'add' ? 0 : 1}]; if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })())`))
  if (!r) throw new Error(`节点按钮缺失: ${nodeText}/${which}`)
  await mouse('mousePressed', r.x, r.y, { clickCount: 1 })
  await mouse('mouseReleased', r.x, r.y, { clickCount: 1 })
  await sleep(400)
}

async function main() {
  // ---- 1. fixture ----
  const root = join(process.cwd(), 'tmp', 'vault-fixture')
  const mmPath = join(root, 'AI教学', '探针导图.json')
  mkdirSync(join(root, 'AI教学'), { recursive: true })
  mkdirSync(join(root, '学习笔记'), { recursive: true })
  const mm = {
    kind: 'mindmap', version: 1, title: '探针导图',
    root: { text: '根节点', children: [
      { text: '分支甲', children: [{ text: '叶子一', ref: '学习笔记/笔记一.md' }, { text: '叶子二' }] },
      { text: '分支乙' },
    ] },
  }
  writeFileSync(mmPath, JSON.stringify(mm, null, 2), 'utf8')
  writeFileSync(join(root, '学习笔记', '探针mermaid.md'),
    '# 探针文档\n\n```mermaid\nmindmap\n  root((测试根))\n    A\n    B\n```\n', 'utf8')
  const readFixture = () => readFileSync(mmPath, 'utf8')

  // ---- 2. 等 devbridge + CDP ----
  let up = false
  for (let i = 0; i < 90; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪（构建是否带 KNOWBASE_DEV_BRIDGE=1？）')
  await sleep(2500)
  await connectCdp()
  await evalR(`(async()=>{ try{ await window.api.setSetting('onboardingDone', true) }catch(e){}; return 'ok' })()`)

  // ---- 3. 打开导图（Phase 1）----
  await openNote('AI教学/探针导图.json')
  await waitText('根节点', 20000)
  await sleep(600)
  const n1 = await evalR(`document.querySelectorAll('.mm-node').length`)
  check('导图渲染：节点数 = 5', n1 === 5, 'got ' + n1)
  await shot('10-mindmap')

  // 回归：折叠 / 展开不得触发自动 fit（结构变、视角应静默）
  const stageScale = async () => await evalR(`(()=>{const c=document.querySelector('.mm-canvas'); if(!c) return null; const st=c.querySelector('.origin-top-left')||c.firstElementChild; const m=(st.getAttribute('style')||'').match(/scale\\(([^)]+)\\)/); return m?parseFloat(m[1]):null})()`)
  const scaleBeforeFold = await stageScale()

  await clickNode('分支甲')
  await sleep(400)
  check('单击折叠：5 → 3', (await evalR(`document.querySelectorAll('.mm-node').length`)) === 3)
  const scaleAfterFold = await stageScale()
  check('折叠不触发自动 fit（scale 不变）', typeof scaleBeforeFold === 'number' && Math.abs(scaleAfterFold - scaleBeforeFold) < 1e-3, `${scaleBeforeFold} -> ${scaleAfterFold}`)
  await clickNode('分支甲')
  await sleep(400)
  check('再点展开：3 → 5', (await evalR(`document.querySelectorAll('.mm-node').length`)) === 5)
  const scaleAfterExpand = await stageScale()
  check('展开不触发自动 fit（scale 不变）', typeof scaleAfterExpand === 'number' && Math.abs(scaleAfterExpand - scaleBeforeFold) < 1e-3, `${scaleBeforeFold} -> ${scaleAfterExpand}`)

  await evalR(`window.__kbRef = []; window.addEventListener('kb-open-note', e => { window.__kbRef.push(e.detail && e.detail.relPath) }); 'ok'`)
  await clickNode('叶子一')
  await sleep(700)
  check('点 ref 节点触发 kb-open-note(笔记一.md)', String(await evalR(`JSON.stringify(window.__kbRef || [])`)).includes('学习笔记/笔记一.md'))

  await openNote('AI教学/探针导图.json')
  await waitText('根节点', 10000)

  // ---- 4. Phase 2：双击改字 ----
  await clickNode('叶子二', true)
  await act('ui.wait', { target: '.mm-node input', timeoutMs: 6000 })
  await act('ui.type', { target: '.mm-node input', text: '改后叶子', clear: true })
  await act('ui.key', { key: 'Enter' })
  await sleep(1100)
  check('双击改字：节点文字已更新', await evalR(`[...document.querySelectorAll('.mm-node')].some(e => (e.textContent||'').includes('改后叶子'))`))
  check('双击改字：已落盘', readFixture().includes('改后叶子'))
  await shot('50-edited')

  // ---- 5. Phase 2：悬停 + 增子节点 ----
  const beforeAdd = await evalR(`document.querySelectorAll('.mm-node').length`)
  await hoverNodeBtn('分支乙', 'add')
  await sleep(400)
  const afterAdd = await evalR(`document.querySelectorAll('.mm-node').length`)
  check('悬停 + 增子节点：节点数 +1', afterAdd === beforeAdd + 1, `${beforeAdd} -> ${afterAdd}`)

  // ---- 6. Phase 2：Ctrl+Z 撤销 ----
  await act('ui.key', { key: 'z', modifiers: ['ctrl'] })
  await sleep(500)
  check('Ctrl+Z 撤销：节点数回退', (await evalR(`document.querySelectorAll('.mm-node').length`)) === beforeAdd)

  // ---- 7. Phase 2：悬停 × 删节点 ----
  await hoverNodeBtn('分支乙', 'del')
  await sleep(500)
  check('悬停 × 删节点：节点数 -1', (await evalR(`document.querySelectorAll('.mm-node').length`)) === beforeAdd - 1)
  await act('ui.key', { key: 'z', modifiers: ['ctrl'] })
  await sleep(500)

  // ---- 8. Phase 2：拖拽重挂（分支乙 → 分支甲 下）----
  await dragNode('分支乙', '分支甲')
  await sleep(1100)
  check('拖拽重挂：分支乙 成为 分支甲 的子节点（已落盘）', /分支甲[\s\S]*children[\s\S]*分支乙/.test(readFixture()))
  await shot('60-dragged')

  // ---- 9. 源码切换（Phase 1）----
  await act('ui.click', { target: 'text=查看/编辑 JSON 源码' })
  await waitText('保存并重新渲染', 12000)
  check('源码切换：出现「保存并重新渲染」', true)
  const srcBtns = String(await evalR(`JSON.stringify([...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(t => t === '取消' || t === '保存并重新渲染'))`))
  check('源码页脚含「取消」+「保存并重新渲染」', srcBtns.includes('取消') && srcBtns.includes('保存并重新渲染'), srcBtns)
  await act('ui.click', { target: 'text=← 返回导图' })
  await waitText('根节点', 8000)
  check('源码返回：回到导图', true)

  // ---- 9b. 滚轮缩放（回归：map⇄source 会重建画布 DOM，监听/自动 fit 必须重新附着）----
  const wheelScale = async () => await evalR(`(()=>{const c=document.querySelector('.mm-canvas'); if(!c) return null; const st=c.querySelector('.origin-top-left')||c.firstElementChild; const m=(st.getAttribute('style')||'').match(/scale\\(([^)]+)\\)/); return m?parseFloat(m[1]):null})()`)
  const zBefore = await wheelScale()
  const wheelConsumed = await evalR(`(()=>{const c=document.querySelector('.mm-canvas'); if(!c) return false; const r=c.getBoundingClientRect(); const e=new WheelEvent('wheel',{deltaY:-120,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}); return !c.dispatchEvent(e)})()`)
  await sleep(200)
  const zAfter = await wheelScale()
  check('滚轮缩放：执行 map→source→map 后仍生效（scale 增大）', wheelConsumed === true && typeof zBefore === 'number' && typeof zAfter === 'number' && zAfter > zBefore, `${zBefore} -> ${zAfter} consumed=${wheelConsumed}`)

  // ---- 10. mermaid 渲染 ----
  await openNote('学习笔记/探针mermaid.md')
  await waitText('探针文档', 12000)
  let svgFound = false
  for (let i = 0; i < 40; i++) { if (await evalR(`!!document.querySelector('svg[id^="kb-mermaid-"]')`)) { svgFound = true; break } await sleep(500) }
  check('mermaid：渲染出 SVG', svgFound)
  await shot('40-mermaid')

  console.log(fails === 0 ? '\nPASS —— 思维导图真机探针通过' : `\nFAIL —— ${fails} 项未过`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })

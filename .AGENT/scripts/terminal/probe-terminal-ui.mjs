/**
 * 终端 UI 端到端探针：经 devbridge(7465) 驱动真实窗口 —— 打开终端 Tab、真实键盘输入
 * ASCII 与中文、逐步截图，供人眼比对渲染质量（乱码 / 重复字符 / 光标错位）。
 *
 * 前置：KNOWBASE_DEV_BRIDGE=1 npm run build
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui.mjs --no-sandbox --disable-gpu
 * 产物：截图绝对路径（进程 stdout 逐行打印）
 */
import { mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:7465'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const j = await res.json()
  if (!j.ok) throw new Error(`${path} -> ${JSON.stringify(j.error).slice(0, 300)}`)
  return j.data ?? j
}

async function shot(label) {
  const r = await api('/ui/screenshot')
  console.log(`[SHOT] ${label} -> ${r.file}`)
  return r.file
}

async function main() {
  // 1. 等桥就绪
  let up = false
  for (let i = 0; i < 60; i++) {
    try { await api('/health'); up = true; break } catch { await sleep(1000) }
  }
  if (!up) throw new Error('devbridge 60s 未就绪')
  console.log('[OK] devbridge 就绪')
  await sleep(2500) // 等工作台首屏

  // 2. 打开终端 Tab（左栏书签）
  try {
    await api('/action', { name: 'ui.click', params: { target: 'text=终端' } })
    console.log('[OK] 已点击「终端」书签')
  } catch (e) {
    console.log('[WARN] text=终端 未命中，dump UI 树前 40 项：')
    const tree = await api('/ui/tree')
    for (const it of (tree.items ?? []).slice(0, 40)) console.log(`  #${it.i} <${it.tag}> ${String(it.text).slice(0, 40)}`)
    await shot('01-fail-tree')
    throw e
  }
  await api('/action', { name: 'ui.wait', params: { target: '.xterm', timeoutMs: 20000 } })
  console.log('[OK] xterm 已挂载')
  await sleep(3500) // 等 shell banner + 提示符
  await shot('02-boot')

  // 3. ASCII 命令输入
  await api('/action', { name: 'ui.type', params: { target: '.xterm-helper-textarea', text: 'echo TERM_ASCII_OK_9137' } })
  await api('/action', { name: 'ui.key', params: { key: 'Enter' } })
  await sleep(1500)
  await shot('03-ascii')

  // 4. 中文输入（真实 insertText 路径）
  await api('/action', { name: 'ui.type', params: { target: '.xterm-helper-textarea', text: 'echo 你好终端中文测试' } })
  await api('/action', { name: 'ui.key', params: { key: 'Enter' } })
  await sleep(1500)
  await shot('04-cjk')

  // 5. 多行输出（滚动/重绘压力）
  await api('/action', { name: 'ui.type', params: { target: '.xterm-helper-textarea', text: 'dir' } })
  await api('/action', { name: 'ui.key', params: { key: 'Enter' } })
  await sleep(2500)
  await shot('05-dir')

  // 6. 渲染层错误
  const errs = await api('/errors')
  const list = errs.items ?? errs.errors ?? []
  console.log(`[INFO] 渲染层错误 ${list.length} 条`)
  for (const e of list.slice(0, 5)) console.log(`  [ERR] ${String(e.message ?? '').slice(0, 160)}`)

  console.log('PASS —— 终端 UI 探针跑完，见上方截图路径')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })

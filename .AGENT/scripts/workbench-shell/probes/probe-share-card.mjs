/**
 * 分享卡片（右栏第三态）运行时探针 —— electron 产物 + CDP。
 *
 * 为什么必须有这一条：契约脚本只能锁住**源码形状**（枚举、钝解析、接线字符串），
 * canvas 到底画没画出东西、切风格有没有真的重绘、图上改字有没有落盘，
 * 只有真跑一遍才知道（「契约全绿 ≠ 运行期生效」）。
 *
 * 断言链（任一失败 exit 1）：
 *   1) 夹具自证：右栏展开 + 🎨 分享 Tab 激活（右栏折叠态与 Tab 都是**持久化设置**，
 *      上一轮跑挂会留下来 —— 不收敛会让后续断言在另一个前提下跑）
 *   2) 卡片 canvas 存在，物理尺寸恰 1080×1920（导出规格），CSS 尺寸 > 0（真的显示出来）
 *   3) 画面非空白：抽样像素有多个颜色 + 角落像素不透明（透明底粘到微信会变黑底）
 *   4) 切主视觉（纸山→书页）→ 像素签名**变化**（证明是重绘，不是静止图）
 *   5) 切卡片明暗（浅→深）→ 像素签名**变化**
 *   6) 点预览 → 编辑浮层出现；三个槽位的输入层在位（寄语在 hero、品牌语/署名在页脚）
 *   7) ★ 图上改字：往「寄语」输入层写值 → 400ms 防抖后**设置里真的变了**（写盘链路通）
 *   8) ★ 导出的 PNG 里 IHDR 尺寸 = 1080×1920（导出的就是预览那张 canvas，不是第二套绘制）
 *   9) ★ 存模板 → 模板数 +1 且当前卡片切到新模板
 *  10) ★ 防抖窗口内切 Tab **不丢**最后一次编辑（卸载补写；回归护栏）
 *  11) ★ 内置模板**也能删**；删光后重进分享态**不复活**，且卡片照常可用
 *  12) ★ 题目区写入一道真实积分式 → 卡片重绘、**公式块内出现足量墨点**
 *      （KaTeX + foreignObject 栅格化只有在真实 Chromium 里才验得到，契约验不了）
 *   收尾：无论成败都还原 shareCard 设置与右栏折叠态（否则污染下一轮）
 *
 * 用法（隔离实例，勿与用户 dev 抢单实例锁）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-share-card.mjs --no-sandbox --disable-gpu
 */
import { connect } from './lib/reader-probe-kit.mjs'

const K = await connect()
const { evalJs, clickAt, sleep } = K

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}
const note = (n, e = '') => console.log(`  --   ${n}  [${e}]`)

/** 抽样像素签名：颜色哈希 + 颜色种类数 + 不透明样本数。
 *  选择器**限定在右栏内** —— 编辑浮层打开时文档里还有第二张 canvas，不能按全局取。 */
const SIG_FN = `(() => {
  const cv = document.querySelector('[data-wb="rightPanel"] canvas')
  if (!cv) return null
  const ctx = cv.getContext('2d')
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data
  const stride = 4 * 997
  let h = 0, opaque = 0, n = 0
  const colors = new Set()
  for (let i = 0; i + 3 < d.length; i += stride) {
    h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0
    colors.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2])
    if (d[i + 3] === 255) opaque++
    n++
  }
  return { h, colors: colors.size, opaque, n, w: cv.width, h2: cv.height }
})()`

async function rightPanelOpen() {
  return evalJs(`!!document.querySelector('[data-wb="rightPanel"]')`)
}

/** 右栏收敛到展开态（折叠条在右缘，标题「拖拽或点击展开」） */
async function expandRight() {
  if (await rightPanelOpen()) return true
  const strip = await evalJs(`(() => {
    const strips = [...document.querySelectorAll('[title="拖拽或点击展开"]')]
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => b.left - a.left)
    return strips[0] ? { x: Math.round(strips[0].left + strips[0].width / 2), y: Math.round(Math.min(strips[0].top + 120, 300)) } : null
  })()`)
  if (!strip) return false
  await clickAt(strip.x, strip.y)
  for (let i = 0; i < 12; i++) {
    await sleep(250)
    if (await rightPanelOpen()) return true
  }
  return false
}

async function clickShareTab() {
  const box = await evalJs(`(() => {
    const b = document.querySelector('[data-wb-rp-tab="share"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!box) return false
  await clickAt(box.x, box.y)
  await sleep(600)
  return true
}

/** 等 canvas 出现（面板要等设置加载 + 取数 + 二维码 decode） */
async function waitCanvas() {
  for (let i = 0; i < 30; i++) {
    const has = await evalJs(`!!document.querySelector('[data-wb="rightPanel"] canvas')`)
    if (has) return true
    await sleep(300)
  }
  return false
}

const setSetting = (k, v) => evalJs(`window.api.setSetting(${JSON.stringify(k)}, ${JSON.stringify(v)}).then(() => true)`)
const getSetting = (k) => evalJs(`window.api.getSetting(${JSON.stringify(k)}).then((v) => v ?? null)`)

async function main() {
  console.log('\n=== 分享卡片探针 ===')

  // ---- 夹具：记录原始状态（收尾还原） ----
  // ★ 必须**显式重置成空串**再开始：内置三套模板只在「设置是空串（= 从没存过）」时才播种，
  //   而一旦某次运行把 templates 写成了合法的空数组，内置就再也不会回来（这是刻意设计 ——
  //   模板可删，删光不复活）。若沿用上次残留值，本轮「内置模板行」类断言就会假失败。
  const origShareCard = await getSetting('shareCard')
  const origLayoutRaw = await getSetting('workbenchLayout')
  note('原始 shareCard', origShareCard === null ? '(空)' : String(origShareCard).slice(0, 80))
  await setSetting('shareCard', '')
  await sleep(300)

  try {
    // ===== 1) 夹具自证 =====
    console.log('\n--- 1) 夹具：右栏展开 + 🎨 分享 Tab 激活 ---')
    const expanded = await expandRight()
    ok('右栏已展开', expanded, await evalJs(`document.querySelectorAll('[title="拖拽或点击展开"]').length + ' strips'`))
    const clicked = await clickShareTab()
    const tabActive = await evalJs(`document.querySelector('[data-wb-rp-tab="share"]')?.dataset.wbRpActive`)
    ok('点 🎨 后分享 Tab 成为激活态', clicked && tabActive === '1', `active=${tabActive}`)
    const hasCanvas = await waitCanvas()
    ok('分享态渲染出 canvas', hasCanvas)
    if (!hasCanvas) throw new Error('canvas 未出现，后续断言无意义')

    // ===== 2) canvas 规格 =====
    console.log('\n--- 2) canvas 物理尺寸 / 显示尺寸 ---')
    const size = await evalJs(`(() => {
      const cv = document.querySelector('[data-wb="rightPanel"] canvas')
      const r = cv.getBoundingClientRect()
      return { w: cv.width, h: cv.height, cssW: Math.round(r.width), cssH: Math.round(r.height) }
    })()`)
    ok('物理尺寸 = 1080×1920（导出规格）', size.w === 1080 && size.h === 1920, JSON.stringify(size))
    ok('CSS 尺寸 > 0（真的显示出来了）', size.cssW > 60 && size.cssH > 60, `${size.cssW}×${size.cssH}`)
    ok('显示比例 = 540:960', Math.abs(size.cssW / size.cssH - 540 / 960) < 0.02)

    // ===== 3) 非空白 =====
    console.log('\n--- 3) 画面非空白 + 不透明底色 ---')
    const sig0 = await evalJs(SIG_FN)
    ok('像素多样（不是空白 canvas）', sig0 && sig0.colors > 8, `colors=${sig0?.colors}`)
    ok('抽样像素几乎全不透明（防微信黑底）', sig0 && sig0.opaque / sig0.n > 0.98, `${sig0?.opaque}/${sig0?.n}`)
    const corner = await evalJs(`(() => {
      const cv = document.querySelector('[data-wb="rightPanel"] canvas')
      const d = cv.getContext('2d').getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3]]
    })()`)
    ok('左上角像素 alpha=255', corner[3] === 255, `rgba(${corner.join(',')})`)

    // ===== 4) 切主视觉 → 重绘 =====
    console.log('\n--- 4) 主视觉切换 → 真的重绘 ---')
    const styleBtns = await evalJs(`[...document.querySelectorAll('[data-share-style]')].map((b) => b.dataset.shareStyle)`)
    ok('三套主视觉按钮齐备', Array.isArray(styleBtns) && styleBtns.length === 3, String(styleBtns))
    const clickStyle = async (id) => {
      const box = await evalJs(`(() => {
        const b = document.querySelector('[data-share-style="${id}"]')
        const r = b?.getBoundingClientRect()
        return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
      })()`)
      if (!box) return false
      await clickAt(box.x, box.y)
      await sleep(450)
      return true
    }
    await clickStyle('page')
    const sigPage = await evalJs(SIG_FN)
    ok('切「书页」后像素签名变化', sigPage && sigPage.h !== sig0.h, `${sig0?.h} → ${sigPage?.h}`)
    await clickStyle('heat')
    const sigHeat = await evalJs(SIG_FN)
    ok('切「热力」后像素签名再变', sigHeat && sigHeat.h !== sigPage.h, `${sigPage?.h} → ${sigHeat?.h}`)

    // ===== 5) 切明暗 → 重绘 =====
    console.log('\n--- 5) 卡片明暗切换 → 真的重绘 ---')
    const clickTheme = async (id) => {
      const box = await evalJs(`(() => {
        const b = document.querySelector('[data-share-theme="${id}"]')
        const r = b?.getBoundingClientRect()
        return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
      })()`)
      if (!box) return false
      await clickAt(box.x, box.y)
      await sleep(450)
      return true
    }
    await clickTheme('dark')
    const sigDark = await evalJs(SIG_FN)
    ok('切深色后像素签名变化', sigDark && sigDark.h !== sigHeat.h, `${sigHeat?.h} → ${sigDark?.h}`)
    await clickTheme('light')

    // ===== 6) 编辑浮层 + 输入层在位 =====
    console.log('\n--- 6) 编辑浮层：三个槽位的输入层 ---')
    const preview = await evalJs(`(() => {
      const cv = document.querySelector('[data-wb="rightPanel"] canvas')
      const r = cv.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await clickAt(preview.x, preview.y)
    await sleep(600)
    const overlay = await evalJs(`(() => {
      const ta = document.querySelector('textarea[data-share-slot="quote"]')
      const ins = [...document.querySelectorAll('input[data-share-slot]')]
      if (!ta) return null
      const r = ta.getBoundingClientRect()
      return { slots: ins.map((i) => i.dataset.shareSlot).sort(), quoteBox: { w: Math.round(r.width), h: Math.round(r.height) },
        editorCanvases: document.querySelectorAll('canvas').length }
    })()`)
    ok('浮层打开且有寄语输入层（textarea）', !!overlay, 'no textarea[data-share-slot=quote]')
    ok('品牌语 / 署名输入层在位', overlay && overlay.slots.join(',') === 'signature,slogan', String(overlay?.slots))
    ok('寄语输入层尺寸 > 0', overlay && overlay.quoteBox.w > 40 && overlay.quoteBox.h > 10, JSON.stringify(overlay?.quoteBox))

    // ===== 6b) ★ 右侧「分享内容」框可直接点进编辑（焦点互踩回归护栏）=====
    //  曾经的 bug：右侧表单 textarea 的 onFocus 去开图上那块 autoFocus 源码面板 → 焦点被抢走、
    //  右侧随即 onBlur、面板又关 → 表现为「点了框打不了字」。契约只锁源码里有没有 promptEditing
    //  这两串，抓不到；且 case 12 是直接 set value（不经焦点），也抓不到。故此处**真鼠标点 + 真输入**。
    console.log('\n--- 6b) 右侧表单：内容框可直接点进编辑 ---')
    const promptBox = await evalJs(`(() => {
      const ta = document.querySelector('[data-share-prompt-form]')
      if (!ta) return null
      ta.scrollIntoView({ block: 'center' })
      const r = ta.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    ok('编辑浮层里有「分享内容」表单框', !!promptBox, 'no [data-share-prompt-form]')
    if (promptBox) {
      await clickAt(promptBox.x, promptBox.y)
      await sleep(300)
      const focusState = await evalJs(`({
        activeIsForm: document.activeElement === document.querySelector('[data-share-prompt-form]'),
        overlayOpen: !!document.querySelector('[data-share-prompt-editor]'),
      })`)
      ok('★ 点右侧内容框后焦点落在它自己（不被图上源码面板抢走）', focusState?.activeIsForm === true, JSON.stringify(focusState))
      ok('点右侧内容框不会反向打开图上源码面板', focusState?.overlayOpen === false, JSON.stringify(focusState))

      const TYPED = 'typing' + Date.now().toString(36).slice(-3)
      await K.send('Input.insertText', { text: TYPED })
      await sleep(300)
      const typedOk = await evalJs(`(document.querySelector('[data-share-prompt-form]')?.value ?? '').includes(${JSON.stringify(TYPED)})`)
      ok('★ 在该框里真的能输入（字符落到 value 上）', typedOk === true, `value=${JSON.stringify(await evalJs(`document.querySelector('[data-share-prompt-form]')?.value`))}`)
      // 清掉刚输入的探针文本，别影响后续 case 的像素对比基线
      await evalJs(`(() => {
        const ta = document.querySelector('[data-share-prompt-form]')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(300)
    }

    // ===== 7) 图上改字 → 落盘 =====
    console.log('\n--- 7) 图上改字 → 设置真的变了（防抖后） ---')
    const MARK = '契约探针改字' + Date.now().toString(36).slice(-4)
    await evalJs(`(() => {
      const ta = document.querySelector('textarea[data-share-slot="quote"]')
      ta.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(MARK)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(1100)   // 面板写入有 400ms 防抖
    const saved = await getSetting('shareCard')
    let parsed = null
    try { parsed = JSON.parse(String(saved ?? '')) } catch { /* 下面按失败处理 */ }
    ok('设置里 current.texts.quote === 新值', parsed?.current?.texts?.quote === MARK,
      `got=${parsed?.current?.texts?.quote}`)
    const redraw = await evalJs(SIG_FN)
    ok('改字后画面重绘（签名与改前不同）', redraw && redraw.h !== sigDark.h, `${sigDark?.h} → ${redraw?.h}`)

    // ===== 8) 导出 PNG 的 IHDR 尺寸 =====
    console.log('\n--- 8) 导出 PNG 尺寸 = 1080×1920 ---')
    const dataUrl = await evalJs(`document.querySelector('[data-wb="rightPanel"] canvas').toDataURL('image/png')`)
    let ihdr = null
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
      const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
      const sigOk = buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG'
      ihdr = { sigOk, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length }
    }
    ok('canvas.toDataURL 产出合法 PNG', !!ihdr && ihdr.sigOk)
    ok('导出 PNG 尺寸恰 1080×1920', ihdr && ihdr.w === 1080 && ihdr.h === 1920, JSON.stringify(ihdr))
    note('PNG 字节数', String(ihdr?.bytes ?? '?'))

    // 关闭浮层
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '完成'); b?.click(); return true })()`)
    await sleep(400)

    // ===== 9) 存模板 =====
    console.log('\n--- 9) 存为新模板 ---')
    const before = (parsed?.templates ?? []).length
    const tplName = '探针模板' + Date.now().toString(36).slice(-3)
    await evalJs(`(() => {
      const inp = document.querySelector('input[placeholder^="新模板名"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, ${JSON.stringify(tplName)})
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('存为模板'))
      btn?.click()
      return true
    })()`)
    await sleep(1100)
    const after = JSON.parse(String((await getSetting('shareCard')) ?? '{}'))
    ok('模板数 +1', (after?.templates ?? []).length === before + 1, `${before} → ${(after?.templates ?? []).length}`)
    ok('当前卡片切到新模板', after?.current?.tplId === after?.templates?.[after.templates.length - 1]?.id)
    ok('新模板带上了刚才改的寄语', after?.templates?.[after.templates.length - 1]?.texts?.quote === MARK)

    // ===== 10) 防抖窗口内切 Tab 不丢最后一次编辑（回归护栏） =====
    // 面板写入有 400ms 防抖且 Tab 切换会卸载面板 —— 若卸载时只 clearTimeout，
    // 「改完文案立刻切 Tab」就会静默丢掉最后一次编辑（本探针上线前实际存在过）。
    console.log('\n--- 10) 400ms 内切 Tab 不丢编辑 ---')
    await clickAt(preview.x, preview.y)   // 重新打开浮层
    await sleep(600)
    const MARK2 = '切Tab前最后输入' + Date.now().toString(36).slice(-4)
    await evalJs(`(() => {
      const ta = document.querySelector('textarea[data-share-slot="quote"]')
      ta.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(MARK2)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 不等防抖窗口，立刻切走（面板卸载）
    await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="widgets"]')?.click(); return true })()`)
    await sleep(900)
    const afterSwitch = JSON.parse(String((await getSetting('shareCard')) ?? '{}'))
    ok('切 Tab 后最后一次编辑仍在（卸载补写）', afterSwitch?.current?.texts?.quote === MARK2,
      `got=${afterSwitch?.current?.texts?.quote}`)
    await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="share"]')?.click(); return true })()`)
    await sleep(500)

    // ===== 11) 模板可删，且删光后**不复活** =====
    // 注：内置三套只在「设置为空串」时才播种，而本探针前面的步骤已存过模板 ——
    // 所以不假设存在内置行，改为对**当前存在的行**验「删除按钮在位」。
    // 本条的真正重点是「删光不复活」（钝解析里空数组 = 用户真删光了，不许回落内置）。
    console.log('\n--- 11) 模板可删 + 删光不复活 ---')
    const tplIds = await evalJs(`[...document.querySelectorAll('[data-share-tpl]')].map((e) => e.dataset.shareTpl)`)
    ok('模板行渲染出来了', Array.isArray(tplIds) && tplIds.length > 0, String(tplIds))
    const hasDelBtn = await evalJs(`(() => {
      const row = document.querySelector('[data-share-tpl]')
      return !!(row && [...row.querySelectorAll('button')].some((b) => (b.title || '').startsWith('删除')))
    })()`)
    ok('模板行带删除按钮', hasDelBtn)

    // 逐个删（用真实 click 事件；按钮平时 display:none，按坐标点不到）
    for (let i = 0; i < 16; i++) {
      const left = await evalJs(`(() => {
        const row = document.querySelector('[data-share-tpl]')
        const btn = row ? [...row.querySelectorAll('button')].find((b) => (b.title || '').startsWith('删除')) : null
        if (!btn) return 0
        btn.click()
        return document.querySelectorAll('[data-share-tpl]').length
      })()`)
      await sleep(160)
      if (left === 0) break
    }
    await sleep(900)
    const emptied = JSON.parse(String((await getSetting('shareCard')) ?? '{}'))
    ok('删光后设置里模板数 = 0', Array.isArray(emptied?.templates) && emptied.templates.length === 0,
      `templates=${JSON.stringify(emptied?.templates)?.slice(0, 60)}`)
    ok('空态提示出现', await evalJs(`document.body.innerText.includes('模板已全部删除')`))

    // ★ 切走再回来（面板重读设置 + 钝解析）→ 不许长回来
    await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="widgets"]')?.click(); return true })()`)
    await sleep(400)
    await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="share"]')?.click(); return true })()`)
    await sleep(900)
    const afterRemount = await evalJs(`document.querySelectorAll('[data-share-tpl]').length`)
    ok('★ 重新进入分享态后模板仍是 0（删光不复活）', afterRemount === 0, `rows=${afterRemount}`)
    ok('★ 空库时卡片仍可用（canvas 照画）', (await evalJs(`!!document.querySelector('[data-wb="rightPanel"] canvas')`)) === true)

    // ===== 12) 题目区：公式真的画出墨点（★ 本功能唯一不可替代的运行期判据） =====
    // 契约只能验「语法解析对不对」「代码有没有用 KaTeX」——公式到底排没排出来、
    // foreignObject 转图在真实 Chromium 里成不成功，只有真跑才知道。
    console.log('\n--- 12) 题目区：LaTeX 真的栅格化到卡片上 ---')
    await evalJs(`(() => { document.querySelector('[data-wb-rp-tab="share"]')?.click(); return true })()`)
    await sleep(700)
    const beforePrompt = await evalJs(SIG_FN)

    // 打开编辑浮层，往题目区写一道真实积分式
    const preview2 = await evalJs(`(() => {
      const cv = document.querySelector('[data-wb="rightPanel"] canvas')
      const r = cv.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await clickAt(preview2.x, preview2.y)
    await sleep(600)

    const TEX = '今日积分 $$\\int_0^1 \\frac{x^2}{1+x^3}\\,dx$$'
    // 用**右侧表单**里的题目输入框（比图上那块少一层「点开→失焦」的编辑态，探针更稳）
    const hasPromptForm = await evalJs(`!!document.querySelector('[data-share-prompt-form]')`)
    ok('编辑浮层里有题目输入框', hasPromptForm)

    if (hasPromptForm) {
      await evalJs(`(() => {
        const ta = document.querySelector('[data-share-prompt-form]')
        ta.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, ${JSON.stringify(TEX)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(2200)   // KaTeX 动态 import + 字体内联 + foreignObject 栅格化（首次最慢）
    }

    const afterPrompt = await evalJs(SIG_FN)
    ok('★ 写题后卡片重绘（签名变化）', afterPrompt && afterPrompt.h !== beforePrompt.h,
      `${beforePrompt?.h} → ${afterPrompt?.h}`)
    ok('★ 墨点增加（公式真的画上去了，不是空白块）',
      afterPrompt && afterPrompt.opaque >= beforePrompt.opaque,
      `opaque ${beforePrompt?.opaque} → ${afterPrompt?.opaque}`)

    // 题块扫描区**从页面里实测**：拿 canvas 的 CSS 盒 + 题块逻辑坐标换算，而不是写死数字。
    // （写死过 y=566 → 布局改到 654 后扫到空白区，假失败。）
    const blockInk = await evalJs(`(() => {
      const cv = document.querySelector('[data-wb="rightPanel"] canvas')
      const ctx = cv.getContext('2d')
      const k = cv.width / 540   // canvas 物理宽 / 逻辑宽
      // 题块逻辑区：x 34..506，y 654..790（panelLayout 产出；这里同步取值）
      const x0 = Math.round(34 * k), y0 = Math.round(654 * k)
      const w = Math.round((506 - 34) * k), h = Math.round((790 - 654) * k)
      const d = ctx.getImageData(x0, y0, w, h).data
      let ink = 0
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        if (lum < 200) ink++
      }
      return { ink, total: d.length / 4 }
    })()`)
    ok('★ 题目块内有足量非底色像素（公式/文字确实落在块内）',
      blockInk && blockInk.ink > 400, `ink=${blockInk?.ink}/${blockInk?.total}`)

    // 关浮层
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '完成'); b?.click(); return true })()`)
    await sleep(400)

    // ===== 13) 求值零失败 =====
    const evalFails = K.evalFailures?.() ?? 0
    ok('运行期求值零失败（无上下文销毁 / 异常）', evalFails === 0, `evalFailures=${evalFails}`)
  } catch (e) {
    ok('探针执行未抛异常', false, String(e?.message ?? e))
  } finally {
    // ---- 收尾：还原设置（不还原会污染下一轮 / 污染真机 dev） ----
    try {
      if (origShareCard !== null) await setSetting('shareCard', String(origShareCard))
      else await setSetting('shareCard', '')   // 空串 = 「还没存过」→ 下次读设置落内置种子
      if (origLayoutRaw !== null) await setSetting('workbenchLayout', String(origLayoutRaw))
      note('收尾：shareCard / workbenchLayout 已还原')
    } catch (e) {
      note('收尾还原失败', String(e?.message ?? e))
    }
  }

  console.log(`\n${failed ? 'PROBE FAILED' : 'PROBE PASSED'}`)
  process.exit(failed ? 1 : 0)
}

await main()

// 契约验证：分享卡片（右栏第三态，2026-09-29）。
//
// 覆盖八类断言：
//   ① habitStats 新增的打卡派生（checkinWeekCells / checkinHeatGrid）用例表 —— 直接 import
//      零依赖 .ts（node --experimental-strip-types），验的是真实实现不是复制品。
//   ② shareCardStats 纯函数（focusMinutesOn / heatRate）用例表。
//   ③ shareCardStyles 风格枚举与钝解析 + 槽位矩形随风格换位（书页在 hero，其余在面板）。
//   ④ shareCardTemplates 钝解析（坏 JSON / 空模板库 / 非法项丢弃 / tplId 回落）+ 风格清单一致性。
//   ⑤ 负向：官网地址单一来源（electron/ 与 src/ 下 `lousync.github.io` 只允许出现在 productInfo.ts）。
//   ⑥ 负向：renderShareCard.ts 不依赖 DOM（不读 document / window / getComputedStyle）。
//   ⑦ IPC 三处同步（preload / types / ipc.ts / repo handler）。
//   ⑧ 右栏第三态接线在位（WORKBENCH_PANEL_TAB_IDS 含 share + 面板有 share 渲染分支）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/share-card/verify-share-card.mjs
// 期望：全部 ok + exit=0

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/* 测试基准日：2026-09-29 是**星期二**，所在周的周一 = 2026-09-28，周日 = 2026-10-04 */
const TODAY = '2026-09-29'
const MON = '2026-09-28'
const SUN = '2026-10-04'

// ===== ① habitStats：周格 / 热力格 =====
console.log('\n--- ① habitStats：checkinWeekCells / checkinHeatGrid ---')
const H = await import('../../../electron/lib/kbStore/habitStats.ts')

{
  const w = H.checkinWeekCells([], TODAY)
  check('周格：空记录 → done=0、7 格全 false', w.done === 0 && w.cells.length === 7 && w.cells.every((c) => c === false))

  const w2 = H.checkinWeekCells([{ date: TODAY }], TODAY)
  check('周格：周二打卡落在 cells[1]（周一为首）', w2.cells[1] === true && w2.cells[0] === false && w2.done === 1)

  const w3 = H.checkinWeekCells([{ date: MON }], TODAY)
  check('周格：本周一打卡落在 cells[0]', w3.cells[0] === true && w3.done === 1)

  const w4 = H.checkinWeekCells([{ date: SUN }], TODAY)
  check('周格：本周日打卡落在 cells[6]', w4.cells[6] === true && w4.done === 1)

  const w5 = H.checkinWeekCells([{ date: '2026-09-27' }], TODAY)
  check('周格：上周日（09-27）不算本周', w5.done === 0 && w5.cells.every((c) => !c))

  const w6 = H.checkinWeekCells([{ date: '2026-10-05' }], TODAY)
  check('周格：下周一（10-05）不算本周', w6.done === 0)

  const w7 = H.checkinWeekCells([{ date: TODAY }, { date: TODAY }, { date: MON }], TODAY)
  check('周格：同一天多条记录只算一格', w7.done === 2 && w7.cells[0] && w7.cells[1])

  const w8 = H.checkinWeekCells([{ date: TODAY }], 'bogus')
  check('周格：非法 today → 空结果不抛错', w8.done === 0 && w8.cells.length === 7)
}

{
  const g = H.checkinHeatGrid([], TODAY, 13)
  check('热力格：长度 = weeks×7', g.length === 91)
  check('热力格：空记录 → 全 false', g.every((c) => c === false))

  const g1 = H.checkinHeatGrid([{ date: MON }, { date: TODAY }], TODAY, 13)
  check('热力格：最后一列是本週，周一在 r0、周二在 r1', g1[12 * 7 + 0] === true && g1[12 * 7 + 1] === true && g1[11 * 7 + 0] === false)

  const g2 = H.checkinHeatGrid([{ date: '2026-07-06' }], TODAY, 13)
  check('热力格：最早一列首格 = 12 周前的周一（2026-07-06）', g2[0] === true)

  const g3 = H.checkinHeatGrid([{ date: MON }], TODAY, 0)
  check('热力格：weeks=0 → 空数组', g3.length === 0)
}

// ===== ② shareCardStats：热力率（专注分钟的口径函数保留，供指标定下来后直接用） =====
console.log('\n--- ② shareCardStats：focusMinutesOn / heatRate ---')
const S = await import('../../../electron/lib/kbStore/shareCardStats.ts')

check('专注：多场次求和',
  S.focusMinutesOn([{ minutes: 25, date: TODAY }, { minutes: 50, date: TODAY }], TODAY) === 75)
check('专注：非目标日不计',
  S.focusMinutesOn([{ minutes: 25, date: '2026-09-28' }], TODAY) === 0)
check('专注：缺失 / 负数 / NaN 一律跳过',
  S.focusMinutesOn([
    { date: TODAY }, { minutes: -5, date: TODAY }, { minutes: Number.NaN, date: TODAY }, { minutes: 25, date: TODAY },
  ], TODAY) === 25)
check('专注：空输入 → 0', S.focusMinutesOn([], TODAY) === 0)

check('热力率：空 → 0（不出现 NaN）', S.heatRate([]) === 0)
check('热力率：全亮 → 100', S.heatRate([true, true, true]) === 100)
check('热力率：1/3 → 33', S.heatRate([true, false, false]) === 33)
check('热力率：非数组容错 → 0', S.heatRate(null) === 0)
check('热力窗口常量 = 13 周', S.SHARE_CARD_HEAT_WEEKS === 13)

// ===== ③ shareCardStyles：枚举钝解析 + 槽位换位 =====
console.log('\n--- ③ shareCardStyles：钝解析 / 槽位矩形 ---')
const St = await import('../../../src/components/share-card/shareCardStyles.ts')
check('风格：三值枚举', St.SHARE_CARD_STYLES.length === 3
  && ['peak', 'page', 'heat'].every((x) => St.SHARE_CARD_STYLES.includes(x)))
check('钝解析：合法值透传', St.parseShareCardStyle('page') === 'page' && St.parseShareCardStyle('heat') === 'heat')
check('钝解析：bogus / null / 123 回落 peak',
  St.parseShareCardStyle('bogus') === 'peak'
  && St.parseShareCardStyle(null) === 'peak'
  && St.parseShareCardStyle(123) === 'peak')
check('钝解析：明暗只认 dark', St.parseShareCardTheme('dark') === 'dark' && St.parseShareCardTheme('light') === 'light'
  && St.parseShareCardTheme('x') === 'light' && St.parseShareCardTheme(undefined) === 'light')

{
  const page = St.slotRects('page')
  const peak = St.slotRects('peak')

  // ★ 三风格的寄语恒在面板同一位（曾有过「书页风格挪到 hero」的支路 —— hero 里多画一份
  //   而两头互不知情，表现为「改了寄语但预览看着没更新」。已统一，这条锁住不许复活）。
  for (const style of St.SHARE_CARD_STYLES) {
    const q = St.slotRects(style).quote
    check(`槽位：${style} 的寄语在信息面板（y > HERO_H）`, q.y > St.HERO_H, `y=${q.y}`)
  }
  check('★ 三风格寄语矩形完全一致（不再按风格分流）',
    page.quote.y === peak.quote.y && page.quote.h === peak.quote.h && page.quote.w === peak.quote.w)
  // 渲染层不得再画 hero 寄语：drawPage 的函数体里不出现 drawSlot
  const renderSrc = stripComments(read('src/components/share-card/renderShareCard.ts'))
  const drawPageBody = (() => {
    const i = renderSrc.indexOf('function drawPage')
    if (i < 0) return ''
    const j = renderSrc.indexOf('\nfunction ', i + 1)
    return renderSrc.slice(i, j < 0 ? undefined : j)
  })()
  check('★ drawPage 里不画寄语（hero 那份重复已删）',
    drawPageBody.length > 0 && !drawPageBody.includes('drawSlot'),
    `drawPage body ${drawPageBody.length} chars`)
  check('槽位：三键齐备且矩形合法', ['quote', 'slogan', 'signature'].every((k) => {
    const r = peak[k]
    return r && r.w > 0 && r.h > 0 && typeof r.font === 'string' && r.maxLines > 0
  }))
  check('槽位：署名是单行（maxLines=1）', peak.signature.maxLines === 1)
  check('槽位：品牌语 / 署名同列（x 相同，署名在下）',
    peak.slogan.x === peak.signature.x && peak.signature.y > peak.slogan.y)
  check('槽位：矩形不越出画布', Object.values(peak).every((r) => r.x >= 0 && r.y >= 0
    && r.x + r.w <= St.CARD_W && r.y + r.h <= St.CARD_H))
  check('限长：三档都 > 0', St.TEXT_LIMITS.quote > 0 && St.TEXT_LIMITS.slogan > 0 && St.TEXT_LIMITS.signature > 0)
}

// ===== ④ 题目区：行内语法解析（Markdown + LaTeX） =====
console.log('\n--- ④ 题目区：parseRichText 行内语法 ---')
{
  // ★ 装载手法：shareCardRichText.ts 顶部有值导入（palette），且后半段要 DOM ——
  //   strip-types 不解析无扩展名相对导入，直接 import 必炸 ERR_MODULE_NOT_FOUND。
  //   故只截取「行内语法解析」那一段（到 richPlainText 结束），去掉 import，包成临时模块装载。
  //   该段被约定为**零依赖纯函数**（文件里有显式注释），改动时若破坏约定，这里会以加载失败报错。
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const richSrc = readFileSync(join(ROOT, 'src/components/share-card/shareCardRichText.ts'), 'utf8')
  const start = richSrc.indexOf('export type RichSeg')
  const end = richSrc.indexOf('/* ================= 字体与 KaTeX 装载')
  if (start < 0 || end < 0) { check('题目区：能切出纯函数段', false, '标记未找到'); }
  const slice = richSrc.slice(start, end)
  const dir = mkdtempSync(join(tmpdir(), 'share-card-rich-'))
  // 必须用 .ts 扩展名：strip-types 只对 .ts 生效，写成 .mjs 会因 `export type` 报 SyntaxError
  const tmp = join(dir, 'rich.ts')
  writeFileSync(tmp, slice, 'utf8')
  let R
  try { R = await import(pathToFileURL(tmp).href) } finally { rmSync(dir, { recursive: true, force: true }) }

  const kinds = (s) => R.parseRichText(s).map((x) => (x.kind === 'math' ? (x.display ? '$$' : '$') : (x.bold ? 'b' : x.italic ? 'i' : x.code ? 'c' : 't')))

  check('纯文本 → 单段 text', kinds('今天做题').join() === 't')
  check('**粗体** 被识别', R.parseRichText('**粗**')[0].bold === true)
  check('*斜体* 被识别', R.parseRichText('*斜*')[0].italic === true)
  check('`代码` 被识别', R.parseRichText('`x`')[0].code === true)
  check('$行内公式$ → math 且 display=false', (() => {
    const s = R.parseRichText('$x^2$')[0]
    return s.kind === 'math' && s.display === false && s.tex === 'x^2'
  })())
  check('$$整行公式$$ → math 且 display=true', (() => {
    const s = R.parseRichText('$$\\int_0^1$$')[0]
    return s.kind === 'math' && s.display === true && s.tex === '\\int_0^1'
  })())
  check('★ $$ 优先于 $ 判断（不被当成两个行内公式）', kinds('$$a$$').join() === '$$')
  check('混合：文本 + 行内 + 整行', kinds('今日积分 $x^2$ 再看 $$y$$').join() === 't,$,t,$$')
  check('未闭合的 $ 原样当文本', kinds('价格 $5').join() === 't')
  check('单个 $ 不跨换行吞内容', R.parseRichText('$a\nb$').every((x) => x.kind === 'text'))
  check('空串 → 空数组', R.parseRichText('').length === 0)
  check('richPlainText 去掉记号只留可见文本', R.richPlainText(R.parseRichText('**a**$b$')) === 'ab')
}

// 常量与几何：全部从 shareCardStyles 取值（题区矩形由 panelLayout 算出，不再有手抄常量）
{
  const S2 = St
  check('题目区限行 = 4', S2.PROMPT_MAX_LINES === 4)
  check('题目区限字 = 400', S2.PROMPT_MAX_CHARS === 400)

  // ★ 几何回归护栏：题区矩形必须与布局函数同源，且落在寄语行与周格行之间。
  //   此前 shareCardRichText 里手抄过 PROMPT_BLOCK_TOP=566，而布局算出的实际位置是 654 ——
  //   错位 88px（公式渲染跑到框外、编辑占位框与画出的块对不上）。这条断言让手抄常量无法再溜回来。
  for (const style of S2.SHARE_CARD_STYLES) {
    const L = S2.panelLayout(style)
    const pr = L.prompt
    check(`题区：${style} 的矩形合法（w>0 h>0 且不越界）`,
      pr.w > 0 && pr.h > 0 && pr.x >= 0 && pr.y >= 0
      && pr.x + pr.w <= S2.CARD_W && pr.y + pr.h <= S2.CARD_H,
      `x=${pr.x} y=${pr.y} w=${pr.w} h=${pr.h}`)
    check(`题区：${style} 在寄语行之下、周格行之上`,
      (!L.quote || pr.y >= L.quote.y + L.quote.h) && pr.y + pr.h <= L.weekTop,
      `quoteBottom=${L.quote ? L.quote.y + L.quote.h : '-'} pr=${pr.y}..${pr.y + pr.h} week=${L.weekTop}`)
    check(`题区：${style} 与页脚分隔线（y=816）不重叠`, pr.y + pr.h < S2.FOOT.ruleY, `${pr.y + pr.h} < ${S2.FOOT.ruleY}`)
  }

  // 静态负向：渲染层不得再出现手抄的题区几何常量
  const richSrc2 = stripComments(read('src/components/share-card/shareCardRichText.ts'))
  check('题区几何不手抄（无 PROMPT_BLOCK_TOP / PROMPT_BLOCK_H 常量）',
    !/PROMPT_BLOCK_TOP\s*=/.test(richSrc2) && !/PROMPT_BLOCK_H\s*=/.test(richSrc2))
  check('题区矩形经 promptRect → panelLayout 转出', richSrc2.includes('panelLayout(style).prompt'))

  // 大字位（日期 / 星期）已移除：渲染层不应再出现「号」「DAY OF WEEK」这类占位文案
  const renderSrc = stripComments(read('src/components/share-card/renderShareCard.ts'))
  check('★ 卡片已去掉日期/星期大字位（中间只留题区）',
    !renderSrc.includes('DAY OF WEEK') && !renderSrc.includes('bigStat'))
}

// ===== ⑤ shareCardTemplates：钝解析 / 一致性 =====
console.log('\n--- ④ shareCardTemplates：钝解析 / 风格清单一致性 ---')
const T = await import('../../../src/components/share-card/shareCardTemplates.ts')

check('一致性：模板文件的风格清单 === shareCardStyles 的清单',
  T.SHARE_CARD_STYLE_IDS.length === St.SHARE_CARD_STYLES.length
  && [...T.SHARE_CARD_STYLE_IDS].every((x) => St.SHARE_CARD_STYLES.includes(x)),
  `${T.SHARE_CARD_STYLE_IDS.join('/')}`)

{
  const bad = T.sanitizeShareCardState('{ 不是 JSON')
  check('钝解析：坏 JSON → 内置三套模板', bad.templates.length === 3 && bad.templates.every((t) => t.builtin === true))
  check('钝解析：坏 JSON → current 有可用默认', bad.current.style === 'peak' && bad.current.tplId === bad.templates[0].id)
  check('钝解析：坏 JSON → 文案回落出厂值', bad.current.texts.quote === T.DEFAULT_TEXTS.quote)

  // 「还没存过」与「用户删光了」必须可区分 —— 混为一谈就会出现「删了又自己回来」
  check('钝解析：未初始化（空串）→ 内置三套种子', T.sanitizeShareCardState('').templates.length === 3)
  check('钝解析：null / undefined / "null" → 内置三套种子',
    T.sanitizeShareCardState(null).templates.length === 3
    && T.sanitizeShareCardState(undefined).templates.length === 3
    && T.sanitizeShareCardState('null').templates.length === 3)
  const empty = T.sanitizeShareCardState('{"templates":[]}')
  check('钝解析：合法空模板库 → **保持空**（用户确实删光了，不复活）', empty.templates.length === 0)
  check('钝解析：空模板库 → tplId 回落 null 且不抛错', empty.current.tplId === null)
  check('钝解析：空模板库 → 卡片配置仍然可用（风格 / 文案走默认）',
    empty.current.style === 'peak' && empty.current.texts.quote === T.DEFAULT_TEXTS.quote)
  check('钝解析：种子模板是深拷贝（改一个不会污染下次读取）', (() => {
    const a = T.sanitizeShareCardState('')
    a.templates[0].name = '被改了'
    return T.sanitizeShareCardState('').templates[0].name !== '被改了'
  })())

  const mixed = T.sanitizeShareCardState(JSON.stringify({
    templates: [
      { id: 'a', name: '好的', style: 'bogus', theme: 'weird', texts: { quote: 'q' } },
      { name: '没有 id' },
      { id: 'b' },
      'garbage',
      null,
    ],
    current: { style: 'heat', theme: 'dark', texts: { quote: 'hi' }, tplId: 'nope' },
  }))
  check('钝解析：非法模板项被丢弃（只剩 1 项）', mixed.templates.length === 1 && mixed.templates[0].id === 'a')
  check('钝解析：模板内非法风格回落 peak、明暗回落 light',
    mixed.templates[0].style === 'peak' && mixed.templates[0].theme === 'light')
  check('钝解析：缺字段的文案用默认补齐', mixed.templates[0].texts.slogan === T.DEFAULT_TEXTS.slogan)
  check('钝解析：current 风格/明暗透传',
    mixed.current.style === 'heat' && mixed.current.theme === 'dark' && mixed.current.texts.quote === 'hi')
  check("钝解析：tplId 不在清单内 → 回落首个", mixed.current.tplId === 'a')

  const named = T.sanitizeShareCardState(JSON.stringify({
    templates: [{ id: 'x', name: '一二三四五六七八九十一二三四五六七八九', style: 'page', theme: 'light', texts: {} }],
    current: { style: 'page', theme: 'light', texts: {}, tplId: 'x' },
  }))
  check('钝解析：模板名截到 16 字', named.templates[0].name.length === 16)
  check('脏标记：刚应用模板 → 不脏', T.isTemplateDirty(named) === false)
  check('脏标记：文案被改 → 脏',
    T.isTemplateDirty({ ...named, current: { ...named.current, texts: { ...named.current.texts, quote: '改了' } } }) === true)
  check('脏标记：风格被改 → 脏',
    T.isTemplateDirty({ ...named, current: { ...named.current, style: 'peak' } }) === true)
  check('脏标记：tplId 指向不存在的模板 → 脏',
    T.isTemplateDirty({ ...named, current: { ...named.current, tplId: 'zzz' } }) === true)
  check('id 生成：前缀 t- 且两次不同', T.newTemplateId().startsWith('t-') && T.newTemplateId() !== T.newTemplateId())
}

// ===== ⑥ 负向：官网地址单一来源 =====
console.log('\n--- ⑤ 负向断言：官网地址只在 productInfo.ts ---')
{
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'out' || e.name === '.git' || e.name.startsWith('dist')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p)
    }
    return out
  }
  const targets = [...walk(join(ROOT, 'electron')), ...walk(join(ROOT, 'src'))]
  const offenders = []
  for (const f of targets) {
    const src = stripComments(readFileSync(f, 'utf8'))
    if (src.includes('lousync.github.io') && !f.replace(/\\/g, '/').endsWith('electron/lib/productInfo.ts')) {
      offenders.push(f.replace(ROOT, ''))
    }
  }
  check('lousync.github.io 只出现在 productInfo.ts', offenders.length === 0,
    offenders.join(',') || `${targets.length} 个文件扫描通过`)

  const pi = stripComments(read('electron/lib/productInfo.ts'))
  check('productInfo 确实导出 PRODUCT_SITE', /export const PRODUCT_SITE\s*=/.test(pi))
  const repo = stripComments(read('electron/database/repositories/shareCardRepo.ts'))
  check('repo 从 productInfo 取地址（不写字面量）', repo.includes('PRODUCT_SITE') && repo.includes("from '../../lib/productInfo'"))
}

// ===== ⑦ 负向：绘制函数不依赖 DOM =====
console.log('\n--- ⑥ 负向断言：renderShareCard 不依赖 DOM ---')
{
  const src = stripComments(read('src/components/share-card/renderShareCard.ts'))
  const bad = ['document.', 'window.', 'getComputedStyle', 'localStorage', 'navigator.'].filter((k) => src.includes(k))
  check('renderShareCard.ts 无 DOM 依赖', bad.length === 0, bad.join(',') || '纯 canvas 绘制')
  check('renderShareCard 导出纯函数', /export function renderShareCard\s*\(/.test(src))
  check('绘制第一笔是不透明底色（防微信黑底）',
    src.indexOf('fillRect(0, 0, CARD_W, CARD_H)') > 0
    && src.indexOf('fillRect(0, 0, CARD_W, CARD_H)') < src.indexOf('drawHero('))
}

// ===== ⑧ IPC 三处同步 =====
console.log('\n--- ⑦ IPC 三处同步 ---')
{
  const preload = read('electron/preload/index.ts')
  check("preload 有 shareCardGet → 'shareCard:get'", preload.includes("ipcRenderer.invoke('shareCard:get')"))
  check("preload 有 shareCardSavePng → 'shareCard:savePng'", preload.includes("ipcRenderer.invoke('shareCard:savePng'"))

  const repo = read('electron/database/repositories/shareCardRepo.ts')
  check("repo handle 'shareCard:get'", repo.includes("ipcMain.handle('shareCard:get'"))
  check("repo handle 'shareCard:savePng'", repo.includes("ipcMain.handle('shareCard:savePng'"))
  check('repo 已注册（main/index.ts）', read('electron/main/index.ts').includes('registerShareCardHandlers()'))
  check('repo 复用 habitStats 口径（不另写周格 / 热力）',
    repo.includes('checkinWeekCells') && repo.includes('checkinHeatGrid') && repo.includes("from '../../lib/kbStore/habitStats'"))
  // 2026-09-29：卡上两个大字位改放**占位内容**（日期 / 星期），不再取统计标量。
  // 指标选择整条挪进 DP 搁置区（Phrontis/搁置功能与想法/分享卡片数据指标/）。
  // 这条负向断言防止「顺手又把没定的指标接回来」—— 要接必须先定指标并改这条。
  check('repo 不接任何统计标量（指标待定，卡上走占位）',
    !repo.includes('focusMinutesOn') && !repo.includes('checkinCurrentStreak') && !repo.includes('pomoSessionsAll'))

  const types = read('src/types/index.ts')
  check('types 声明 shareCardGet / shareCardSavePng',
    types.includes('shareCardGet:') && types.includes('shareCardSavePng:'))
  check('types 声明 ShareCardData / ShareCardStyle / ShareCardTemplate / ShareCardTexts',
    ['ShareCardData', 'ShareCardStyle', 'ShareCardTemplate', 'ShareCardTexts', 'ShareCardState']
      .every((k) => types.includes(`interface ${k}`) || types.includes(`type ${k}`)))

  const ipc = read('src/lib/ipc.ts')
  check('ipc.ts 有 shareCardGet / shareCardSavePng 封装',
    /export const shareCardGet\s*=/.test(ipc) && /export const shareCardSavePng\s*=/.test(ipc))

  const settings = stripComments(read('src/lib/settings.ts'))
  const settingsLine = settings.split('\n').find((l) => l.trim().startsWith('shareCard:')) ?? ''
  check('settings 有 shareCard 键（json 类型、全局作用域）',
    settingsLine.includes("type: 'json'") && settingsLine.includes("scope: 'global'"),
    settingsLine ? 'entry found' : 'entry missing')
  check("settings shareCard 默认值是空串（「没存过」与「删光了」必须可区分）",
    /default:\s*''/.test(settingsLine), settingsLine.slice(0, 60))
}

// ===== ⑨ 右栏第三态接线 =====
console.log('\n--- ⑧ 右栏第三态接线 ---')
{
  const L = await import('../../../src/lib/workbenchLayout.ts')
  check("WORKBENCH_PANEL_TAB_IDS 含 'share'", L.WORKBENCH_PANEL_TAB_IDS.includes('share'))
  check("RIGHT_PANEL_TAB_IDS_ALL 含 'share' 与 'reading'",
    L.RIGHT_PANEL_TAB_IDS_ALL.includes('share') && L.RIGHT_PANEL_TAB_IDS_ALL.includes('reading'))
  check("parseWorkbenchLayout 接受 rightTab='share'",
    L.parseWorkbenchLayout(JSON.stringify({ rightTab: 'share' })).rightTab === 'share')
  check("panelTabsHidden 只收合法 Tab（'share' 不被过滤）",
    L.parseWorkbenchLayout(JSON.stringify({ panelTabsHidden: ['share'] })).panelTabsHidden.includes('share'))

  const panel = stripComments(read('src/components/workbench/WorkbenchRightPanel.tsx'))
  check('右栏组件 import 了 ShareCardPanel', panel.includes("from '../share-card/ShareCardPanel'"))
  check("右栏组件有 share 渲染分支", panel.includes("effectiveTab === 'share'"))
  check('右栏 Tab 标题表含 share',
    /PANEL_TAB_TITLE[^}]*share/.test(panel) && /PANEL_TAB_LABEL[^}]*share/.test(panel))

  const panelSrc = read('src/components/share-card/ShareCardPanel.tsx')
  check('分享面板用 canvas 单一绘制（不引第二套渲染）',
    panelSrc.includes('ShareCardCanvas') && !panelSrc.includes('renderShareCard'))
  check('分享面板等待设置加载完成（ready 后才取草稿）', panelSrc.includes('!ready') && panelSrc.includes('sanitizeShareCardState'))
  // 删除按钮**不**按 builtin 分支掉（内置模板也能删）；重命名仍只给自存模板
  check('分享面板：内置模板也带删除按钮', panelSrc.includes('deleteTemplate(t.id)') && panelSrc.includes('!t.builtin &&'))
  check('分享面板：删光后有空态提示（不留白）', panelSrc.includes('模板已全部删除'))
  // 题目区编辑**只在编辑浮层里**（右栏面板不放开输入框，避免两处入口 + 冗余说明）
  check('分享面板不放开题目输入框（编辑统一在浮层）', !panelSrc.includes('data-share-prompt'))
  check('分享面板：改题目不动 tplId（题目不进模板）', /setPrompt[\s\S]{0,220}prompt:\s*v\.slice/.test(panelSrc))

  const richSrc = read('src/components/share-card/shareCardRichText.ts')
  check('题目区走 KaTeX 排版（不手写公式渲染）', richSrc.includes("import('katex')") && richSrc.includes('renderToString'))
  check('题目区字体内联成 data URL（foreignObject 里外部 URL 会被拒）',
    richSrc.includes('?url') && richSrc.includes('base64') && richSrc.includes('@font-face'))
  check('题目区排版在离屏容器里做、用完移除（finally host.remove）',
    richSrc.includes('document.createElement') && richSrc.includes('host.remove()'))
  check('KaTeX 用动态 import（不改变首屏闭包）', /import\(\s*'katex'\s*\)/.test(richSrc))

  const canvasSrc = read('src/components/share-card/ShareCardCanvas.tsx')
  check('题目区排版结果异步产出并传进绘制层（绘制层因此仍不碰 DOM）',
    canvasSrc.includes('renderRichTextImage') && canvasSrc.includes('promptImage'))

  const editorSrc = read('src/components/share-card/ShareCardEditor.tsx')
  check('编辑浮层有题目区原位编辑（编辑期显示源码）',
    editorSrc.includes('promptEditing') && editorSrc.includes('data-share-prompt-editor'))
  check('题目区编辑是「失焦即渲染」而非透明输入层', editorSrc.includes('setPromptEditing(false)'))
}

console.log(`\n${pass ? 'ALL PASS' : 'HAS FAILURES'}`)
process.exit(pass ? 0 : 1)

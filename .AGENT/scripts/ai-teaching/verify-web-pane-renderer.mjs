#!/usr/bin/env node
/**
 * 契约验证：AI 教学右侧查看器 · 网页页签渲染层
 *
 * 覆盖两层：
 *   1. `src/modules/ai-teaching/right-viewer/webPanePure.ts` —— 类型剥离后直接跑真实实现
 *      （URL 归一 / 页签槽位 / 关闭邻位 / bounds 判定 / 恢复容错）；
 *   2. `WebPane.tsx` 的静态硬约束 —— bounds 同步链路与「禁模态提示」。
 *
 * 方案：`/home/lousync/Projects/Phrontis/docs/ai-teaching-right-viewer-plan.md` §6.1 / §8 / §9
 *       + 内核文档 C2（外链复用当前页签）/ C4（只认 http/https）/ C6（恢复但不预加载）。
 *
 * 2026-11-22 随内层页签条删除更新：第 8 节补了五条静态断言 —— 内层「新建 / 关闭」入口消失、
 * 地址栏仍在、pane 不再自己写 localStorage、空态是点阵而不是起始块、五种状态名必须都出现。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-web-pane-renderer.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const PURE_REL = 'src/modules/ai-teaching/right-viewer/webPanePure.ts'
const PANE_REL = 'src/modules/ai-teaching/right-viewer/WebPane.tsx'

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const ascii = (s) => String(s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?')

const pureSrc = fs.readFileSync(path.join(ROOT, PURE_REL), 'utf8')
const paneSrc = fs.readFileSync(path.join(ROOT, PANE_REL), 'utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-pane-'))
const pureMjs = path.join(tmpDir, 'webPanePure.mjs')
fs.writeFileSync(pureMjs, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))

const {
  normalizeUrl,
  hostOf,
  tabCaption,
  nextTabId,
  closeTabAt,
  boundsPayload,
  shouldShowView,
  restoreTabs,
} = await import(pathToFileURL(pureMjs).href)

/* ---------------------------------------------------------------- 1. normalizeUrl */
console.log('=== 1. normalizeUrl ===')
check('adds https:// to a bare domain', normalizeUrl('example.com/a?b=1') === 'https://example.com/a?b=1')
check('keeps explicit http://', normalizeUrl('http://a.com') === 'http://a.com/')
check('rejects javascript:', normalizeUrl('javascript:alert(1)') === null)
check('rejects file://', normalizeUrl('file:///C:/notes/a.md') === null)
check('rejects data:', normalizeUrl('data:text/html,<b>x</b>') === null)
check('empty string -> null', normalizeUrl('   ') === null)
check(
  'keeps https path / query / hash',
  normalizeUrl('https://news.example.com/p/12?q=1#h') === 'https://news.example.com/p/12?q=1#h',
)
check('host:port is not mistaken for a scheme', normalizeUrl('localhost:3000/x') === 'https://localhost:3000/x')

/* ---------------------------------------------------------------- 2. hostOf / tabCaption */
console.log('\n=== 2. hostOf / tabCaption ===')
check('hostOf returns hostname', hostOf('https://www.example.com/p') === 'www.example.com')
check('hostOf falls back to raw input', hostOf('not a url') === 'not a url')
check(
  'tabCaption prefers title, then host, then placeholder',
  tabCaption({ id: 'w1', url: 'https://a.com/x', title: 'A 站' }) === 'A 站' &&
    tabCaption({ id: 'w2', url: 'https://b.com/x' }) === 'b.com' &&
    tabCaption({ id: 'w3', url: '' }) === '新标签页',
)

/* ---------------------------------------------------------------- 3. nextTabId */
console.log('\n=== 3. nextTabId ===')
check('empty list -> w1', nextTabId([]) === 'w1')
check('missing w2 -> w2', nextTabId([{ id: 'w1', url: '' }, { id: 'w3', url: '' }]) === 'w2')
check(
  'full -> null',
  nextTabId([{ id: 'w1', url: '' }, { id: 'w2', url: '' }, { id: 'w3', url: '' }]) === null,
)

/* ---------------------------------------------------------------- 4. closeTabAt */
console.log('\n=== 4. closeTabAt ===')
{
  const three = [
    { id: 'w1', url: 'https://a.com/' },
    { id: 'w2', url: 'https://b.com/' },
    { id: 'w3', url: 'https://c.com/' },
  ]
  const snap = JSON.stringify(three)
  const closingActive = closeTabAt(three, 1, 1)
  check(
    'closing the active tab selects the right neighbour',
    closingActive.activeIndex === 1 && closingActive.tabs.length === 2 && closingActive.tabs[1].id === 'w3',
  )

  const closingFront = closeTabAt(three, 2, 0)
  check(
    'closing a tab before the active one keeps the same page (index shifts)',
    closingFront.activeIndex === 1 && closingFront.tabs[1].id === 'w3',
  )

  const closingLast = closeTabAt(three, 0, 2)
  check(
    'closing the last tab keeps the active index',
    closingLast.activeIndex === 0 && closingLast.tabs.length === 2,
  )

  const closingOnly = closeTabAt([three[0]], 0, 0)
  check('closing the only tab yields the empty state', closingOnly.tabs.length === 0 && closingOnly.activeIndex === 0)

  check('closeTabAt does not mutate the input', JSON.stringify(three) === snap)
}

/* ---------------------------------------------------------------- 5. boundsPayload */
console.log('\n=== 5. boundsPayload ===')
check(
  'normal rect maps to rounded css px bounds',
  JSON.stringify(boundsPayload({ left: 10, top: 20.4, width: 300.6, height: 200.2 })) ===
    JSON.stringify({ x: 10, y: 20, width: 301, height: 200 }),
)
check('zero width -> null (hide, not setBounds)', boundsPayload({ left: 0, top: 0, width: 0, height: 300 }) === null)
check('negative size -> null', boundsPayload({ left: 0, top: 0, width: -5, height: 300 }) === null)
check('non-finite -> null', boundsPayload({ left: NaN, top: 0, width: 10, height: 10 }) === null)

/* ---------------------------------------------------------------- 6. shouldShowView */
console.log('\n=== 6. shouldShowView ===')
check('active + open + url -> show', shouldShowView({ active: true, open: true, url: 'https://a.com/' }) === true)
check('inactive pane -> hide', shouldShowView({ active: false, open: true, url: 'https://a.com/' }) === false)
check('closed panel -> hide', shouldShowView({ active: true, open: false, url: 'https://a.com/' }) === false)
check(
  'failed load -> hide (placeholder must stay visible)',
  shouldShowView({ active: true, open: true, url: 'https://a.com/', error: 'ERR_NAME_NOT_RESOLVED' }) === false,
)

/* ---------------------------------------------------------------- 7. restoreTabs */
console.log('\n=== 7. restoreTabs ===')
check('broken json -> empty', restoreTabs('{not json').length === 0)
{
  const mixed = restoreTabs(
    JSON.stringify([
      { id: 'w1', url: 'file:///C:/secret.md', title: 'local' },
      { id: 'w2', url: 'https://a.com/p', title: 'A' },
    ]),
  )
  check(
    'non http(s) entries are dropped',
    mixed.length === 1 && mixed[0].url === 'https://a.com/p' && mixed[0].dormant === true,
  )
}
{
  const many = restoreTabs(
    JSON.stringify([
      { id: 'w1', url: 'https://a.com/1' },
      { id: 'w2', url: 'https://a.com/2' },
      { id: 'w3', url: 'https://a.com/3' },
      { id: 'w4', url: 'https://a.com/4' },
    ]),
  )
  check('restores at most 3 tabs', many.length === 3 && many[2].id === 'w3')
}

/* ---------------------------------------------------------------- 8. WebPane.tsx 静态约束 */
console.log('\n=== 8. WebPane.tsx static checks ===')
check('reads the slot rect via getBoundingClientRect', paneSrc.includes('getBoundingClientRect'))
check('coalesces bounds updates with requestAnimationFrame', paneSrc.includes('requestAnimationFrame'))
check('toggles native visibility with webPaneSetVisible', paneSrc.includes('setVisible'))
check('subscribes to main-process state via onWebPaneChanged', paneSrc.includes('onWebPaneChanged'))
check('no blocking dialogs (alert / confirm)', !paneSrc.includes('alert(') && !paneSrc.includes('confirm('))
check('closes only its own views (never disposeAll)', !paneSrc.includes('webPaneDisposeAll'))

/* 2026-11-22 随内层页签条删除更新：网页 pane 退化为「单页面 + 地址栏」。
   内层那套「新建 / 关闭」入口必须真的不存在（不是隐藏），壳层页签条才是唯一权威；
   同时锁住「地址栏没被空态改造弄丢」与「pane 不再写旧的 aiTeach.webTabs.<sid>」。 */
check('inner web tab strip is gone (no second "+" / "×" in the pane)',
  !paneSrc.includes('aria-label="新建网页页签"') && !paneSrc.includes('role="tablist"')
  && !paneSrc.includes('closeTabAt') && !paneSrc.includes('nextTabId'))
check('the address bar survives the empty-state rework', /aria-label="网址"/.test(paneSrc))
check('the pane never persists tabs itself (shell is the only writer)',
  !paneSrc.includes('localStorage') && !paneSrc.includes('setItem'))
check('empty state is a dot-grid layer, not a start block',
  /radial-gradient/.test(paneSrc) && !paneSrc.includes('快捷入口'))
check('the five placeholder states stay distinguishable',
  ['start', 'dormant', 'loading', 'error', 'ready'].every((s) => new RegExp(`'${s}'`).test(paneSrc)))

/* ---------------------------------------------------------------- 报告 */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + ascii(c.detail) : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(failed.length === 0 ? 0 : 1)

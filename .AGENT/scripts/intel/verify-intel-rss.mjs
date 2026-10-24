// 契约验证：intel RSS/Atom 解析层（2026-10-25 CDATA 事故回归）。
//
// 事故背景：人民网/新浪/中新网国际的 <title> 是 <![CDATA[…]]> 包裹，旧 stripHtml 的
// `<[^>]*>` 把整段 CDATA 当标签吃掉 → 标题为空 → 全部条目被跳过 → 表象「刷新成功但 0 条」。
// rss.ts 已做成零依赖纯解析层，本脚本裸 node 直跑同一实现。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/intel/verify-intel-rss.mjs
// 期望：输出 PASS 且 exit=0

import { parseFeed, stripHtml, decodeEntities, absUrl } from '../../../electron/lib/intel/rss.ts'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
function checkThrows(name, fn) {
  try { fn(); failed++; console.log(`FAIL  ${name}  (no throw)`) }
  catch (e) { console.log(`PASS  ${name}  (${String(e.message).slice(0, 40)})`) }
}

// ===== 人民网样式：CDATA 全包 title/description（事故现场） =====
const PEOPLE = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>
<item><title><![CDATA[学习卡丨“人不负青山，青山定不负人”]]></title><link>http://politics.people.com.cn/n1/2025/0605/c1001-1.html</link><pubDate>2025-06-05 20:50:18</pubDate><description><![CDATA[<p>生态环境是关系民生的问题。</p>]]></description></item>
</channel></rss>`
const people = parseFeed(PEOPLE, 'http://www.people.com.cn', 10)
check('CDATA 标题完整保留', people[0]?.title, '学习卡丨“人不负青山，青山定不负人”')
check('CDATA 内 HTML 摘要去标签', people[0]?.summary, '生态环境是关系民生的问题。')
check('人民网日期串可解析', people[0]?.publishedAt.startsWith('2025-06'), true)

// ===== 新浪样式：CDATA 跨行缩进 =====
const SINA = `<rss version="2.0"><channel>
<item>
  <title>
    <![CDATA[“光纤之父”高锟离世]]>
  </title>
  <link>http://go.rss.sina.com.cn/redirect.php?url=http://news.sina.com.cn/a.html</link>
  <pubDate>Sun, 23 Sep 2018 10:57:02 GMT</pubDate>
</item>
</channel></rss>`
const sina = parseFeed(SINA, 'https://rss.sina.com.cn', 10)
check('跨行 CDATA 标题解出', sina[0]?.title, '“光纤之父”高锟离世')

// ===== 中新网样式：纯文本 title + CDATA 混排（两代解析都必须活着） =====
const CNS = `<rss version="2.0"><channel><item><title>粤超季军赛收官</title><link>https://www.chinanews.com.cn/a.shtml</link><pubDate>Sun, 25 Oct 2026 07:31:52 +0800</pubDate><description><![CDATA[中新网梅州10月25日电 正文]]></description></item><item><title><![CDATA[第二条 CDATA]]></title><link>https://www.chinanews.com.cn/b.shtml</link></item></channel></rss>`
const cns = parseFeed(CNS, 'https://www.chinanews.com', 10)
check('纯文本标题不受影响', cns[0]?.title, '粤超季军赛收官')
check('混合 feed 两代条目都解出', cns.length, 2)
check('CDATA 条目链接完整', cns[1]?.link, 'https://www.chinanews.com.cn/b.shtml')

// ===== Atom（labs 源同通道） =====
const ATOM = `<feed><entry><title>Atom entry</title><link rel="alternate" href="/blog/post" /><updated>2026-10-25T08:00:00Z</updated><summary>atom summary &amp; more</summary></entry></feed>`
const atom = parseFeed(ATOM, 'https://example.com', 10)
check('Atom link 相对转绝对', atom[0]?.link, 'https://example.com/blog/post')
check('Atom 实体解码', atom[0]?.summary, 'atom summary & more')

// ===== 非 feed 响应 → 必须抛错（防「成功但 0 条」静默） =====
checkThrows('HTML 错误页抛错', () => parseFeed('<!DOCTYPE html><html><body>403 Forbidden</body></html>', 'https://x.com', 10))
checkThrows('空串抛错', () => parseFeed('', 'https://x.com', 10))

// ===== 工具函数直测 =====
check('stripHtml 去标签', stripHtml('<p>a <b>b</b></p>'), 'a b')
check('decodeEntities 数字实体', decodeEntities('&#20013;&#25991;'), '中文')

if (failed > 0) {
  console.log(`FAIL  ${failed} case(s) failed`)
  process.exit(1)
}
console.log('PASS  all rss parse cases')

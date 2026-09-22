/**
 * 探针 FB2 / FBZ 生成器（B 段 · 阶段 2a：foliate 系扩格式）。
 *
 * 为什么要自造样书：本机没有真 fb2/fbz 书（阶段 2 出口判据已与用户确认为「自造样书跑通即可」），
 * 而 FB2 的**风险面**恰好都不需要真书才能覆盖：
 *   · 内建样式表（上游是 `blob:` 样式表，被宿主 CSP 的 style-src 拦）—— KB PATCH ④ 改成内联，
 *     本文件的 `probeFb2()` 就是这条 patch 的**验收靶**：样式生效时章标题 `h1` 居中、正文第二段
 *     行首缩进 1em（首段命中 `:not(p) + p` 规则被归零，故必须看第二段）。
 *   · 分发靠 File 的 name/type（`view.js:13-21` 的 `isFB2`/`isFBZ` 是**大小写敏感 endsWith**，
 *     不看魔数）—— 故 fb2 无后缀/错后缀必炸，本文件的产物后缀就是契约的一部分。
 *   · FB2 的 TOC **href 形状与 EPUB 不同**（`fb2.js:339` 是 `String(index)`，不是路径），
 *     左栏点目录走的是同一条 `view.goTo(href)` —— 这条正是「格式不同、链路相同」的接缝。
 *
 * ★ 与 EPUB 的关键差异（决定了负向断言怎么写，见 `maliciousFb2()`）：
 *   FB2 的转换器是**白名单映射**（`fb2.js:128` `const d = def?.[node.nodeName]; if (!d) return null`），
 *   不在表里的节点名与属性**在转换期就被丢掉**——`<script>` 和 `onerror` 根本进不了 DOM。
 *   EPUB 那边是「进得了 DOM、但执行不了」（epub.js 不净化、靠 CSP + sandbox 兜底），
 *   两者都安全，但**证据形态完全不同**，不能照抄 EPUB 探针的「载荷存活在 DOM 里」断言。
 *
 * 字节可复现：FBZ 走 make-epub 的 `zipStore`（固定时间戳），同一份源码产物逐字节相同 ——
 * 探针失败时可比对两轮产物，判断「是 fixture 变了还是代码变了」。
 */
import { zipStore, PNG_1PX } from './make-epub.mjs'

/**
 * FB2 文档骨架。
 * `xmlns:l` 是 xlink —— `<image l:href="#id"/>` 的转换器走 `getAttributeNS(NS.XLINK, 'href')`
 * （`fb2.js:83`），**不带命名空间声明就取不到 href**（图片静默变 `data:,`）。
 * `<binary>` 必须放在 `<body>` **之外**（`fb2.js:79` 从整个文档收，且放进 body 会被当正文渲染）。
 */
const wrap = (body, binaries = '') => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>probe</genre>
<author><first-name>探针</first-name><last-name>作者</last-name></author>
<book-title>探针样书</book-title>
<lang>zh-CN</lang>
</title-info>
<document-info><author><nickname>probe</nickname></author><id>probe-fb2-0001</id><version>1.0</version></document-info>
</description>
<body>
${body}
</body>
${binaries}
</FictionBook>`

/**
 * 一级 `<section>` = 一个阅读单元（`fb2.js:297` 把 `<body>` 的**直接子 section** 各切一个
 * 独立 xhtml 文档 ⇒ 一个独立 blob: 帧），与 EPUB 的一章一章对齐。
 * `<title>` 里的 `<p>` 被映射成 `<h1>`（`SECTION.title`），既是 TOC 标签也是 PATCH ④ 的断言靶。
 */
const section = (title, inner) => `<section>
<title><p>${title}</p></title>
${inner}
</section>`

/** 正文填充：段落文本唯一可断言，且足够长以触发**真实分页**（否则翻页/进度/CFI 全退化成单页恒真） */
const filler = (from, to) => {
  const out = []
  for (let i = from; i <= to; i++) {
    out.push(`<p>第 ${i} 段：这是探针样书的正文段落，用于驱动真实分页并验证 FB2 阅读器的进度落盘、目录跳转与划选摘录。</p>`)
  }
  return out.join('\n')
}

/**
 * 正常样书：三章 + 章内图片 + 长正文。
 * 三章是刻意的——「点左边缘跨回上一章」这类断言需要真的有上一章可回。
 */
export function probeFb2() {
  return wrap(
    section('第一章 探针样书', `<p>这一段用于验证 FB2 内建样式表在沙箱内是否生效。样式生效时本章标题应居中。</p>
<p>第二段的行首缩进才是可断言的：首段命中 :not(p) + p 规则被归零。</p>
<image l:href="#img1.png"/>
${filler(1, 24)}`)
    + section('第二章 正文与划选', filler(25, 58))
    + section('第三章 收尾', filler(59, 74)),
    `<binary id="img1.png" content-type="image/png">${PNG_1PX.toString('base64')}</binary>`,
  )
}

/**
 * FBZ = 装了 fb2 的 zip（`view.js:90` 在 zip 里找**首个** `filename.endsWith('.fb2')` 的条目再
 * 交给 `makeFB2`）。故「条目名必须以 .fb2 结尾」是这个格式唯一的硬约定；其余随便是关键。
 * 内容与 `probeFb2()` 完全一致 —— 探针因此可以复用同一套断言，只换文件名。
 */
export function probeFbz() {
  return zipStore([
    ['content.fb2', probeFb2()],
    ['probe.txt', 'FBZ 里的非 fb2 条目：探针用它证明「按 .fb2 后缀挑选条目」这一步真的发生了\n'],
  ])
}

/**
 * 恶意样书：三种载荷各占一节。载荷全部 **inert**（只置标志位，不联网、不读文件、不碰宿主数据），
 * 是「验证防线还在不在」的靶子，不是攻击工具。
 *
 * ★ 预期结果（与 EPUB 相反）：三种载荷**一个都进不了 DOM**（白名单转换器丢弃）。
 *   探针同时断言同节的**标记段落**在、载荷节点不在 —— 有正向对照，才排除「其实根本没打开对的那一节」。
 * 每节的标记 `<p>` 文案固定，探针用它定位该节所在的帧（FB2 没有 EPUB 那种 id 锚点可用）。
 */
export function maliciousFb2() {
  return wrap(
    section('第一章 外部脚本载荷', `<p>本页含外部 script 标签。</p>
<script src="evil.js"></script>
<p>这段在外部脚本之后。</p>`)
    + section('第二章 内联脚本载荷', `<p>本页含内联 script 标签。</p>
<script>window.__kbProbePwnedInline = true;
try { window.parent.__kbProbePwnedParent = true; window.parent.document.title = 'PWNED-INLINE' } catch (e) {}</script>
<p>这段在内联脚本之后。</p>`)
    + section('第三章 事件处理器载荷', `<p>本页含 onerror 属性。</p>
<image l:href="#missing.png" onerror="window.__kbProbePwnedOnerror = true; try { window.parent.__kbProbePwnedParentOnerror = true } catch (e) {}"/>
<p>这段在坏图之后。</p>`),
  )
}

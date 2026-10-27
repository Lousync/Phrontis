#!/usr/bin/env node
/**
 * 契约验证：CSDN 人工智能频道列表页解析（electron/lib/intel/rss.ts · parseCsdnHtml）。
 *
 * CSDN 无站级 RSS，只能解析公开 nav 页面；这里钉住卡片选择器、标题/摘要/作者抽取、
 * 去重与 limit，避免站点结构变化后退化成「刷新成功但 0 条」。
 *
 * 用法（仓库根）：node --experimental-strip-types --no-warnings .AGENT/scripts/intel/verify-intel-csdn.mjs
 */
import { parseCsdnHtml } from '../../../electron/lib/intel/rss.ts'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}

const card = (id, title, desc, author, href = `https://blog.csdn.net/u${id}/article/details/${id}`) => `
  <div class="article-item-box" data-v-1>
    <div class="article-item" data-v-1>
      <a href="https://blog.csdn.net/u${id}" class="user-info"><img src="x"><span>${author}</span></a>
      <div class="article-item-cont">
        <a href="${href}" class="article-title word-1">${title}</a>
        <a href="${href}" class="article-desc word-1">${desc}</a>
      </div>
    </div>
  </div>`

const html = `<main>
  ${card(1, 'AI &amp; Agent <b>实践</b>', '第一段摘要', '作者甲')}
  ${card(2, '第二篇', '第二段摘要', '作者乙')}
  ${card(2, '重复链接', '重复摘要', '作者乙')}
  ${card(3, '第三篇', '', '作者丙')}
  ${card(4, '导航链接', '不是文章', '作者丁', 'https://blog.csdn.net/nav/ai')}
</main>`

const got = parseCsdnHtml(html, 10)
check('抽出 3 条有效文章（重复与导航链接被跳过）', got.length, 3)
check('标题实体反转 + 去标签', got[0]?.title, 'AI & Agent 实践')
check('摘要抽取', got[1]?.summary, '第二段摘要')
check('作者抽取', got[2]?.author, '作者丙')
check('空摘要保留空串', got[2]?.summary, '')
check('limit 截断', parseCsdnHtml(html, 1).length, 1)
check('无 article-item-box 返回空', parseCsdnHtml('<html><body>no cards</body></html>', 10).length, 0)

if (failed > 0) {
  console.log(`FAIL  ${failed} case(s) failed`)
  process.exit(1)
}
console.log('PASS  all CSDN parse cases')

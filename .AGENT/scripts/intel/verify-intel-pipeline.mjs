#!/usr/bin/env node
/**
 * 契约脚本：情报管线纯函数（v3.12.0，docs/intel-module-plan.md §11.2）。
 *
 * 断言面（全部直接 import 真实现 src/lib/intelPure.ts，不抄写逻辑）：
 *   · URL 归一化 + hash 去重键 —— 追踪参数 / 大小写 / 尾斜杠 / www. 全部归一；
 *   · intelSpam —— 营销特征词命中、技术文不误伤；
 *   · intelScore —— 0~100、1 位小数；源权重 / 热度 / 摘要完整度 / 新鲜度单调性；
 *   · filterIntelItems —— source / kind(paper/chinese) / kw / ids 四路过滤；
 *   · mergeIntelPool —— hash 去重；已存在只更新热度字段；**fav / 摘要不被覆盖**；
 *   · pruneIntelPool —— 过期清理；**prune 不清 fav**（豁免铁律）；
 *   · capIntelPool —— 上限截断；**fav 恒保留**。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/intel/verify-intel-pipeline.mjs
 */
import {
  normalizeIntelUrl, intelHash, intelIdOf, intelSpam, intelScore,
  filterIntelItems, mergeIntelPool, pruneIntelPool, capIntelPool, sortIntelItems,
  SOURCE_META, INTEL_SOURCE_KEYS, PAPER_SRCS, CN_SRCS, sectionOf, sourceWeightOf,
} from '../../../src/lib/intelPure.ts'

let pass = 0
const fails = []
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

const NOW = new Date('2026-10-25T12:00:00+08:00').getTime()
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
const H = 3600000
const D = 24 * H

/** 造条目（只填断言所需字段，其余走默认；favAt / section 透传） */
const mk = (over = {}) => ({
  id: over.id ?? 'x'.repeat(12),
  hash: over.hash ?? 'h'.repeat(40),
  source: over.source ?? 'github',
  kind: over.kind ?? 'repo',
  title: over.title ?? 'Test Repo',
  url: over.url ?? 'https://example.com/a',
  author: '',
  summary: over.summary ?? 'A test repository for verification',
  tags: [],
  score: over.score ?? 0,
  stars: over.stars,
  publishedAt: over.publishedAt ?? '',
  fetchedAt: over.fetchedAt ?? iso(1 * H),
  fav: over.fav ?? false,
  ...(over.favAt ? { favAt: over.favAt } : {}),
  ...(over.extra ? { extra: over.extra } : {}),
  ...(over.section ? { section: over.section } : {}),
})

console.log('\n=== A. URL 归一化 + hash（去重键）===')
const u1 = 'https://GitHub.com/foo/bar/?utm_source=x&utm_medium=y&fbclid=abc&id=1'
const u2 = 'https://www.github.com/foo/bar?id=1'
ok(normalizeIntelUrl(u1) === normalizeIntelUrl(u2),
  'A1 追踪参数 / 大小写 / www. 归一后等价', `${normalizeIntelUrl(u1)} vs ${normalizeIntelUrl(u2)}`)
ok(normalizeIntelUrl('https://a.com/x/') === 'https://a.com/x', 'A2 尾斜杠去除')
ok(normalizeIntelUrl('https://a.com/x?spm=1&gclid=2&ref=3&q=hi').endsWith('q=hi'), 'A3 spm/gclid/ref 也剥掉')
ok(intelHash(u1) === intelHash(u2), 'A4 同一页面（不同追踪参数）hash 相同 → 去重键成立')
ok(intelHash('https://a.com/1') !== intelHash('https://a.com/2'), 'A5 不同 URL hash 不同')
ok(/^[0-9a-f]{40}$/.test(intelHash('https://a.com')), 'A6 hash = sha256 前 40 位十六进制')
ok(/^[0-9a-f]{12}$/.test(intelIdOf('https://a.com')), 'A7 条目 id = hash 前 12 位')

console.log('\n=== B. 营销水文过滤 ===')
ok(intelSpam('限时优惠 最后3天', '') === true, 'B1 限时优惠命中')
ok(intelSpam('', '扫码关注公众号，加微信领取资料') === true, 'B2 扫码/加微信命中')
ok(intelSpam('副业月入过万指南', '') === true, 'B3 副业月入命中')
ok(intelSpam('Attention Is All You Need: a survey of transformer architectures', 'We review 214 systems with open benchmarks and reproducible training scripts.') === false,
  'B4 技术文不误伤')
ok(intelSpam('开源数据库 SQLite 的 JSONB 深入解析', 'on-disk layout and index behavior') === false, 'B5 技术文不误伤（中文标题）')

console.log('\n=== C. 质量分 ===')
const s1 = intelScore(mk({ source: 'github', stars: 12000, publishedAt: iso(2 * H), summary: 'A comprehensive open source model framework for local inference and deployment with api support'.repeat(4) }))
const s2 = intelScore(mk({ source: 'qbitai', stars: 0, publishedAt: iso(10 * D), summary: '短摘要' }))
ok(s1 >= 0 && s1 <= 100, 'C1 分值在 0~100', String(s1))
ok(Math.round(s1 * 10) === s1 * 10, 'C2 保留 1 位小数', String(s1))
ok(s1 > s2, 'C3 高权重源 + 高热度 + 新鲜 + 完整摘要 > 低权重冷旧短摘要', `${s1} vs ${s2}`)
ok(intelScore(mk({ stars: 5000 })) > intelScore(mk({ stars: 50 })), 'C4 热度单调（log 缩放）')
const older = intelScore(mk({ publishedAt: iso(30 * D), fetchedAt: iso(1 * H) }))
const fresher = intelScore(mk({ publishedAt: iso(1 * H), fetchedAt: iso(1 * H) }))
ok(fresher > older, 'C5 新鲜度单调')
ok(intelScore(mk({ summary: '' })) < intelScore(mk({ summary: 'x'.repeat(200) })), 'C6 摘要完整度单调')
ok(Object.keys(SOURCE_META).length === 14 && INTEL_SOURCE_KEYS.length === 14, 'C7 SOURCE_META 全 14 源（v2：8 科技 + 6 新闻）')
ok(PAPER_SRCS.join() === 'arxiv,openalex,hf' && CN_SRCS.join() === 'weekly,qbitai,people_politics,people_world,sina_china,sina_world,chinanews,wallstcn', 'C8 论文 / 中文来源组合口径（v2：中文含 6 新闻源）')

console.log('\n=== C9. 版面（v2 D11/D14）===')
ok(sectionOf('people_politics') === 'domestic' && sectionOf('wallstcn') === 'finance' && sectionOf('github') === 'tech', 'C9-1 内置源 → 版面归属正确')
ok(sectionOf('custom:abc') === 'tech' && sectionOf('unknown') === 'tech', 'C9-2 自定义/未知键兜 tech（自定义条目落库自带 section，不走这里）')
ok(sourceWeightOf('custom:abc') === 18 && sourceWeightOf('github') === 26, 'C9-3 自定义源权重固定 18（低于全部内置源）')
{
  // D14：非科技版面不套技术信号词表——同文本在 domestic 版面拿不到信号词加分
  const techScore = intelScore(mk({ source: 'github', title: 'new open source llm framework', summary: 'training and inference benchmark for agent models' }))
  const newsScore = intelScore(mk({ source: 'people_politics', section: 'domestic', title: 'new open source llm framework', summary: 'training and inference benchmark for agent models' }))
  ok(techScore > newsScore, 'C9-4 技术信号词只给科技版面加分（D14）', `${techScore} vs ${newsScore}`)
  // 老池条目无 section：sectionOf 兜底后与显式 tech 一致
  const legacy = intelScore(mk({ source: 'github' }))
  const explicit = intelScore(mk({ source: 'github', section: 'tech' }))
  ok(legacy === explicit, 'C9-5 老池条目（无 section）打分与显式 tech 一致')
}
ok(filterIntelItems([
  { ...mk({ id: 's1' }), source: 'people_politics', section: 'domestic' },
  { ...mk({ id: 's2' }), source: 'github', section: 'tech' },
], { section: 'domestic' }).length === 1, 'C9-6 filterIntelItems 支持版面过滤')

console.log('\n=== C10. merge 给老池条目补 section（v2 迁移）===')
{
  const legacyPool = [{ ...mk({ id: 'old1', hash: 'oldhash' }) }]
  delete legacyPool[0].section
  const { pool: merged } = mergeIntelPool(legacyPool, [mk({ id: 'new1', hash: 'newhash', source: 'wallstcn', section: 'finance' })])
  const old1 = merged.find((it) => it.id === 'old1')
  const new1 = merged.find((it) => it.id === 'new1')
  ok(old1.section === 'tech', 'C10-1 老条目补 section=tech（v1 全科技源）')
  ok(new1.section === 'finance', 'C10-2 新条目保留自带 section')
}

console.log('\n=== D. 过滤（feed 与 AI 工具共用）===')
const pool = [
  mk({ id: 'a1', source: 'github', kind: 'repo', title: 'rust compiler', summary: 'systems language' }),
  mk({ id: 'a2', source: 'arxiv', kind: 'paper', title: 'RAG survey', summary: 'retrieval augmented generation' }),
  mk({ id: 'a3', source: 'qbitai', kind: 'news', title: '国产模型发布', summary: '推理性能评测' }),
]
ok(filterIntelItems(pool, { source: 'github' }).length === 1, 'D1 source 过滤')
ok(filterIntelItems(pool, { kind: 'paper' }).map((x) => x.id).join() === 'a2', 'D2 kind=paper 组合过滤')
ok(filterIntelItems(pool, { kind: 'chinese' }).map((x) => x.id).join() === 'a3', 'D3 kind=chinese 组合过滤')
ok(filterIntelItems(pool, { kw: 'RUST' }).map((x) => x.id).join() === 'a1', 'D4 关键词不分大小写')
ok(filterIntelItems(pool, { ids: ['a2', 'a3'] }).length === 2, 'D5 ids 集合过滤')
ok(filterIntelItems(pool, { kw: '不存在词' }).length === 0, 'D6 无命中返回空')

console.log('\n=== E. merge（fav 豁免 / 热度字段更新）===')
const old = mk({ id: 'old1', hash: 'h1', title: 'Old Title', summary: 'old summary', stars: 100, fav: true, favAt: iso(2 * D), score: 50 })
const incoming = mk({ id: 'new1', hash: 'h1', title: 'New Title', summary: 'new summary', stars: 500, score: 99 })
const m1 = mergeIntelPool([old], [incoming])
ok(m1.pool.length === 1 && m1.added === 0, 'E1 同 hash 合并（不新增）')
ok(m1.pool[0].fav === true && !!m1.pool[0].favAt, 'E2 merge 不清 fav / favAt')
ok(m1.pool[0].title === 'Old Title' && m1.pool[0].summary === 'old summary', 'E3 已存在条目的标题 / 摘要不被覆盖')
ok(m1.pool[0].stars === 500, 'E4 热度字段（stars）被更新')
const fresh = mergeIntelPool([], [incoming])
ok(fresh.added === 1 && fresh.pool.length === 1, 'E5 新条目入库 added=1')
const dupBatch = mergeIntelPool([], [mk({ hash: 'hx', id: 'id1' }), mk({ hash: 'hx', id: 'id2' })])
ok(dupBatch.pool.length === 1, 'E6 批内同 hash 只留先到')

console.log('\n=== F. prune / cap（fav 豁免）===')
const fpool = [
  mk({ id: 'f1', fav: true, fetchedAt: iso(30 * D) }),
  mk({ id: 'f2', fav: false, fetchedAt: iso(30 * D) }),
  mk({ id: 'f3', fav: false, fetchedAt: iso(1 * D) }),
]
const p1 = pruneIntelPool(fpool, 14, NOW)
ok(p1.map((x) => x.id).sort().join() === 'f1,f3', 'F1 过期清理且 fav 豁免（f1 留、f2 清、f3 留）')
const big = Array.from({ length: 2100 }, (_, i) => mk({ id: `c${i}`, hash: `c${i}`.padEnd(40, 'x'), fav: i === 2099, score: i }))
const capped = capIntelPool(big, 2000)
ok(capped.length === 2000, 'F2 上限截断到 2000', String(capped.length))
ok(capped.some((x) => x.id === 'c2099'), 'F3 截断时 fav 恒保留')
ok(sortIntelItems(capped)[0].score === Math.max(...capped.map((x) => x.score)), 'F4 池排序 = score 降序')

console.log(`\n[${fails.length === 0 ? 'OK' : 'FAIL'}] verify-intel-pipeline: ${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log('FAILED:', fails.join(' | ')); process.exit(1) }

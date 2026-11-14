// 契约验证：笔记流 + 虚拟主题（v3.27.0，docs/knowledge-feed-topics-plan.md）。
//
// 为什么需要：主题不是目录、只记 pageId 成员 —— 这套设计靠「不写 frontmatter / 不移动文件 /
// 身份修复」三条纪律成立。任何一条被后来的改动破坏，界面都仍然看着正常（成员表还在、
// 卡片还渲染），只是改名/移动后主题悄悄断链。没有断言就必然复发。
//
// 覆盖：
//   ① 数据层：唯一文件 topics.json、唯一写方、不动 frontmatter、不做目录播种
//   ② 纯函数真值：未归类 / 多主题 / 目录分组 / 分组时间边界 / 搜索过滤 / 身份 path 兜底
//   ③ 身份修复：auto 成员按 path 回查 + 失效成员惰性剔除（源码断言）
//   ④ IPC：5 个通道、写通道广播、读通道不广播
//   ⑤ 渲染契约：三视图、总览常驻标签、阅读态自动大纲、拖到主题 ≠ 移动文件
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/knowledge-topics/verify-topics.mjs

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ===== ① 数据层 =====
console.log('\n--- ① 数据层：topics.json 唯一写方 ---')
const repoRaw = read('../phrontis-core/src/kbStore/knowledgeTopicsRepo.ts')
const repo = stripComments(repoRaw)
check('① 文件路径 = .knowbase/modules/knowledge/topics.json', /MODULE = 'modules\/knowledge'/.test(repo) && /KEY = 'topics\.json'/.test(repo))
check('① 写入走 writeJsonOrThrow（失败必须抛出，不能伪装成功）', /writeJsonOrThrow\(MODULE, KEY/.test(repo))
check('① 只写 topics.json —— 不出现 mdStore / serializeMarkdown / frontmatter 写入', !/serializeMarkdown|writeVaultFile|frontmatter\s*\[/.test(repo))
check('① 不移动 / 删除仓库文件（无 renameSync / unlinkSync / trash）', !/renameSync|unlinkSync|trashItem/.test(repo))
check('① 不做「目录 → 主题」播种', !/categories|categoryId/.test(repo))
check('① 导出 5 个动作（list/create/update/delete/members）',
  ['vaultGetTopics', 'vaultCreateTopic', 'vaultUpdateTopic', 'vaultDeleteTopic', 'vaultPatchTopicMembers']
    .every((n) => new RegExp(`export function ${n}`).test(repo)))

// ===== ② 纯函数真值 =====
console.log('\n--- ② topicsPure：未归类 / 分组 / 身份兜底 ---')
const pure = await import('../../../src/modules/knowledge/topicsPure.ts')

const P = (id, path, extra = {}) => ({
  id, title: id, path, contentMd: '', contentHtml: '', categoryId: null,
  isStarred: false, sortOrder: 0, fileType: 'md', attachmentId: '',
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
  tags: [], ...extra,
})
const pages = [
  P('a', '计网/TCP.md'),
  P('b', '计网/UDP.md'),
  P('c', '算法/排序.md'),
  P('d', '根页.md'),
]
const topics = [
  { id: 't1', name: '面试高频', desc: '', color: 'teal', createdAt: '', updatedAt: '', members: [
    { pageId: 'a', addedAt: '', source: 'manual' },
    { pageId: 'c', addedAt: '', source: 'manual' },
  ] },
  { id: 't2', name: '多主题', desc: '', color: 'blue', createdAt: '', updatedAt: '', members: [
    { pageId: 'a', addedAt: '', source: 'manual' },
  ] },
]

check('② 未归类 = 不属于任何主题（目录不再算归类）', pure.unfiledPages(pages, topics).map((p) => p.id).sort().join(',') === 'b,d')
check('② 0 主题时全部未归类', pure.unfiledPages(pages, []).length === pages.length)
check('② 多对多：a 同属两个主题', pure.topicsOfPage('a', topics).map((t) => t.id).sort().join(',') === 't1,t2')
check('② 已归类 id 去重', pure.filedPageIds(topics).size === 2)

const autoTopic = { id: 't3', name: 'auto', desc: '', color: 'gold', createdAt: '', updatedAt: '', members: [
  { pageId: 'auto:计网/TCP.md', path: '计网/TCP.md', addedAt: '', source: 'manual' },
] }
check('② auto: 临时身份按 path 兜底解析到真页', pure.resolveTopicPages(autoTopic, pages)[0]?.id === 'a')

const dirGroups = pure.groupPagesByDir(pages)
check('② 目录分组：同目录归一组', dirGroups.length === 3 && dirGroups.some((g) => g.key === '计网' && g.pages.length === 2))
check('② 跨目录数 = 去重目录数（含根层）', pure.topicDirCount(pages) === 3)
check('② 顶层目录取第一段', pure.topDirOfPath('a/b/c.md') === 'a' && pure.topDirOfPath('x.md') === '')
check('② 目录标签取最后一段 / 根层 = 仓库根', pure.dirLabelOfPath('a/b/c.md') === 'b' && pure.dirLabelOfPath('x.md') === '仓库根')

// 时间边界：以固定 now 断言四档分组
const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const mk = (id, iso) => ({ ...P(id, `${id}.md`), updatedAt: iso })
check('② 今天 / 昨天 / 本周 / 更早 四档边界', [
  pure.recentGroupOf('2026-11-14T11:00:00.000Z', NOW),
  pure.recentGroupOf('2026-11-13T11:00:00.000Z', NOW),
  pure.recentGroupOf('2026-11-10T11:00:00.000Z', NOW),
  pure.recentGroupOf('2026-10-01T11:00:00.000Z', NOW),
].join('|') === '今天|昨天|本周|更早')
check('② 无效时间归「更早」', pure.recentGroupOf('', NOW) === '更早')
const grouped = pure.buildFeedGroups([
  mk('x', '2026-11-14T11:00:00.000Z'), mk('y', '2026-11-14T10:00:00.000Z'), mk('z', '2026-10-01T11:00:00.000Z'),
], 'mtime', NOW)
check('② mtime 分组按修改时间倒序', grouped[0].key === '今天' && grouped[0].pages[0].id === 'x' && grouped[1].pages[0].id === 'z')
check('② title 排序 = 单组扁平列表', pure.buildFeedGroups(pages, 'title', NOW).length === 1)

check('② 搜索命中标题 / 标签 / 目录', pure.filterFeedPages(pages, '排序').length === 1 && pure.filterFeedPages(pages, '计网').length === 2)
check('② 搜索空串 = 不过滤', pure.filterFeedPages(pages, '  ').length === pages.length)
check('② 摘要优先索引 excerpt（正文兜底）', pure.excerptOf({ ...P('q', 'q.md'), excerpt: '摘要文本', contentMd: '正文' }) === '摘要文本')
check('② 相对时间文案', pure.formatRelTime(NOW - 30 * 1000, NOW) === '刚刚' && pure.formatRelTime(NOW - 3 * 24 * 3600 * 1000, NOW) === '3 天前')

// ===== ③ 身份修复 / 惰性剔除（源码断言：逻辑在 normalizeTopics 内）=====
console.log('\n--- ③ 身份修复与失效剔除 ---')
check('③ auto / 失效 id 按 path 回查真 id', /pathToId\.get\(m\.path\)/.test(repo) && /resolved\.startsWith\('auto:'\)/.test(repo))
check('③ 解析不到 = 惰性剔除（continue，不级联删页面）', /if \(!resolved\) continue/.test(repo))
check('③ 成员去重', /seenMembers\.has\(resolved\)/.test(repo))
check('③ 同名主题拒绝', /已存在同名主题/.test(repo))
check('③ 名称 / 描述 / 成员上限', /TOPIC_NAME_MAX = 80/.test(repo) && /TOPIC_DESC_MAX = 300/.test(repo) && /TOPIC_MEMBERS_MAX = 2000/.test(repo))
check('③ 成员加「源」（manual / ai）', /'manual' \| 'ai'/.test(repo) && /source: TopicMemberSource/.test(repo))

// ===== ④ IPC =====
console.log('\n--- ④ IPC：通道 / 广播 ---')
const ipcSrc = stripComments(read('electron/database/repositories/knowledgeRepo.ts'))
for (const ch of ['knowledge:topics:list', 'knowledge:topics:create', 'knowledge:topics:update', 'knowledge:topics:delete', 'knowledge:topics:members']) {
  check(`④ 注册通道 ${ch}`, ipcSrc.includes(`kHandle('${ch}'`))
  check(`④ 白名单包含 ${ch}`, ipcSrc.includes(`'${ch}'`))
}
check('④ 4 个写通道写后广播 knowledge', (ipcSrc.match(/broadcastDataChanged\('knowledge'\)/g) || []).length >= 4)
check('④ 读通道（list）不广播', /kHandle\('knowledge:topics:list', \(\) => vaultGetTopics\(\)\)/.test(ipcSrc))

const preload = stripComments(read('electron/preload/index.ts'))
check('④ preload 暴露 5 个 bridge', ['getKnowledgeTopics', 'createKnowledgeTopic', 'updateKnowledgeTopic', 'deleteKnowledgeTopic', 'patchKnowledgeTopicMembers']
  .every((n) => new RegExp(`${n}:`).test(preload)))

// ===== ⑤ 渲染契约 =====
console.log('\n--- ⑤ 渲染层：三视图 / 总览标签 / 大纲 / 拖拽 ---')
const mod = stripComments(read('src/modules/knowledge/index.tsx'))
check('⑤ 三视图 = 最近 / 主题 / 结构', /'recent' \| 'topics' \| 'tree'/.test(mod))
check('⑤ 结构视图复用 VaultTree', /feedView === 'recent'[\s\S]*?feedView === 'topics'[\s\S]*?<VaultTree/.test(mod))
check('⑤ 总览是常驻固定标签（closable:false + HOME_TAB_ID）', /HOME_TAB_ID, title: '总览', kind: 'home' as const, closable: false/.test(mod))
check('⑤ 点总览标签不清空已开页面（只改 homeActive）', /setHomeActive\(true\)/.test(mod) && /setActiveTopicId\(null\)/.test(mod))
check('⑤ 风格页面条恒可见（onStripVisible 恒 true）', /onStripVisibleRef\.current\?\.\(true\)/.test(mod))
check('⑤ 阅读态自动大纲（activePreview + manualFeed 覆盖）', /const outlineMode = .*activeIsMd.*activePreview.*manualFeed/.test(mod))
check('⑤ PageEditor 上报阅读态', /onPreviewChange=/.test(mod))
check('⑤ PageEditor 接线 onPreviewChange', /onPreviewChange\?: \(preview: boolean\)/.test(stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))))
check('⑤ ＋ 菜单含「新建主题」', /label: '新建主题'/.test(mod))
check('⑤ 笔记右键含「加入主题…」与「新建主题并加入…」', /label: '加入主题…'/.test(mod) && /label: '新建主题并加入…'/.test(mod))
check('⑤ 拖到主题 = 加成员（onAddMember），不调用移动文件', /onAddMember=\{handleAddMember\}/.test(mod) && !/dropOnTopic[\s\S]{0,200}handleTreeMove/.test(mod))
check('⑤ 主题删除走行内确认（无中央模态）', /确认删除/.test(stripComments(read('src/modules/knowledge/components/TopicDetail.tsx'))))

const wall = stripComments(read('src/modules/knowledge/components/TopicWall.tsx'))
check('⑤ 主题卡是 pointer 拖拽（铁律 9，不用 HTML5 dataTransfer）', /onPointerDown/.test(wall) && !/dataTransfer/.test(wall))
check('⑤ 落点识别走 data-topic-drop', /data-topic-drop/.test(wall))

// 负向断言：不得出现「拖到主题 = 移动文件」/ 不写 frontmatter
check('负数：主题数据层不写 frontmatter', !/frontmatter/.test(repo))
check('负数：主题成员变更不调用 move / rename', !/vaultMove|vaultRename|handleTreeMove/.test(repo))

console.log(`\n${pass ? 'PASS 全部通过' : 'FAIL 有失败项'}`)
process.exit(pass ? 0 : 1)

/**
 * 演示仓库错题本播种脚本（配套 extract-bank.mjs 使用）
 *
 * 两件事：
 *  A. 给若干「知识点页」追加《## 配套练习》章节（复用真题题库中同主题的选择题），
 *     使这些页面真正含题 —— 错题记录指向它们才自洽（打开源页面 / 重刷都能对上）。
 *  B. 生成错题本五份 JSON（records / collections / record-collections / tags / record-tags），
 *     覆盖：错次档位（轻 1 / 中 2-3 / 顽固 4+）、已掌握、纯收藏、备注、标签、自定义分组、今日错。
 *
 * 用法（先跑 extract-bank.mjs 产出 out/quiz-bank.json）：
 *   node seed-quiz.mjs            # 干跑：只打印规划（选题 + 分布），不写盘
 *   node seed-quiz.mjs --backup   # 备份当前磁盘原样（24 个目标页 + records.json）到 backup/
 *   node seed-quiz.mjs --write    # 落盘：追加配套练习 + 写五份 JSON
 *   node seed-quiz.mjs --revert --write   # 回滚：剥掉《## 配套练习》章节（records 不动）
 *
 * 推荐流程（可回滚）：
 *   --revert --write（回到干净页）→ --backup（存干净基线）→ 恢复 records.json → --write
 *
 * 注意：脚本把现有 records.json 当作「既有真实记录」保留并补齐 source_space，
 * 所以**重复 --write 会叠加**（既有记录翻倍）。重跑前先用 --backup 里的基线覆盖 records.json。
 *
 * 仓库路径：命令行第 2 个参数 或 环境变量 DEMO_VAULT，默认 E:/演示
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.DEMO_VAULT || 'E:/演示'
const QUIZ_DIR = path.join(ROOT, '.knowbase/modules/quiz')
const BANK_FILE = path.join(HERE, 'out/quiz-bank.json')
const WRITE = process.argv.includes('--write')
const REVERT = process.argv.includes('--revert')
const BACKUP_ONLY = process.argv.includes('--backup')

const BACKUP_DIR = path.join(HERE, 'backup')

const PRACTICE_HEADING = '## 配套练习'
/** 播种基准日 = 本机当天（本地时区，不能用 toISOString 的 UTC 日期）：今日错与日期分布以它为准 */
function localToday() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const TODAY = localToday()

// ============ 工具 ============

const HEAD_RE = /^###\s+第\s*(\d+)\s*题(?:\s*[（(]\s*(\d+)\s*分\s*[）)])?/m
const OPT_RE = /^-\s*\*\*([A-H])\.?\*\*\s*(.*)$/i

const cats = JSON.parse(fs.readFileSync(path.join(ROOT, '.knowbase/modules/knowledge/categories.json'), 'utf-8'))
const catById = new Map(cats.map((c) => [c.id, c]))

function resolveSource(categoryId) {
  let space = ''
  let notebook = ''
  const folders = []
  let curId = categoryId
  let guard = 0
  while (curId && guard++ < 12) {
    const cat = catById.get(curId)
    if (!cat) break
    if (cat.categoryType === 'space') { space = cat.name; break }
    if (cat.categoryType === 'notebook') { if (!notebook) notebook = cat.name }
    else if (cat.categoryType === 'folder' && cat.name) folders.unshift(cat.name)
    curId = cat.parentId
  }
  return { space, notebook, chapter: folders.join(' › ') }
}

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['.knowbase', '.git', '.attachments'].includes(e.name)) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

/** 页面记录：路径 / frontmatter / 来源 / 标题 */
function loadPages() {
  const out = []
  for (const f of walk(ROOT)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    const text = fs.readFileSync(f, 'utf-8')
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) continue
    const fm = {}
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^(\w+):\s*(.*)$/)
      if (mm) fm[mm[1]] = mm[2]
    }
    if (!fm.id || !fm.category) continue
    out.push({
      file: f, rel, id: fm.id, title: (fm.title || '').replace(/^"|"$/g, ''),
      categoryId: fm.category, ...resolveSource(fm.category), text,
    })
  }
  return out
}

// ============ 目标页 × 主题关键词 ============
/** 每科挑选 6 个知识点页，用关键词从真题题库里挑同主题题（每题标注所属科目） */
const TARGETS = [
  // --- 数据结构 ---
  { id: '399cfe74-39a1-4f81-88b1-8cf8087f7667', subject: '数据结构', kw: ['连通', '顶点', '完全图', '度之', '生成树', '无向图', '简单路径', '度数'],
    not: ['最小生成树', '最短路径', '拓扑', '关键路径', 'Dijkstra', 'Kruskal', 'Prim', '排序'] },
  { id: 'a8a9aea1-66b0-424d-8c4e-f4284b056371', subject: '数据结构', kw: ['最小生成树', '拓扑', '关键路径', '最短路径', 'Dijkstra', 'Prim', 'Kruskal', 'AOV', 'AOE'] },
  { id: 'a3805646-cdac-4925-9648-c04d0abbb0ba', subject: '数据结构', kw: ['排序', '希尔', '堆', '归并', '基数', '冒泡', '直接插入'],
    not: ['折半', '查找'] },
  { id: '0b33e4ed-f7b5-4a98-852d-e1b5d3e8a4fd', subject: '数据结构', kw: ['折半', '二分', '判定树', '查找长度'],
    not: ['排序', '插入排序'] },
  { id: 'c665b299-a71a-4f4a-b126-0039901dbede', subject: '数据结构', kw: ['二叉树', '结点', '叶子', '结点数', '高度', '完全二叉树', '哈夫曼', '中序', '前序'] },
  { id: 'db8ac62c-08eb-4432-b481-6246b1bfb7ac', subject: '数据结构', kw: ['散列', '哈希', '装填因子', '冲突', '同义词'] },
  // --- 计算机组成原理 ---
  { id: 'e04abedf-15cd-4dc3-87f5-e301acd6fac2', subject: '计算机组成原理', kw: ['Cache', '命中率', '映射', '主存块', '组相联'] },
  { id: '4d6b4180-8022-48c8-b98a-1f7740796da2', subject: '计算机组成原理', kw: ['页表', '虚拟地址', '缺页', 'TLB', '段页', '逻辑地址', '有效地址'] },
  { id: 'a53ce4be-589b-4670-9b42-c727d9151a87', subject: '计算机组成原理', kw: ['浮点', 'IEEE', '阶码', '尾数', '规格化'],
    not: ['Cache', '页'] },
  { id: '5e9d05c8-99a5-43f5-9444-6e6608b4bc1e', subject: '计算机组成原理', kw: ['补码', '反码', '原码', '溢出', '移码', '无符号', '真值'],
    not: ['浮点', 'IEEE'] },
  { id: 'f6307b90-88f0-435f-a63a-463af3b90902', subject: '计算机组成原理', kw: ['流水线', '冒险', '相关', '加速比', '吞吐率', '数据通路'] },
  { id: '8a977dfe-63e0-48d5-a6c3-73ca3f7ec735', subject: '计算机组成原理', kw: ['中断', 'DMA', 'I/O', '程序查询', '响应优先级', '屏蔽字'] },
  // --- 操作系统（先收窄页面：死锁 / 调度 / 同步，再放进程与线程） ---
  { id: 'bfe87727-131b-42f6-804e-79d007d0c12b', subject: '操作系统', kw: ['死锁', '银行家', '安全序', '资源分配图'] },
  { id: 'ef2f4c0c-ce96-4e77-9a57-3d036e567d3b', subject: '操作系统', kw: ['调度', '周转时间', '响应比', '时间片', '优先级', '等待时间'],
    not: ['死锁'] },
  { id: 'ee04621f-e052-4424-9b3d-15afc105bed4', subject: '操作系统', kw: ['信号量', '互斥', 'PV', 'P 操作', 'V 操作', '同步', '临界区'],
    not: ['死锁'] },
  { id: '6238d65d-3a4f-4f83-a758-6ceae59f3890', subject: '操作系统', kw: ['进程', '线程', '就绪', '阻塞', '状态'],
    not: ['死锁', '调度', '周转', '时间片', '信号量', '临界区'] },
  { id: '90193d83-53d2-43bb-bbbf-59a3b5f8ffbc', subject: '操作系统', kw: ['页面置换', '缺页', 'LRU', 'FIFO', '驻留集', '抖动', '工作集'] },
  { id: '144f2e35-de8b-44a0-a036-56e48a6792fb', subject: '操作系统', kw: ['索引', '目录', '文件', 'FCB', '磁盘块', '超级块', '位示图'] },
  // --- 计算机网络 ---
  { id: '3af9f289-a1ac-4b17-af50-f57364853d53', subject: '计算机网络', kw: ['TCP', '拥塞', '窗口', '三次握手', '慢开始', '确认号', '序号'],
    not: ['UDP'] },
  { id: '759200da-282f-42be-8b0c-764899a124cf', subject: '计算机网络', kw: ['UDP', '分用'],
    not: ['NAT', '子网', '路由'] },
  { id: '9f66afbd-d002-4903-94a7-fdf938f2f926', subject: '计算机网络', kw: ['IP', '子网', 'CIDR', '分片', '地址块', '前缀', '掩码', '路由器功能'] },
  { id: '11d95b0f-b643-48ec-a7d5-29c5dd50d738', subject: '计算机网络', kw: ['路由', 'RIP', 'OSPF', 'BGP', '距离向量', '链路状态', '区域'],
    not: ['子网掩码'] },
  { id: '4e8dc523-2ec1-465b-9a8a-57f9972cf059', subject: '计算机网络', kw: ['滑动窗口', '后退 N', '选择重传', '序号', '传播时延'] },
  { id: '51cf0aa1-cde1-439c-8700-e50560d353d3', subject: '计算机网络', kw: ['DNS', 'HTTP', 'SMTP', 'FTP', '邮件', '域名', '递归', '迭代'] },
]

/** 从页面的 pageTitle 推科目（"2009 · 数据结构" → "数据结构"） */
function subjectOf(pageTitle) {
  for (const s of ['数据结构', '计算机组成原理', '操作系统', '计算机网络']) {
    if (pageTitle.includes(s)) return s
  }
  return ''
}

// ============ 复刻旧的 408 题块渲染格式 ============
function renderBlock(q, no) {
  const lines = []
  lines.push(`### 第 ${no} 题${q.points ? `（${q.points} 分）` : ''}`)
  lines.push('')
  lines.push(q.question)
  lines.push('')
  for (const o of q.options) lines.push(`- **${o.key}.** ${o.text}`)
  lines.push('')
  lines.push('```spoiler-answer')
  lines.push(`**答案：${q.answer}**`)
  lines.push('')
  lines.push(`**解析**：${q.explanation}`)
  lines.push('```')
  return lines.join('\n')
}

function stripExistingPractice(text) {
  const i = text.indexOf('\n' + PRACTICE_HEADING)
  return i === -1 ? text : text.slice(0, i).replace(/\s+$/, '') + '\n'
}

// ============ 主流程 ============
const pages = loadPages()
const byId = new Map(pages.map((p) => [p.id, p]))

if (REVERT) {
  let n = 0
  for (const t of TARGETS) {
    const p = byId.get(t.id)
    if (!p) continue
    const next = stripExistingPractice(p.text)
    if (next !== p.text) { if (WRITE) fs.writeFileSync(p.file, next, 'utf-8'); n++ }
  }
  console.log(`已剥离《配套练习》章节的页面：${n}` + (WRITE ? '（已落盘）' : '（干跑）'))
  process.exit(0)
}

const bank = JSON.parse(fs.readFileSync(BANK_FILE, 'utf-8'))

/** 全局占用表：同一道真题只能被一个知识点页收编，避免重复 */
const usedQuestion = new Set()

function pickQuestions(subject, kw, count, not = []) {
  const scored = []
  for (const q of bank) {
    if (subjectOf(q.pageTitle) !== subject) continue
    if (usedQuestion.has(q.rel + '#' + q.no)) continue
    const text = q.question
    if (not.some((n) => text.includes(n))) continue
    let score = 0
    for (const k of kw) if (text.includes(k)) score += 3
    if (!score) continue
    scored.push({ q, score, year: q.chapter })
  }
  // 同分优先取不同年份，保证题目来源分散
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  const usedYear = new Set()
  for (const s of scored) {
    if (picked.length >= count) break
    if (usedYear.has(s.year)) continue
    usedYear.add(s.year)
    picked.push(s.q)
  }
  for (const s of scored) {
    if (picked.length >= count) break
    if (!picked.includes(s.q)) picked.push(s.q)
  }
  return picked
}

// ---- A. 追加《## 配套练习》 ----
const practicePlan = []
for (const t of TARGETS) {
  const p = byId.get(t.id)
  if (!p) { console.log('!! 未找到目标页', t.id); continue }
  const picked = pickQuestions(t.subject, t.kw, 3, t.not || [])
  if (picked.length === 0) { console.log('!! 未选到题目', p.title); continue }
  for (const q of picked) usedQuestion.add(q.rel + '#' + q.no)
  practicePlan.push({ page: p, questions: picked })
}

console.log('===== A. 知识点页配套练习 =====')
for (const { page: p, questions } of practicePlan) {
  console.log(`\n- [${p.notebook}/${p.chapter}] ${p.title}`)
  for (const q of questions) console.log(`    ${q.chapter.replace(' 年', '')}·第${q.no}题  ${q.question.replace(/\s+/g, ' ').slice(0, 62)}…  答案 ${q.answer}`)
}

if (BACKUP_ONLY) {
  fs.mkdirSync(path.join(BACKUP_DIR, 'md'), { recursive: true })
  fs.mkdirSync(path.join(BACKUP_DIR, 'quiz'), { recursive: true })
  for (const { page: p } of practicePlan) {
    const dst = path.join(BACKUP_DIR, 'md', path.relative(ROOT, p.file))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, p.text, 'utf-8')
  }
  if (fs.existsSync(path.join(QUIZ_DIR, 'records.json'))) {
    fs.copyFileSync(path.join(QUIZ_DIR, 'records.json'), path.join(BACKUP_DIR, 'quiz/records.json'))
  }
  console.log(`\n已备份当前磁盘原样到 ${BACKUP_DIR}（${practicePlan.length} 个页面${fs.existsSync(path.join(QUIZ_DIR, 'records.json')) ? ' + records.json' : ''}）`)
  process.exit(0)
}

if (WRITE) {
  for (const { page: p, questions } of practicePlan) {
    const body = questions.map((q, i) => renderBlock(q, i + 1)).join('\n\n---\n\n')
    const next = stripExistingPractice(p.text) + `\n\n${PRACTICE_HEADING}\n\n> 真题改编 · 共 ${questions.length} 题 · 答案与解析默认折叠\n\n` + body + '\n'
    fs.writeFileSync(p.file, next, 'utf-8')
  }
  console.log(`已写入 ${practicePlan.length} 个知识点页。`)
}

// ---- B. 生成错题本五表 ----
const practicePages = new Map(practicePlan.map((x) => [x.page.id, x]))

// 已有 19 条真实记录（2009/2011 · 数据结构），保留并补 source_space
const oldRecords = JSON.parse(fs.readFileSync(path.join(QUIZ_DIR, 'records.json'), 'utf-8'))
for (const r of oldRecords) r.source_space = '408 学习空间'

const records = [...oldRecords]
const nowStamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
/** 把 'YYYY-MM-DD' 变成过去某天的随机时刻字符串 */
function stampDaysAgo(days, hour = 20) {
  const base = new Date(`${TODAY}T${String(hour).padStart(2, '0')}:30:00`)
  base.setDate(base.getDate() - days)
  return nowStamp(base)
}

const TAG_DEFS = [
  { name: '树与图', kind: 'topic', color: '#185fa5' },
  { name: '排序查找', kind: 'topic', color: '#0f6e56' },
  { name: '存储系统', kind: 'topic', color: '#534ab7' },
  { name: '进程与调度', kind: 'topic', color: '#993556' },
  { name: '网络分层', kind: 'topic', color: '#0f766e' },
  { name: '计算题', kind: 'type', color: '#854f0b' },
  { name: '概念辨析', kind: 'type', color: '#3b6d11' },
  { name: '偏难', kind: 'difficulty', color: '#a32d2d' },
  { name: '408 高频', kind: 'custom', color: '#993c1d' },
  { name: '考前必看', kind: 'custom', color: '#6d28d9' },
]
const tags = TAG_DEFS.map((t, i) => ({
  id: randomUUID(), name: t.name, kind: t.kind, color: t.color, sort_order: i, created_at: stampDaysAgo(22, 9),
}))

const COLLECTION_DEFS = ['暑期强化错题', '考前必刷', '易混概念', '典型陷阱', '二轮复习']
const collections = COLLECTION_DEFS.map((name, i) => ({
  id: randomUUID(), name, sort_order: i, created_at: stampDaysAgo(22 - i, 9),
}))

const recordCollections = []
const recordTags = []
const pick = (arr, n, seed) => {
  const out = []
  for (let i = 0; i < n; i++) out.push(arr[(seed * 7 + i * 3) % arr.length])
  return [...new Set(out)]
}

const NOTES = [
  '这题我又栽在"极大"两个字上：连通分量是极大连通子图，不是顶点数最多。',
  '关键是要先写出渐进记号再比较，我总爱直接看系数。',
  '记牢：先算地址位数，再算块内偏移，顺序反了就全错。',
  '陷阱在"至多/至少"——题目问下界时别用上界公式。',
  '把公式抄在错题旁：这道题的套路就是套模板，识别出题型就秒了。',
  '考场上遇到同类题先画图，图一画出来就清楚了。',
  '上次就是这道题差 2 分，务必记住这个反例。',
  '被"默认"坑了，TCP 默认是累积确认，不是选择确认。',
  '计算时单位别丢：MB 和 Mbit 差了 8 倍，我上次就错在这。',
  '这题和 2016 年第 7 题是同一个考点，合起来看。',
]

/** 错次档位：light 1 / mid 2-3 / stubborn 4+ / mastered（错过后连对≥2） / pure-fav（纯收藏） */
const PLAN = []
// 知识点页配套练习：3 题 → 三档各一
const kindCycle = ['stubborn', 'mid', 'light']
practicePlan.forEach(({ page: p, questions }, pi) => {
  questions.forEach((q, qi) => {
    const kind = kindCycle[(pi + qi) % 3]
    // localNo：页内重新编号后的题号（配套练习按 1..N 重排），必须与页面上的「第 N 题」一致
    PLAN.push({ page: p, q, kind, seq: pi * 10 + qi, localNo: qi + 1 })
  })
})

// 真题页记录：再补 36 条，铺满 4 科 × 若干年份
const realPages = pages.filter((p) => p.notebook === '历年真题')
const YEARS = ['2013 年', '2015 年', '2017 年', '2019 年', '2021 年', '2023 年', '2025 年']
let added = 0
outer: for (const year of YEARS) {
  const yearPages = realPages.filter((p) => p.chapter === year)
  for (const p of yearPages) {
    const qs = bank.filter((b) => b.pageId === p.id).slice(0, 6)
    qs.forEach((q, i) => {
      const kind = ['light', 'mid', 'mastered', 'stubborn', 'light', 'mastered'][i % 6]
      PLAN.push({ page: p, q, kind, seq: 900 + added * 10 + i, isReal: true })
    })
    added += qs.length
    if (added >= 36) break outer
  }
}

const kindCount = {}
for (const item of PLAN) {
  kindCount[item.kind] = (kindCount[item.kind] || 0) + 1
  const { page: p, q, kind, seq, localNo } = item
  const day = 3 + (seq % 18)          // 3~20 天前
  const created = stampDaysAgo(day + 2, 19)
  let updated = stampDaysAgo(day, 21)
  let wrong = 0, correct = 0, last = null, streak = 0, fav = 0

  const extraWrong = [0, 1, 2, 3, 5][seq % 5]
  if (kind === 'light') { wrong = 1; correct = 3 + (seq % 3); last = 1; streak = 1 }
  else if (kind === 'mid') { wrong = 2 + (seq % 2); correct = 2 + (seq % 3); last = 0; streak = 0 }
  else if (kind === 'stubborn') { wrong = 4 + (seq % 3) + extraWrong; correct = 1 + (seq % 2); last = 0; streak = 0 }
  else if (kind === 'mastered') { wrong = 2 + (seq % 3); correct = 5 + (seq % 3); last = 1; streak = 2 + (seq % 2) }
  else { wrong = 0; correct = 0; last = null; streak = 0; fav = 1 }

  if (kind !== 'pure-fav' && seq % 7 === 0) fav = 1
  // 今日错：把一部分 last_result=0 的记录改到今天
  const isToday = kind === 'mid' && seq % 11 === 0
  if (isToday) updated = `${TODAY} ${String(9 + (seq % 8)).padStart(2, '0')}:${String((seq * 7) % 60).padStart(2, '0')}:00`

  const no = localNo ?? q.no
  const snapshot = { no, question: q.question, options: q.options, answer: q.answer, explanation: q.explanation }
  const src = resolveSource(p.categoryId)

  const row = {
    id: randomUUID(),
    page_id: p.id,
    quiz_no: no,
    page_title: p.title,
    is_favorite: fav,
    wrong_count: wrong,
    correct_count: correct,
    last_result: last,
    streak_correct: streak,
    note: '',
    snapshot_json: JSON.stringify(snapshot),
    source_space: src.space,
    source_notebook: src.notebook,
    source_chapter: src.chapter,
    created_at: created,
    updated_at: updated,
  }
  if (kind === 'stubborn' && seq % 3 === 0) row.note = NOTES[seq % NOTES.length]
  else if (kind === 'mid' && seq % 5 === 0) row.note = NOTES[(seq + 3) % NOTES.length]
  else if (kind === 'mastered' && seq % 4 === 0) row.note = NOTES[(seq + 6) % NOTES.length]

  records.push(row)

  // 分组：顽固 → 典型陷阱（一半兼入考前必刷）；中错 → 暑期强化（少数易混概念）；
  // 轻错 → 暑期强化 / 易混概念 各半；已掌握 → 二轮复习；收藏 → 考前必刷
  const colHit = []
  if (kind === 'stubborn') { colHit.push(collections[3]); if (seq % 2 === 0) colHit.push(collections[1]) }
  if (kind === 'mid') colHit.push(seq % 3 === 0 ? collections[2] : collections[0])
  if (kind === 'light') colHit.push(seq % 2 === 0 ? collections[2] : collections[0])
  if (kind === 'mastered') colHit.push(collections[4])
  if (fav) colHit.push(collections[1])
  for (const c of [...new Set(colHit)]) recordCollections.push({ record_id: row.id, collection_id: c.id })

  // 标签：章节 → 考点标签；题型按章节性质判定；等第/频次标签按档位
  const tagHit = []
  const ch = src.chapter
  if (/图|二叉树|树/.test(ch)) tagHit.push(tags[0])
  if (/排序|查找|串/.test(ch)) tagHit.push(tags[1])
  if (/存储|数据的表示|中央处理器|指令|总线/.test(ch)) tagHit.push(tags[2])
  if (/进程|内存|文件|输入输出/.test(ch)) tagHit.push(tags[3])
  if (/传输层|网络层|数据链路层|物理层|应用层|体系结构/.test(ch)) tagHit.push(tags[4])
  if (/存储|数据的表示|中央处理器|指令|总线|网络层|内存管理|文件管理|排序|查找/.test(ch)) tagHit.push(tags[5])
  else tagHit.push(tags[6])
  if (kind === 'stubborn' || kind === 'mid') tagHit.push(tags[7])
  if (seq % 6 === 0) tagHit.push(tags[8])
  if (kind === 'pure-fav' || kind === 'mastered') tagHit.push(tags[9])
  for (const t of [...new Set(tagHit)]) recordTags.push({ record_id: row.id, tag_id: t.id })
}

console.log('\n===== B. 错题记录规划 =====')
console.log('总记录:', records.length, '（含原有', oldRecords.length, '条）')
console.log('档位分布:', JSON.stringify(kindCount))
const byBook = {}
for (const r of records) byBook[r.source_notebook] = (byBook[r.source_notebook] || 0) + 1
console.log('按书（笔记本）:', JSON.stringify(byBook))
const bySpace = {}
for (const r of records) bySpace[r.source_space || '(空)'] = (bySpace[r.source_space || '(空)'] || 0) + 1
console.log('按空间:', JSON.stringify(bySpace))
const wrongList = records.filter((r) => r.wrong_count > 0 && (r.streak_correct || 0) < 2)
const mastered = records.filter((r) => r.wrong_count > 0 && (r.streak_correct || 0) >= 2)
const favs = records.filter((r) => r.is_favorite)
const todayWrong = records.filter((r) => r.last_result === 0 && r.updated_at.slice(0, 10) === TODAY)
const sumC = records.reduce((a, r) => a + r.correct_count, 0)
const sumW = records.reduce((a, r) => a + r.wrong_count, 0)
console.log(`错题列表 ${wrongList.length} | 已掌握 ${mastered.length} | 收藏 ${favs.length} | 今日错 ${todayWrong.length} | 正确率 ${Math.round((sumC / (sumC + sumW)) * 100)}%`)
console.log(`分组关联 ${recordCollections.length} 条 | 标签关联 ${recordTags.length} 条 | 备注 ${records.filter((r) => r.note).length} 条`)

if (WRITE) {
  const w = (f, d) => fs.writeFileSync(path.join(QUIZ_DIR, f), JSON.stringify(d, null, 1), 'utf-8')
  w('records.json', records)
  w('collections.json', collections)
  w('record-collections.json', recordCollections)
  w('tags.json', tags)
  w('record-tags.json', recordTags)
  console.log('\n已写入', QUIZ_DIR)
}

/**
 * 探针 fixture 仓库种子：探针 userData（%APPDATA%/knowbase (dev KnowledgeRecorder)，dev 隔离）默认无仓库 →
 * 编辑器走「未打开仓库」欢迎态，文件树侧栏不渲染，T1c/T3b portal 断言必然空。
 * 这里造一个带 .knowbase 的 fixture 仓库 + 登记（data/vaults.json）+ settings.currentVaultId，
 * 让 electron 启动时经 workspaceManager.loadVaults() 常规恢复路径打开它（不用原生对话框）。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const proj = 'E:/Projects/KnowledgeRecorder'
const fixture = join(proj, 'tmp', 'vault-fixture')
const userData = join(process.env.APPDATA ?? '', 'knowbase (dev KnowledgeRecorder)')

// 1. fixture 仓库：.knowbase + 两个目录 + 散文件
for (const d of ['.knowbase', 'AI教学', '学习笔记']) mkdirSync(join(fixture, d), { recursive: true })
writeFileSync(join(fixture, 'README.md'), '# 探针 fixture\n\n仅供 probe-shell-b3 使用。\n', 'utf8')
writeFileSync(join(fixture, '学习笔记', '笔记一.md'), '# 笔记一\n\nfixture 内容。\n', 'utf8')

// 1b. B1 @ 引用（probe-batch5-ai E 组）需要 ≥5 个**可引用**页面（带 frontmatter id 的 doc，
//     非欢迎页）——chip 上限 4 篇要加到第 5 篇才验得出「超限被拒」。
//     无 frontmatter id 的 md 是草稿、知识库不显示，所以这批必须带 id。
for (let i = 1; i <= 6; i++) {
  const dir = join(fixture, '引用测试')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `引用页${i}.md`),
    `---\nid: probe-ref-${i}\ntitle: 引用页${i}\ntags: [探针, 引用]\n---\n\n# 引用页${i} 一级标题\n\n## 小节 A\n## 小节 B\n\n这是第 ${i} 篇引用测试页的首段正文，供 B1 骨架注入与 chip 上限断言使用。\n`,
    'utf8',
  )
}
// 1c. 全格式阅读器一期（2026-09-20）：--add-books → .books/ 落一本 TXT 样书
//     （几十段中文、空行分段），probe-reading-panel.mjs 断言链的 fixture
if (process.argv.includes('--add-books')) {
  const booksDir = join(fixture, '.books')
  mkdirSync(booksDir, { recursive: true })
  const bookPath = join(booksDir, '探针样书.txt')
  if (!existsSync(bookPath)) {
    const paras = []
    for (let i = 1; i <= 60; i++) {
      paras.push(`第 ${i} 段：这是探针样书的正文段落，用于驱动真实滚动并验证 TXT 阅读器的进度落盘与右栏阅读侧栏联动。`)
      paras.push('')
    }
    writeFileSync(bookPath, paras.join('\n'), 'utf8')
    console.log('seeded book:', bookPath)
  }
}

if (!existsSync(join(fixture, '.knowbase', 'meta.json'))) {
  writeFileSync(join(fixture, '.knowbase', 'meta.json'), JSON.stringify({ name: '探针测试仓库', createdAt: new Date().toISOString() }), 'utf8')
}

// 2. 仓库登记表：userData/data/vaults.json
const dataDir = join(userData, 'data')
mkdirSync(dataDir, { recursive: true })
const vaultsPath = join(dataDir, 'vaults.json')
const row = {
  id: 'probe-vault-01',
  name: '探针测试仓库',
  path: fixture,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}
let rows = []
if (existsSync(vaultsPath)) {
  try { rows = JSON.parse(readFileSync(vaultsPath, 'utf8')) ?? [] } catch { rows = [] }
}
const mine = rows.filter((r) => r.id !== row.id)
writeFileSync(vaultsPath, JSON.stringify([...mine, row], null, 2), 'utf8')

// 3. settings.json：currentVaultId 指向 fixture（保留其他键）
const settingsPath = join(userData, 'settings.json')
let settings = {}
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {} } catch { settings = {} }
}
settings.currentVaultId = row.id
writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

console.log('seeded:', row.path)
console.log('vaults.json rows:', rows.length + 1)
console.log('settings.currentVaultId =', settings.currentVaultId)

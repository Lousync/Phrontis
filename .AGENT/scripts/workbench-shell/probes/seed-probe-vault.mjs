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

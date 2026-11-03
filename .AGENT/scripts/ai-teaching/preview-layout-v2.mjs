/**
 * 迁移预览（只读）：打印 chapter-segment-v1 会怎么整理一个真实仓库。
 *
 * 用法：
 *   node .AGENT/scripts/ai-teaching/preview-layout-v2.mjs "/path/to/vault" "AI教学/接口备考"
 *
 * 不写盘、不建目录；确认移动清单后，再由应用打开工作区触发正式迁移。
 * 输出纯 ASCII（禁 emoji）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const vaultRoot = process.argv[2]
const wsRel = String(process.argv[3] ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
if (!vaultRoot || !wsRel) {
  console.error('用法：node .AGENT/scripts/ai-teaching/preview-layout-v2.mjs <vault-root> <workspace-rel>')
  process.exit(2)
}
const vaultAbs = path.resolve(vaultRoot)
const wsAbs = path.join(vaultAbs, wsRel)
if (!fs.existsSync(wsAbs)) {
  console.error(`[FAIL] 工作区不存在：${wsAbs}`)
  process.exit(2)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-layout-preview-'))
function load(rel) {
  let out = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { mode: 'strip' })
  out = out.replace(/from '\.\/([^']+)'/g, "from './$1.mjs'")
  const file = path.join(tmp, `${path.basename(rel, '.ts')}.mjs`)
  fs.writeFileSync(file, out)
  return import(pathToFileURL(file).href)
}

const layout = await load('electron/lib/aiTeachingLayoutPure.ts')
const coursePure = await load('electron/lib/aiTeachingCoursePure.ts')
const migration = await load('electron/lib/aiTeachingLayoutMigrationPure.ts')

const courseFile = path.join(wsAbs, '课程.md')
if (!fs.existsSync(courseFile)) {
  console.error(`[FAIL] 找不到课程大纲：${courseFile}`)
  process.exit(2)
}
const outline = coursePure.parseCourseMd(fs.readFileSync(courseFile, 'utf8'))
const wsName = path.basename(wsRel)
const workspacesFile = path.join(vaultAbs, '.knowbase/modules/aiTeaching/workspaces.json')
const workspaces = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'))
const ws = (workspaces.workspaces ?? []).find((w) => w.name === wsName)
if (!ws) {
  console.error(`[FAIL] workspaces.json 里找不到工作区：${wsName}`)
  process.exit(2)
}
const progress = JSON.parse(fs.readFileSync(path.join(vaultAbs, '.knowbase/modules/aiTeaching/progress.json'), 'utf8'))
const state = progress.workspaces?.[ws.id]
if (!state) {
  console.error(`[FAIL] progress.json 里找不到工作区状态：${ws.id}`)
  process.exit(2)
}

const chapterOfUnit = new Map()
for (const c of outline.chapters ?? []) for (const u of c.units ?? []) chapterOfUnit.set(u.id, c.id)
const lessons = Object.entries(state.lessons ?? {})
  .map(([sid, l]) => {
    const first = Array.isArray(l.unitIds) ? l.unitIds[0] : l.unitId
    return { sessionId: sid, order: Number(l.order), chapterId: chapterOfUnit.get(first) }
  })
  .filter((l) => l.chapterId)

const entries = []
const anchors = []
function walk(abs, rel, depth) {
  if (depth > 4) return
  const anchorAbs = path.join(abs, '.session.json')
  if (fs.existsSync(anchorAbs)) {
    try {
      const d = JSON.parse(fs.readFileSync(anchorAbs, 'utf8'))
      if (d.sessionId) anchors.push({ rel, sessionId: String(d.sessionId) })
    } catch { /* ignore */ }
  }
  let dirents = []
  try { dirents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
  for (const e of dirents) {
    const childRel = rel ? `${rel}/${e.name}` : e.name
    entries.push({ rel: childRel, name: e.name, isDir: e.isDirectory() })
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.') || e.name === 'SOURCES' || e.name === '教材' || e.name === 'node_modules' || e.name === '_extracts' || e.name === '_templates') continue
    walk(path.join(abs, e.name), childRel, depth + 1)
  }
}
walk(wsAbs, wsRel, 0)

const keepSessionIds = [
  state.assistantSessionId,
  ...Object.keys(state.lessons ?? {}),
  ...Object.values(state.reviews ?? {}).map((r) => r?.sessionId),
].filter((x) => typeof x === 'string' && !!x)

const plan = migration.planCourseLayoutMigration({ wsRel, outline, lessons, entries, anchors, keepSessionIds })
const max = 200
console.log(`[OK] 工作区：${wsRel}（${ws.id}）`)
console.log(`[OK] 课程：${outline.chapters.length} 章 / ${outline.chapters.reduce((n, c) => n + c.units.length, 0)} 知识点 / ${lessons.length} 段`)
console.log(`[OK] 计划移动：${plan.moves.length} 项；删除空目录：${plan.removeEmpty.length} 项；警告：${plan.warnings.length} 项`)
console.log('')
console.log('=== 移动计划 ===')
for (const m of plan.moves.slice(0, max)) {
  const flag = m.merge ? ' [merge]' : ''
  console.log(`${m.kind}${flag}  ${m.from}`)
  console.log(`      -> ${m.to || '(系统回收站)'}`)
}
if (plan.moves.length > max) console.log(`...（其余 ${plan.moves.length - max} 项省略）`)
console.log('')
console.log('=== 删除空目录 ===')
for (const rel of plan.removeEmpty) console.log(rel)
if (plan.warnings.length) {
  console.log('')
  console.log('=== 警告 ===')
  for (const w of plan.warnings) console.log(`[WARN] ${w}`)
}
console.log('')
console.log('[OK] 预览结束：未写盘。确认后打开工作区触发正式迁移。')

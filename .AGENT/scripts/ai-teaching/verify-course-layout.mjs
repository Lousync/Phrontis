/**
 * 契约验证：AI教学课程文件夹布局（v3.16.0）。
 *
 * 目标：把旧扁平 `{章号}·{知识点}` 自动整理成
 *   `第N章 章名/{NN} 知识点/段N` + `第N章 章名/章末复习/`
 *
 * 本脚本同时锁三件事：
 *  1. 纯函数命名 / 旧新路径 / 前缀改写；
 *  2. 主进程接线（getCourseState / openSegment / openChapterReview 自动迁移，
 *     复习写章末复习子目录，SOURCES 仍平铺兼容）；
 *  3. 成功静默（迁移路径不出现 showToast），失败不阻断课程状态。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-course-layout.mjs
 * 输出纯 ASCII（禁 emoji）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai316-layout-'))
async function load(rel, name) {
  const src = read(rel)
  const file = path.join(tmp, `${name}.mjs`)
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

const layout = await load('electron/lib/aiTeachingLayoutPure.ts', 'layoutPure')

console.log('\n=== A. 命名与路径 ===')
check('章目录 = 第1章 + 章名', layout.chapterFolderName(0, '微处理器与微机') === '第1章 微处理器与微机', layout.chapterFolderName(0, '微处理器与微机'))
check('章目录第10章不补零', layout.chapterFolderName(9, '内存') === '第10章 内存', layout.chapterFolderName(9, '内存'))
check('知识点目录 = 01 + 名称', layout.unitFolderName(0, '微处理器、微机与单片机') === '01 微处理器、微机与单片机', layout.unitFolderName(0, '微处理器、微机与单片机'))
check('知识点第10个补两位', layout.unitFolderName(9, 'IO') === '10 IO', layout.unitFolderName(9, 'IO'))
check('旧章目录 = 1·章名', layout.legacyChapterFolderName(0, '微处理器与微机') === '1·微处理器与微机', layout.legacyChapterFolderName(0, '微处理器与微机'))
check('旧知识点目录 = 1·知识点', layout.legacyUnitFolderName(0, 'IO') === '1·IO', layout.legacyUnitFolderName(0, 'IO'))
check('非法字符清洗 + 空白折叠', layout.folderSegment('  a/b:c*?  ') === 'a b c', layout.folderSegment('  a/b:c*?  '))
check('空名称回退未命名', layout.folderSegment('   ') === '未命名', layout.folderSegment('   '))
check('空章名不重复章号', layout.chapterFolderName(0, '') === '第1章 未命名', layout.chapterFolderName(0, ''))
check('名称截 40 字符', layout.folderSegment('x'.repeat(50)).length === 40, String(layout.folderSegment('x'.repeat(50)).length))

const outline = {
  title: '微机原理', goal: '', anchor: '',
  chapters: [
    {
      id: 'c1', name: '微处理器与微机',
      units: [
        { id: 'u1', name: '微处理器、微机与单片机', goal: '', source: '' },
        { id: 'u2', name: 'IO 接口的定义与四大功能', goal: '', source: '' },
      ],
    },
    { id: 'c2', name: '内存', units: [{ id: 'u3', name: '分页', goal: '', source: '' }] },
  ],
}
const plan = layout.buildCourseLayoutPlan(outline, 'AI教学/微机原理')
check('计划含 2 章 / 3 知识点', plan.chapters.length === 2 && plan.units.length === 3, `${plan.chapters.length}/${plan.units.length}`)
const u1 = plan.units.find((u) => u.unitId === 'u1')
const u3 = plan.units.find((u) => u.unitId === 'u3')
check('新知识点路径完整',
  u1.unitRel === 'AI教学/微机原理/第1章 微处理器与微机/01 微处理器、微机与单片机', u1.unitRel)
check('旧知识点路径保留',
  u1.legacyUnitRel === 'AI教学/微机原理/1·微处理器、微机与单片机', u1.legacyUnitRel)
check('第二章知识点路径',
  u3.unitRel === 'AI教学/微机原理/第2章 内存/01 分页', u3.unitRel)
check('章末复习路径 = 章/章末复习',
  plan.chapters[0].reviewRel === 'AI教学/微机原理/第1章 微处理器与微机/章末复习', plan.chapters[0].reviewRel)
check('旧复习路径 = 工作区/章号·章名',
  plan.chapters[0].legacyReviewRel === 'AI教学/微机原理/1·微处理器与微机', plan.chapters[0].legacyReviewRel)
check('SOURCES 旧夹名仍按章号·知识点',
  u1.legacySourceKey === '1·微处理器、微机与单片机', u1.legacySourceKey)
check('SOURCES 新夹名同口径（本期平铺）',
  u1.sourceKey === '1·微处理器、微机与单片机', u1.sourceKey)
check('新知识点目录反解平铺素材夹',
  JSON.stringify(layout.sourceKeyFromUnitRel('AI教学/微机原理/第1章 微处理器与微机/01 微处理器、微机与单片机'))
  === JSON.stringify({ wsRel: 'AI教学/微机原理', key: '1·微处理器、微机与单片机' }), '')
check('旧知识点目录反解平铺素材夹',
  JSON.stringify(layout.sourceKeyFromUnitRel('AI教学/微机原理/1·微处理器、微机与单片机'))
  === JSON.stringify({ wsRel: 'AI教学/微机原理', key: '1·微处理器、微机与单片机' }), '')
check('未知命名不误判', layout.sourceKeyFromUnitRel('AI教学/微机原理/自定义') === null, '')

console.log('\n=== B. 前缀改写（迁移元数据） ===')
check('完全相等改写', layout.rewriteRelPrefix('AI教学/x/1·A', 'AI教学/x/1·A', 'AI教学/x/第1章 A/01 A') === 'AI教学/x/第1章 A/01 A')
check('子路径改写',
  layout.rewriteRelPrefix('AI教学/x/1·A/段1/交接.md', 'AI教学/x/1·A', 'AI教学/x/第1章 A/01 A') === 'AI教学/x/第1章 A/01 A/段1/交接.md')
check('反斜杠归一',
  layout.rewriteRelPrefix('AI教学\\x\\1·A\\段1\\交接.md', 'AI教学/x/1·A', 'AI教学/x/第1章 A/01 A') === 'AI教学/x/第1章 A/01 A/段1/交接.md')
check('不匹配返回 null',
  layout.rewriteRelPrefix('AI教学/x/2·B/段1/交接.md', 'AI教学/x/1·A', 'AI教学/x/第1章 A/01 A') === null)
check('相似前缀不误伤',
  layout.rewriteRelPrefix('AI教学/x/1·AB/段1', 'AI教学/x/1·A', 'AI教学/x/第1章 A/01 A') === null)
check('空 from 返回 null', layout.rewriteRelPrefix('a/b', '', 'c') === null)

console.log('\n=== C. 主进程接线 ===')
const course = read('electron/lib/aiTeachingCourse.ts')
const sources = read('electron/lib/aiTeachingSources.ts')
const favorites = read('electron/lib/aiTeachingFavorites.ts')
const registry = read('electron/lib/aiTeachingSourceRegistry.ts')
const folders = read('electron/lib/aiTeachingFolders.ts')

check('getCourseState 打开工作区先自动整理',
  /export function getCourseState[\s\S]{0,260}ensureCourseLayout\(wsId, getSetting\)/.test(course))
check('openSegment 自动整理', /export function openSegment[\s\S]{0,900}ensureCourseLayout\(id, getSetting\)/.test(course))
check('openChapterReview 自动整理', /export function openChapterReview[\s\S]{0,900}ensureCourseLayout\(id, getSetting\)/.test(course))
check('unitFolderRel 使用章目录 + 知识点目录',
  /chapterFolderName\(chapterIndex, chapterName\)[\s\S]{0,160}unitFolderName\(unitIndex, unitName\)/.test(course))
check('lessonFolderRel 使用 unitFolderRel + reviewFolderRel',
  /const unitDirRel = unitFolderRel\(wsId, firstUnitId, getSetting\)/.test(course)
  && /if \(revChapter\) return reviewFolderRel\(wsId, revChapter, getSetting\)/.test(course))
check('复习讲义写章末复习夹',
  /writeChapterReviewDoc[\s\S]{0,500}reviewFolderRel\(hit\.wsId, hit\.chapterId, getSetting\)/.test(course)
  && /const dirRel = reviewFolderRel/.test(course))
check('迁移标记 layout.json', /const LAYOUT_KEY = 'layout\.json'/.test(course) && /LAYOUT_VERSION/.test(course))
check('迁移前备份 progress/favorites/sources', /backupLayoutMeta/.test(course) && /progress\.json/.test(course) && /favorites\.json/.test(course) && /sources\.json/.test(course))
check('迁移使用暂存区处理章调序',
  /\.aiTeach-layout-/.test(course) && /staged/.test(course) && /renameWorkspacePath\(vault\.rootId, s\.tempRel, s\.move\.to\)/.test(course))
check('迁移成功不弹 Toast（只 warn）',
  !/showToast\(/.test(course.slice(course.indexOf('function migrateCourseLayoutTo'), course.indexOf('export function setCourseEnabled'))))
check('旧扁平 unit 路径仍保留兼容',
  /legacyUnitFolderName\(chapterIndex, unitName\)/.test(course) && /existsSync\(join\(vault\.rootPath, legacy\)\)/.test(course))
check('会话反推只认段内第一个知识点（避免多知识点段串夹）',
  /lessonUnitIds\(l\)\[0\] !== unit\.unitId/.test(course)
  && /lessonUnitIds\(l\)\[0\] !== unitId/.test(course))
check('复习旧路径兼容',
  /legacyChapterFolderName\(idx, chapter\?\.name \?\? '复习'\)/.test(course))
check('SOURCES 本期仍平铺：sourceKeyFromUnitRel 反解旧夹名',
  /export function sourceKeyFromUnitRel/.test(read('electron/lib/aiTeachingLayoutPure.ts'))
  && /sourceKeyFromUnitRel\(dir\)/.test(sources))
check('素材夹名仍走 SOURCES/章号·知识点',
  /return `\$\{parsed\.wsRel\}\/SOURCES\/\$\{parsed\.key\}`/.test(sources))
check('收藏支持前缀改写',
  /export function rewriteFavoritePrefixes/.test(favorites) && /rewriteRelPrefix/.test(favorites))
check('sources.json 支持路径前缀改写',
  /export function rewriteSourcePathPrefixes/.test(registry) && /source\.extractRel/.test(registry))
check('文件夹扫描深度至少 4 层（章/知识点/段）',
  /if \(depth > 4\) return null/.test(folders))
check('AI教学资源管理器按数字自然序（第10章不跑到第1章前）',
  /localeCompare\(b\.name, 'zh-Hans-CN', \{ numeric: true \}\)/.test(read('src/modules/ai-teaching/AiTeachFileTree.tsx')))

console.log('\n=== D. 自动迁移的元数据范围 ===')
check('handoffRel 跟随知识点目录',
  /rewriteByPairs\(lesson\.handoffRel, unitPairs\)/.test(course))
check('summaryRel 跟随知识点目录',
  /rewriteByPairs\(unit\.summaryRel, unitPairs\)/.test(course))
check('复习 rel 跟随复习目录',
  /rewriteByPairs\(review\.rel, reviewPairs\)/.test(course))
check('收藏 / sources.json 跟随 unit/review/source 三类前缀',
  /const pathPairs = \[\.\.\.allPairs, \.\.\.sourcePairs\]/.test(course)
  && /rewriteFavoritePrefixes\(wsId, pathPairs\)/.test(course)
  && /rewriteSourcePathPrefixes\(wsId, pathPairs\)/.test(course))
check('迁移幂等修复：目录已落位、元数据仍旧路径时补前缀对',
  /function addPair|const addPair/.test(course) && /addPair\(unitPairs, prev\.legacyUnitRel, next\.unitRel\)/.test(course))

const fails = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ` —— ${c.detail}`}`)
console.log(fails.length ? `\n${fails.length} FAIL` : `\nALL PASS (${checks.length}/${checks.length})`)
process.exit(fails.length ? 1 : 0)

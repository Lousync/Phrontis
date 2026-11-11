/**
 * 契约验证：AI教学课程文件夹布局（chapter-segment-v1）。
 *
 * 目标布局：
 *   `第N章 章名/段N` + `第N章 章名/章末复习/`
 *   可选 `第N章 章名/知识点/{NN} 知识点/`
 *
 * 本脚本锁四件事：
 *  1. 纯函数命名 / 路径 / 旧章名 / SOURCES 反解；
 *  2. 迁移计划：章改名、段归位、错位段合并、单元级 PROFILE 回收、孤儿会话夹回收；
 *  3. 主进程接线（lessonFolderRel 用章+段、unitFolderRel 用知识点、archive target 限制、
 *     不再播种 CONSTRAINTS、段夹不随标题改名）；
 *  4. 画像 / 要求注入：知识点层可选、存在才注入。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-layout-v2-'))
function load(rel) {
  const src = read(rel)
  let out = stripTypeScriptTypes(src, { mode: 'strip' })
  // 相对 import 补 .mjs，并保持源文件 basename（migration → layoutPure 依赖）
  out = out.replace(/from '\.\/([^']+)'/g, "from './$1.mjs'")
  const file = path.join(tmp, `${path.basename(rel, '.ts')}.mjs`)
  fs.writeFileSync(file, out)
  return import(pathToFileURL(file).href)
}

const layout = await load('electron/lib/aiTeachingLayoutPure.ts')
const migration = await load('electron/lib/aiTeachingLayoutMigrationPure.ts')

console.log('\n=== A. 命名与路径 ===')
check('章目录 = 第1章 + 章名', layout.chapterFolderName(0, '微处理器与微机') === '第1章 微处理器与微机', layout.chapterFolderName(0, '微处理器与微机'))
check('章名自带第1章 → 目录仍是第2章', layout.chapterFolderName(1, '第1章 输入输出技术基础') === '第2章 输入输出技术基础', layout.chapterFolderName(1, '第1章 输入输出技术基础'))
check('章名自带第2章 → 目录仍是第3章', layout.chapterFolderName(2, '第2章 8255A 可编程并行接口') === '第3章 8255A 可编程并行接口', layout.chapterFolderName(2, '第2章 8255A 可编程并行接口'))
check('中文数字章名也剥', layout.chapterFolderName(0, '第一章 基础') === '第1章 基础', layout.chapterFolderName(0, '第一章 基础'))
check('第10章不补零', layout.chapterFolderName(9, '内存') === '第10章 内存', layout.chapterFolderName(9, '内存'))
check('空章名回退未命名', layout.chapterFolderName(0, '') === '第1章 未命名', layout.chapterFolderName(0, ''))
check('v3.16 旧章名保留双编号', layout.chapterFolderNameV316(1, '第1章 输入输出技术基础') === '第2章 第1章 输入输出技术基础', layout.chapterFolderNameV316(1, '第1章 输入输出技术基础'))
check('段目录只写段N', layout.segmentFolderName(3) === '段3', layout.segmentFolderName(3))
check('知识点元数据目录 = 01 + 名称', layout.unitFolderName(0, '微处理器、微机与单片机') === '01 微处理器、微机与单片机', layout.unitFolderName(0, '微处理器、微机与单片机'))
check('非法字符清洗 + 空白折叠', layout.folderSegment('  a/b:c*?  ') === 'a b c', layout.folderSegment('  a/b:c*?  '))
check('名称截 40 字符', layout.folderSegment('x'.repeat(50)).length === 40, String(layout.folderSegment('x'.repeat(50)).length))

const outline = {
  title: '微机原理', goal: '', anchor: '',
  chapters: [
    {
      id: 'c1', name: '第1章 输入输出技术基础',
      units: [
        { id: 'u1', name: 'I O 接口的定义与四大功能', goal: '', source: '' },
        { id: 'u2', name: 'IO 地址空间', goal: '', source: '' },
      ],
    },
    { id: 'c2', name: '第2章 8255A 可编程并行接口', units: [{ id: 'u3', name: '并行接口与可编程接口的概念', goal: '', source: '' }] },
  ],
}
const plan = layout.buildCourseLayoutPlan(outline, 'AI教学/微机原理')
check('计划含 2 章 / 3 知识点', plan.chapters.length === 2 && plan.units.length === 3, `${plan.chapters.length}/${plan.units.length}`)
const u1 = plan.units.find((u) => u.unitId === 'u1')
const u3 = plan.units.find((u) => u.unitId === 'u3')
check('新知识点路径 = 章/知识点/NN',
  u1.unitRel === 'AI教学/微机原理/第1章 输入输出技术基础/知识点/01 I O 接口的定义与四大功能', u1.unitRel)
check('v3.16 旧知识点路径保留双章号',
  u1.v316UnitRel === 'AI教学/微机原理/第1章 第1章 输入输出技术基础/01 I O 接口的定义与四大功能', u1.v316UnitRel)
check('第二章知识点路径',
  u3.unitRel === 'AI教学/微机原理/第2章 8255A 可编程并行接口/知识点/01 并行接口与可编程接口的概念', u3.unitRel)
check('章末复习路径 = 章/章末复习',
  plan.chapters[0].reviewRel === 'AI教学/微机原理/第1章 输入输出技术基础/章末复习', plan.chapters[0].reviewRel)
check('v3.16 复习路径保留旧章名',
  plan.chapters[0].v316ReviewRel === 'AI教学/微机原理/第1章 第1章 输入输出技术基础/章末复习', plan.chapters[0].v316ReviewRel)
check('SOURCES 夹名仍按章号·知识点',
  u1.sourceKey === '1·I O 接口的定义与四大功能', u1.sourceKey)
check('新知识点目录反解平铺素材夹',
  JSON.stringify(layout.sourceKeyFromUnitRel('AI教学/微机原理/第2章 输入输出技术基础/知识点/01 I O 接口的定义与四大功能'))
  === JSON.stringify({ wsRel: 'AI教学/微机原理', key: '2·I O 接口的定义与四大功能' }), '')
check('v3.16 知识点目录反解平铺素材夹',
  JSON.stringify(layout.sourceKeyFromUnitRel('AI教学/微机原理/第2章 第1章 输入输出技术基础/01 I O 接口的定义与四大功能'))
  === JSON.stringify({ wsRel: 'AI教学/微机原理', key: '2·I O 接口的定义与四大功能' }), '')
check('旧扁平知识点目录仍可反解',
  JSON.stringify(layout.sourceKeyFromUnitRel('AI教学/微机原理/1·微处理器、微机与单片机'))
  === JSON.stringify({ wsRel: 'AI教学/微机原理', key: '1·微处理器、微机与单片机' }), '')
check('未知命名不误判', layout.sourceKeyFromUnitRel('AI教学/微机原理/自定义') === null, '')

console.log('\n=== B. 迁移计划：章 / 段 / 错位合并 / 回收 ===')
const WS = 'AI教学/测试'
const outline2 = {
  title: '', goal: '', anchor: '',
  chapters: [
    {
      id: 'c0', name: '预备章 微机系统与 8086 基础（速过，不深挖）',
      units: Array.from({ length: 15 }, (_, i) => ({ id: `v${i + 1}`, name: `知识点${i + 1}`, goal: '', source: '' })),
    },
    {
      id: 'c1', name: '第1章 输入输出技术基础',
      units: Array.from({ length: 15 }, (_, i) => ({ id: `u${i + 1}`, name: `知识点${i + 1}`, goal: '', source: '' })),
    },
    { id: 'c2', name: '第2章 8255A 可编程并行接口', units: [{ id: 'w1', name: '并行接口与可编程接口的概念', goal: '', source: '' }] },
  ],
}
outline2.chapters[0].units[0].name = '微处理器、微机与单片机的组成'
outline2.chapters[0].units[5].name = '8086／8088 的内部结构与执行单元'
outline2.chapters[0].units[9].name = '8088 与 8086 的主要差别'
outline2.chapters[1].units[0].name = 'I O 接口的定义与四大功能'
outline2.chapters[1].units[4].name = 'IBM-PC 的 I O 地址空间与端口分配'
outline2.chapters[1].units[7].name = '地址译码：跳线开关可选式译码'
outline2.chapters[1].units[10].name = '无条件传送方式'
outline2.chapters[1].units[13].name = 'DMA 传送方式'

const entries = []
const anchors = []
const addDir = (rel) => entries.push({ rel: `${WS}/${rel}`, name: path.basename(rel), isDir: true })
const addFile = (rel) => entries.push({ rel: `${WS}/${rel}`, name: path.basename(rel), isDir: false })
const anchor = (rel, sessionId) => anchors.push({ rel: `${WS}/${rel}`, sessionId })

// c0：段2 错位到 01 下；段3 错位到章根；06/段2 与 10/段3 是真实段
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成/段1')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成/段1/.session.json')
anchor('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成/段1', 's1')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成/段2')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成/段2/教材·错位.md')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/PROFILE.md')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/段2')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/段2/.session.json')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/段2/交接.md')
anchor('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/段2', 's2')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/10 8088 与 8086 的主要差别')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/10 8088 与 8086 的主要差别/段3')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/10 8088 与 8086 的主要差别/段3/.session.json')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/10 8088 与 8086 的主要差别/段3/交接.md')
anchor('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/10 8088 与 8086 的主要差别/段3', 's3')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/段3')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/段3/教材·段3.md')
addDir('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/章末复习')
addFile('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/章末复习/.session.json')
anchor('第1章 预备章 微机系统与 8086 基础（速过，不深挖）/章末复习', 'review0')

// c1：旧章名双编号；段5 错位到章根；段3 错位到章根
addDir('第2章 第1章 输入输出技术基础')
addDir('第2章 第1章 输入输出技术基础/01 I O 接口的定义与四大功能')
addDir('第2章 第1章 输入输出技术基础/01 I O 接口的定义与四大功能/段1')
addFile('第2章 第1章 输入输出技术基础/01 I O 接口的定义与四大功能/段1/.session.json')
anchor('第2章 第1章 输入输出技术基础/01 I O 接口的定义与四大功能/段1', 't1')
addDir('第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配')
addFile('第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配/PROFILE.md')
addDir('第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配/段2')
addFile('第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配/段2/.session.json')
addFile('第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配/段2/交接.md')
anchor('第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配/段2', 't2')
addDir('第2章 第1章 输入输出技术基础/08 地址译码：跳线开关可选式译码')
addDir('第2章 第1章 输入输出技术基础/08 地址译码：跳线开关可选式译码/段3')
addFile('第2章 第1章 输入输出技术基础/08 地址译码：跳线开关可选式译码/段3/.session.json')
addFile('第2章 第1章 输入输出技术基础/08 地址译码：跳线开关可选式译码/段3/交接.md')
anchor('第2章 第1章 输入输出技术基础/08 地址译码：跳线开关可选式译码/段3', 't3')
addDir('第2章 第1章 输入输出技术基础/14 DMA 传送方式')
addDir('第2章 第1章 输入输出技术基础/14 DMA 传送方式/段5')
addFile('第2章 第1章 输入输出技术基础/14 DMA 传送方式/段5/.session.json')
addFile('第2章 第1章 输入输出技术基础/14 DMA 传送方式/段5/交接.md')
anchor('第2章 第1章 输入输出技术基础/14 DMA 传送方式/段5', 't5')
addDir('第2章 第1章 输入输出技术基础/段5')
addFile('第2章 第1章 输入输出技术基础/段5/练习·错位.md')
addDir('第2章 第1章 输入输出技术基础/章末复习')
addFile('第2章 第1章 输入输出技术基础/章末复习/.session.json')
anchor('第2章 第1章 输入输出技术基础/章末复习', 'review1')

// c2：单段
addDir('第3章 第2章 8255A 可编程并行接口')
addDir('第3章 第2章 8255A 可编程并行接口/01 并行接口与可编程接口的概念')
addDir('第3章 第2章 8255A 可编程并行接口/01 并行接口与可编程接口的概念/段1')
addFile('第3章 第2章 8255A 可编程并行接口/01 并行接口与可编程接口的概念/段1/.session.json')
anchor('第3章 第2章 8255A 可编程并行接口/01 并行接口与可编程接口的概念/段1', 'q1')

// 课程助手 + 孤儿旧段夹
addDir('课程助手')
addFile('课程助手/.session.json')
anchor('课程助手', 'assistant')
addDir('11-02 第2章 段3 · 旧会话')
addFile('11-02 第2章 段3 · 旧会话/.session.json')
anchor('11-02 第2章 段3 · 旧会话', 'orphan')

const lessons = [
  { sessionId: 's1', order: 1, chapterId: 'c0' },
  { sessionId: 's2', order: 2, chapterId: 'c0' },
  { sessionId: 's3', order: 3, chapterId: 'c0' },
  { sessionId: 't1', order: 1, chapterId: 'c1' },
  { sessionId: 't2', order: 2, chapterId: 'c1' },
  { sessionId: 't3', order: 3, chapterId: 'c1' },
  { sessionId: 't5', order: 5, chapterId: 'c1' },
  { sessionId: 'q1', order: 1, chapterId: 'c2' },
]
const p = migration.planCourseLayoutMigration({
  wsRel: WS, outline: outline2, lessons, entries, anchors,
  keepSessionIds: ['assistant', 'review0', 'review1'],
})
const hasMove = (kind, from, to) => p.moves.some((m) => m.kind === kind && m.from === `${WS}/${from}` && (to == null || m.to === `${WS}/${to}`))
const hasPair = (pairs, from, to) => pairs.some((x) => x.from === `${WS}/${from}` && x.to === `${WS}/${to}`)

check('章 2 旧双编号 → 第2章 输入输出技术基础', hasMove('chapter', '第2章 第1章 输入输出技术基础', '第2章 输入输出技术基础'), JSON.stringify(p.chapterPairs))
check('章 3 旧双编号 → 第3章 8255A', hasMove('chapter', '第3章 第2章 8255A 可编程并行接口', '第3章 8255A 可编程并行接口'), '')
check('段2 真实夹从 06 移到章根段2', hasMove('segment', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/段2', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/段2'), '')
check('段2 错位夹 01/段2 合并进段2', hasMove('segment', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/01 微处理器、微机与单片机的组成/段2/教材·错位.md', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/段2/教材·错位.md'), '')
check('段3 真实夹合并进已存在的章根段3', hasMove('segment', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/10 8088 与 8086 的主要差别/段3/交接.md', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/段3/交接.md'), '')
check('段5 真实夹合并进已存在的章根段5', hasMove('segment', '第2章 输入输出技术基础/14 DMA 传送方式/段5/交接.md', '第2章 输入输出技术基础/段5/交接.md'), '')
check('单元级 PROFILE 回收（c0/06）', hasMove('trash', '第1章 预备章 微机系统与 8086 基础（速过，不深挖）/06 8086／8088 的内部结构与执行单元/PROFILE.md', null), '')
check('单元级 PROFILE 回收（c1/05）', hasMove('trash', '第2章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配/PROFILE.md', null), '')
check('孤儿旧段夹回收', hasMove('trash', '11-02 第2章 段3 · 旧会话', null), '')
check('课程助手不回收', !hasMove('trash', '课程助手', null), '')
check('段 pair 同时覆盖旧章名', hasPair(p.segmentPairs, '第2章 第1章 输入输出技术基础/14 DMA 传送方式/段5', '第2章 输入输出技术基础/段5'), JSON.stringify(p.segmentPairs.filter((x) => x.to.endsWith('/段5'))))
check('单元 pair 同时覆盖旧章名', hasPair(p.unitPairs, '第2章 第1章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配', '第2章 输入输出技术基础/知识点/05 IBM-PC 的 I O 地址空间与端口分配'), '')
check('removeEmpty 包含旧单元夹', p.removeEmpty.includes(`${WS}/第2章 输入输出技术基础/05 IBM-PC 的 I O 地址空间与端口分配`), JSON.stringify(p.removeEmpty))
check('removeEmpty 不含工作区根', !p.removeEmpty.includes(WS), JSON.stringify(p.removeEmpty))
check('无未完成警告', p.warnings.length === 0, JSON.stringify(p.warnings))

console.log('\n=== C. 主进程接线 ===')
const course = read('electron/lib/aiTeachingCourse.ts')
const folders = read('electron/lib/aiTeachingFolders.ts')
const profile = read('electron/lib/aiTeachingProfile.ts')
const scope = read('electron/lib/aiTeachingScope.ts')
const sources = read('electron/lib/aiTeachingSources.ts')
const tools = read('electron/lib/builtinTools.ts')
const help = read('resources/help/AI 教学 · 课程模式.md')

check('getCourseState 打开工作区先整理', /export function getCourseState[\s\S]{0,260}ensureCourseLayout\(wsId, getSetting\)/.test(course))
check('openSegment 先整理', /export function openSegment[\s\S]{0,900}ensureCourseLayout\(id, getSetting\)/.test(course))
check('openChapterReview 先整理', /export function openChapterReview[\s\S]{0,900}ensureCourseLayout\(id, getSetting\)/.test(course))
check('lessonFolderRel 用章目录 + 段N', /chapterFolderName\(hit\.index, hit\.chapter\.name\)[\s\S]{0,120}segmentFolderName\(l\.order\)/.test(course))
check('lessonFolderRel 不再用 unitFolderRel 当段父目录', !/const unitDirRel = unitFolderRel[\s\S]{0,120}return `\$\{unitDirRel\}\/段/.test(course))
check('unitFolderRel 用 知识点/ 元数据夹', /UNIT_META_FOLDER_NAME\}\/\$\{unitFolderName\(unitIndex, unitName\)\}/.test(course))
check('reviewFolderRel 回退 v3.16 旧章名', /chapterFolderNameV316\(idx, name\)[\s\S]{0,80}REVIEW_FOLDER_NAME/.test(course))
check('迁移标记 layout.json + 新版本', /const LAYOUT_KEY = 'layout\.json'/.test(course) && /LAYOUT_VERSION/.test(course))
check('迁移前备份 progress/favorites/sources', /backupLayoutMeta/.test(course) && /progress\.json/.test(course) && /favorites\.json/.test(course) && /sources\.json/.test(course))
check('迁移计划走纯函数', /planCourseLayoutMigration\(/.test(course) && /collectLayoutSnapshot\(/.test(course))
check('段会话 archive target 限制', /inOwner && !isCourseAssistantSession\(sid, getSetting\)/.test(course) && /本段产物只能写入本段目录/.test(course))
check('archive 工具描述说明段会话不要 target', /段会话不要填 target/.test(tools) && /课程助手才可以用 target/.test(tools))
check('段会话 archive 拒绝时指向 vault.write（教材 / 知识库正文）', /教材 \/ 知识库正文请用 vault\.write/.test(course))
check('archive 拒绝 SOURCES 目录（硬边界）', /toUpperCase\(\) === 'SOURCES'/.test(course))
check('archive 拒绝 课程.md 标题', /titleBase === '课程'/.test(course))

check('建夹不再播种 CONSTRAINTS 模板', !/seedConstraintsFromTemplate/.test(folders) && !/CONSTRAINTS_TEMPLATE_REL_SEGMENTS/.test(folders))
check('会话扫描跳过 知识点 元数据夹', /e\.name === '知识点'/.test(folders))
check('段夹不随会话标题改名', /\^段\\d\+\$/.test(folders) || /\/\^段\\d\+\$\/\.test\(oldName\)/.test(folders))
check('章末复习 / 课程助手 等结构夹不改名', folders.includes("oldName === '章末复习'") && folders.includes("oldName === '课程助手'"))
check('画像本主题落会话夹，不再用知识点路径', !/getSessionUnitFolderRel\s*\(/.test(profile) && /getSessionUnitFolderRels/.test(profile))
check('画像注入含可选知识点层', /readUnitProfilesForSession/.test(profile) && /知识点画像（可选/.test(profile))
check('要求注入读全部知识点', /getSessionUnitFolderRels/.test(scope) && /for \(const u of getSessionUnitFolderRels/.test(scope))
check('知识点要求路径走新 unitFolderRel', /unitConstraintsRel\(unitFolderRel\(wsId, unitId, getSetting\)\)/.test(scope))
check('SOURCES 反解走 sourceKeyFromUnitRel', /sourceKeyFromUnitRel\(dir\)/.test(sources))
check('帮助文档说明知识点层可选不自动创建', help.includes('不会自动创建') && help.includes('知识点/{NN} 知识点'))
check('帮助文档说明文件树 章 → 段', help.includes('课程文件树按 **章 → 段** 组织'))
check('资源管理器数字自然序仍在', /localeCompare\(b\.name, 'zh-Hans-CN', \{ numeric: true \}\)/.test(read('src/modules/ai-teaching/AiTeachFileTree.tsx')))

const fails = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ` —— ${c.detail}`}`)
console.log(fails.length ? `\n${fails.length} FAIL` : `\nALL PASS (${checks.length}/${checks.length})`)
process.exit(fails.length ? 1 : 0)

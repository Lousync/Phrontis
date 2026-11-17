#!/usr/bin/env node
/**
 * 对话驱动建课 Phase 2 契约：教学助手工具接线。
 * 静态断言为主（aiTeachingCourse 依赖 electron，无法在纯 Node 直接跑）。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const course = read('electron/lib/aiTeachingCourse.ts')
const tools = read('electron/lib/builtinTools.ts')
const agent = read('electron/lib/agentService.ts')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[业务函数] aiTeachingCourse.ts')
check('导出 inventoryWorkspaceSource', course.includes('export function inventoryWorkspaceSource'))
check('导出 writeOutlineFromAssistant', course.includes('export function writeOutlineFromAssistant'))
check('导出 removeCourseUnit', course.includes('export function removeCourseUnit'))
check('导出 archiveOrganizedPage', course.includes('export function archiveOrganizedPage'))
check('清点仅支持 dir 素材（单个 pdf/pptx 提示先转写）', course.includes("e.type !== 'dir'") && course.includes('先提取为 md'))
check('大纲写入支持 append 增补', course.includes("mode: 'append'") && course.includes('applyOutlineAdditions'))
check('删除已学知识点 → needOrganize 拒绝', course.includes("status !== 'todo'") && course.includes('needOrganize: true'))
check('归档返回绝对路径 absPath', course.includes('absPath: join(dirAbs, fname)'))
check('归档默认落会话 write-owner（助手 output/）', /resolveWriteOwnerRel\(sid, getSetting\)/.test(course) && course.includes('本段产物只能写入本段目录'))
check('归档拒绝写入隐藏/点目录', course.includes("s.startsWith('.')"))
check('归档标题命中交接 → 硬闸拒绝', course.includes('isHandoffTitle(title)') && course.includes('交接由「收尾本段」统一生成'))
check('归档工具描述禁止创建交接', tools.includes('不要用它创建交接文档'))

console.log('\n[工具注册] builtinTools.ts')
check('注册 inventory', tools.includes("name: 'inventory'"))
check('注册 course.outline.write', tools.includes("name: 'course.outline.write'"))
check('注册 course.outline.remove-unit', tools.includes("name: 'course.outline.remove-unit'"))
check('注册 course.organize.archive', tools.includes("name: 'course.organize.archive'"))
check('注册 course.constraints.write', tools.includes("name: 'course.constraints.write'"))
check('course.constraints.write requires:write + tier:ondemand', /name: 'course\.constraints\.write'[\s\S]{0,1500}requires: 'write', tier: 'ondemand'/.test(tools))
check('course.constraints.write 走业务函数 + 仅教学面', tools.includes('writeConstraintsForAiTeaching(sid') && tools.includes("ctx?.source !== 'aiTeaching'"))
const constraintSchemaChars = (() => {
  const at = tools.indexOf("name: 'course.constraints.write'")
  const schemaAt = tools.indexOf('inputSchema:', at)
  const start = tools.indexOf('{', schemaAt)
  let depth = 0
  for (let i = start; i < tools.length; i++) {
    if (tools[i] === '{') depth++
    else if (tools[i] === '}') { depth--; if (depth === 0) return tools.slice(start, i + 1).split(/\r?\n/).map((l) => l.trim()).join('').length }
  }
  return 0
})()
check('course.constraints.write schema ≤ 800 字符', constraintSchemaChars > 0 && constraintSchemaChars <= 800, String(constraintSchemaChars))
check('四工具 requires:write + tier:ondemand', (tools.match(/requires: 'write', tier: 'ondemand'/g) || []).length >= 4)
check('工作区解析走 getWorkspaceOfSession', tools.includes('requireAiTeachWs') && tools.includes('getWorkspaceOfSession(sid)'))
// v3.31.0 P0-D：申请清单硬编码退役，按需工具统一走 builtin.tool.list 查询
check('按需教学工具经 builtin.tool.list 可查', tools.includes("name: 'builtin.tool.list'") && tools.includes("t.tier === 'ondemand'"))
check('course.constraints.write / read 注册为 ondemand', /name: 'course\.constraints\.write'[\s\S]{0,2000}?tier: 'ondemand'/.test(tools) && /name: 'course\.constraints\.read'[\s\S]{0,2000}?tier: 'ondemand'/.test(tools))
check('agentService 注入要求文档协议', agent.includes('【要求文档（AI教学）】') && agent.includes('course.constraints.write'))
check('agentService 产物落点纪律声明用户要求优先', agent.includes('用户要求指定了落点时，以用户要求为准'))
check('agentService 产物落点纪律含系统硬边界', agent.includes('系统硬边界（任何用户要求都不能覆盖）'))
check('agentService 要求文档提示含全文读取工具', agent.includes('course.constraints.read'))
check('course 助手提示含要求工具', course.includes('course.constraints.write'))
check('course 助手提示含教材 vault.write + ensureId', course.includes('vault.write') && course.includes('ensureId:true'))
check('vault.write / vault.edit 拦 CONSTRAINTS.md', (tools.match(/要求文档请用 course\.constraints\.write/g) || []).length >= 2)
check('归档工具拦 CONSTRAINTS 标题', course.includes('要求文档请用 course.constraints.write 写入，不要用整理归档创建 CONSTRAINTS.md'))
check('归档工具拦 课程.md 标题', course.includes('课程大纲请用 course.outline.write 写入'))
check('归档拒绝 SOURCES 目录（用户要求也不能覆盖）', course.includes("s.toUpperCase() === 'SOURCES'"))
check('分段归档拒绝时指向 vault.write', course.includes('教材 / 知识库正文请用 vault.write'))

console.log('\n[输出落点优先级 / 要求全文读取] aiTeachingScope + builtinTools')
check('导出 readConstraintsForAiTeaching', read('electron/lib/aiTeachingScope.ts').includes('export function readConstraintsForAiTeaching'))
check('注册 course.constraints.read', tools.includes("name: 'course.constraints.read'"))
check('course.constraints.read readOnly:read + tier:ondemand', /name: 'course\.constraints\.read'[\s\S]{0,900}readOnly: true[\s\S]{0,100}requires: 'read'[\s\S]{0,100}tier: 'ondemand'/.test(tools))
check('course.constraints.read 走业务函数 + 仅教学面', tools.includes('readConstraintsForAiTeaching(sid') && tools.includes("ctx?.source !== 'aiTeaching'"))
check('course.constraints.read 可按需申请（tool.list 覆盖 ondemand）', tools.includes("t.tier === 'ondemand'") && tools.includes("name: 'builtin.tool.list'"))
check('vault.write schema 含 ensureId', tools.includes('ensureId: { type: \'boolean\''))
check('vault.write 落盘调用 ensureKnowledgeDocFrontmatter', tools.includes('ensureKnowledgeDocFrontmatter'))
check('vault.write 回传稳定 id', tools.includes('readFrontmatterId(content)'))
check('vault.write / vault.edit 硬边界拦 SOURCES', tools.includes("s.toUpperCase() === 'SOURCES'"))
check('vault.write / vault.edit 硬边界拦交接 / 课程', tools.includes('交接文档只由「收尾本段」生成') && tools.includes('课程大纲请用 course.outline.write'))
check('显式多段路径不再被归一化改写', /if \(segs\.length > 1\) return rel/.test(tools))
const drawer = read('src/modules/ai-teaching/RequirementsDrawer.tsx')
check('要求抽屉超限给一行内联轻提示', drawer.includes('exceedsConstraintInjectLimit(text)') && drawer.includes('超出注入上限') && drawer.includes('truncate'))

console.log('\n[权限放行] 课程助手注入')
check('不再有「只读约束」', !course.includes('【只读约束】'))
check('注入说明含建课工具指引', course.includes('course.outline.write') && course.includes('course.organize.archive') && course.includes('inventory'))

// ---- 阶段二：对话内生图在 AI 教学面的接线（v3.6.0，docs/ai-image-gen-plan.md §6）----
// 这一段全是**接线**断言（静态源码）：产物落会话夹 outputs/、工件栏图片页签、文件树看图。
// 单点细节（工具 schema / 适配器端点 / 尺寸解析）在 ai-tools-audit/verify-image-tool.mjs 里，
// 这里只锁「教学面这条链子是不是真的接上了」—— 断了的表象都是"点了没反应"。
const sources = read('electron/lib/aiTeachingSources.ts')
const artifacts = read('src/modules/ai-teaching/artifacts.ts')
const pane = read('src/modules/ai-teaching/ArtifactsPane.tsx')
const tree = read('src/modules/ai-teaching/AiTeachFileTree.tsx')
const teachIdx = read('src/modules/ai-teaching/index.tsx')
const imgFmt = read('src/lib/imageFormats.ts')

console.log('\n[阶段二 · 落盘] aiTeachingSources.writeImage')
check('导出 writeImage', sources.includes('export function writeImage'))
check('落 {会话夹}/outputs/', sources.includes("join(vault.rootPath, sessionRel, 'outputs')"))
check('版本式去重（-v2，不覆盖）', /uniqueVersionedName\(dirAbs, `\$\{s\}\.png`\)/.test(sources))
check('归属校验走 ensureWriteOwnerFolder', /export function writeImage[\s\S]{0,1200}ensureWriteOwnerFolder\(sessionId, getSetting\)/.test(sources))
check('字节上限 30MB 且拒绝空数据', /MAX_IMAGE_OUTPUT_BYTES = 30 \* 1024 \* 1024/.test(sources) && sources.includes('图片数据为空'))

console.log('\n[阶段二 · 分流] builtinTools 的 image 处理')
check("按 ctx.source === 'aiTeaching' 分流（不按 sessionId 空值判）",
  tools.includes("ctx?.source === 'aiTeaching'") && tools.includes('writeImage(sid, str(args.slug), buf'))
check('教学面无会话归属 -> 直接拒绝', tools.includes('image 在 AI 教学面需要会话归属'))
check('普通对话面仍落 .attachments/', tools.includes('stageImageVersioned(root, str(args.slug), buf)'))

console.log('\n[阶段二 · 工件栏] ArtTab / ArtifactsPane')
check("ArtTab.kind 含 'image'", /kind: 'md' \| 'html' \| 'pptx' \| 'mindmap' \| 'image'/.test(artifacts))
check('ArtTab 带 w/h/bytes 元信息字段', artifacts.includes('w?: number') && artifacts.includes('h?: number') && artifacts.includes('bytes?: number'))
check('ArtifactsPane 渲染图片页签', pane.includes("tab.kind === 'image'") && pane.includes('<ImmersiveImageView'))
check('图片页签复用批 3 查看器（不另造一份）', pane.includes("components/shared/image/ImmersiveImageView"))
check('生成中占位有 image 文案与落点说明', pane.includes('image 正在生成图片…') && pane.includes('产出将写入会话 outputs/ 目录'))
check('图片页签不给「编辑」也不给 ⟳', (pane.match(/tab\.kind !== 'image'/g) || []).length >= 2)

console.log('\n[阶段二 · 文件树] AiTeachFileTree 图片接查看器')
check('新增 onOpenImage 回调', tree.includes('onOpenImage?: (rel: string) => void'))
check('图片扩展名判定复用 imageFormats（不手抄名单）',
  imgFmt.includes('export function isRenderableImagePath') && tree.includes('isRenderableImagePath') && !tree.includes('IMAGE_RENDER_EXTS'))
check('点击/右键图片走工件栏页签', tree.includes('onOpenImage(n.relPath)') && tree.includes("label: '查看图片'"))

console.log('\n[阶段二 · 会话接线] ai-teaching/index.tsx')
check('占位页签与完成事件同一条 slug 回落规则',
  (teachIdx.match(/\|\| 'image'/g) || []).length >= 2)
check('artifact kind=image -> 图片页签（不再是直接 return）',
  teachIdx.includes("a.kind === 'image'") && teachIdx.includes("kind: 'image', rel: a.rel"))
check('openArtFile 认图片扩展名（排在文本兜底之前）',
  /isRenderableImagePath\(rel\)[\s\S]{0,300}kind: 'image'/.test(teachIdx))
check('文件树 onOpenImage 已接上', teachIdx.includes('onOpenImage={treeOpenArt}'))
check('「本次改动」里图片 / 示意图 / 导图进工件栏（不发 kb-open-note）',
  teachIdx.includes('const changeOpensInArtifactPane')
  && teachIdx.includes("tool === 'visual.html' || tool === 'image'")
  && teachIdx.includes("tool === 'artifact.edit' && /\\.(?:html?|json)$/i"))
check('图片页签不进「按文本回读」那份清单', teachIdx.includes("t.kind !== 'image' && (rel ? t.rel === rel : t.kind === 'md')"))
check('切回会话能恢复图片页签（docRel 纳入 image）', teachIdx.includes("t.kind === 'image') ? t.rel : null"))

// ---- 2026-11-17：产物原地修改（改图不再生成 v2）----
// 断的是「链子有没有接上」：落盘覆盖 / relPath / artifact.edit / 同路径页签刷新。
console.log('\n[原地修改 · 落盘] aiTeachingSources')
const pure = read('electron/lib/aiTeachingArtifactPure.ts')
check('writeVisual 无 -v2 循环（同名覆盖）', /export function writeVisual[\s\S]{0,2200}return \{ ok: true, relPath: `\$\{sessionRel\}\/visuals\/\$\{fname\}`, lines, updated \}/.test(sources)
  && !sources.includes('`${s}-v${v}.html`'))
check('writeMindmap 无 -v2 循环（同名覆盖）', !sources.includes('`${s}-v${v}.json`'))
check('writeVisual 支持 relPath 原地改', /resolveProductFileRel\(sessionRel, explicit, 'visuals', \['html'\]\)/.test(sources))
check('writeMindmap 支持 relPath 原地改', /resolveProductFileRel\(sessionRel, explicit, 'mindmaps', \['json'\]\)/.test(sources))
check('writeImage 支持显式 relPath 覆盖', /resolveProductFileRel\(sessionRel, explicit, 'outputs', \['png', 'jpg', 'jpeg', 'webp'\]\)/.test(sources))
check('writeImage 默认仍版本递增（生图卡版本切换不破）', sources.includes('uniqueVersionedName(dirAbs, `${s}.png`)'))
check('artifact.edit 走纯函数补丁（全有或全无）',
  sources.includes('applyArtifactEdits(text, edits, append)') && pure.includes('全部校验通过才返回新文本'))
check('导图 JSON 改后仍合法才落盘', sources.includes('!parseMindmap(next)') && sources.includes('不支持末尾追加'))

console.log('\n[原地修改 · 边界] aiTeachingArtifactPure')
check('拒绝绝对路径 / ..', pure.includes("不能是绝对路径") && pure.includes("不能包含 . / .."))
check('拒绝点目录 / SOURCES', pure.includes("隐藏目录 / 点文件") && pure.includes("'SOURCES'"))
check('产物目录只认直接文件', pure.includes('只认直接文件，不支持子目录'))
check('扩展名白名单', pure.includes("ARTIFACT_EDIT_EXTS = ['html', 'json', 'md']"))

console.log('\n[原地修改 · 工具与刷新]')
check('注册 artifact.edit（tier ondemand）', /name: 'artifact\.edit'[\s\S]{0,2400}tier: 'ondemand'/.test(tools))
check('artifact.edit 仅 AI 教学会话可用', tools.includes('artifact.edit 仅可在 AI 教学对话中使用'))
check('artifact.edit 串行（不与只读工具并行）', read('electron/lib/agentLoopPolicy.ts').includes("realName !== 'artifact.edit'"))
check('trace 透传 updated', agent.includes('updated: d.updated === true'))
check('artifact.edit 也产出 artifact 事件', agent.includes("realName === 'artifact.edit'") && agent.includes("kind: ext === 'md' ? 'md'"))
check('本会话最近产物索引（改哪一张不必猜路径）', agent.includes('本会话最近的产物') && agent.includes('recentArtifactsHint'))
check('同路径页签原地刷新（不新开）', teachIdx.includes('const exists = artTabsRef.current.some')
  && teachIdx.includes('setHtmlSeq(prev => ({ ...prev, [a.rel]'))
check('监听外部写刷新打开中的工件', teachIdx.includes('onWsExternalChange') && teachIdx.includes('artTabsRef.current.find(t => !t.generating && t.rel === rel)'))
check('讲义同名覆盖且保留 frontmatter id', course.includes('hasQuizFence(text)') && course.includes('forceFrontmatterId(body, prevId)'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)

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
check('归档默认落会话 write-owner（助手 output/）', course.includes('resolveWriteOwnerRel(String(sessionId'))
check('归档拒绝写入隐藏/点目录', course.includes("s.startsWith('.')"))

console.log('\n[工具注册] builtinTools.ts')
check('注册 inventory', tools.includes("name: 'inventory'"))
check('注册 course.outline.write', tools.includes("name: 'course.outline.write'"))
check('注册 course.outline.remove-unit', tools.includes("name: 'course.outline.remove-unit'"))
check('注册 course.organize.archive', tools.includes("name: 'course.organize.archive'"))
check('四工具 requires:write + tier:ondemand', (tools.match(/requires: 'write', tier: 'ondemand'/g) || []).length >= 4)
check('工作区解析走 getWorkspaceOfSession', tools.includes('requireAiTeachWs') && tools.includes('getWorkspaceOfSession(sid)'))
check('builtin.tool.request 清单含新工具', tools.includes('course.outline.write / course.outline.remove-unit / course.sources.register / course.sources.assign / course.sources.extract / course.organize.archive'))

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
check('「本次改动」里图片进工件栏（不发 kb-open-note）',
  teachIdx.includes("c.tool === 'visual.html' || c.tool === 'image'"))
check('图片页签不进「按文本回读」那份清单', teachIdx.includes("t.kind !== 'image' && (rel ? t.rel === rel : t.kind === 'md')"))
check('切回会话能恢复图片页签（docRel 纳入 image）', teachIdx.includes("t.kind === 'image') ? t.rel : null"))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)

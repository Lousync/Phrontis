/**
 * 契约：对话内生图 / 改图（v3.6.0，docs/ai-image-gen-plan.md §9）。
 *
 * 断言分三层：
 *  ① **源码静态断言** —— 工具注册面 / 适配器端点 / 命名口径 / artifact 扩类 / 水印归属；
 *  ② **真跑纯函数** —— `imageHeaderPure.imageSizeOf` 喂构造出来的 PNG/JPEG 头（不是文本断言，
 *     真的 import 进来跑），尺寸解析是"落盘后卡上元信息/工件栏尺寸"的唯一来源，坏了不会报错只会显示错；
 *  ③ **负向断言** —— 仓库相对链接的前导 `../` 只允许在**一处**处理（`attachmentImage.normalizeVaultRel`），
 *     防止有人再手搓一份路径计算（方案 §9 明确要求锁这条：算错的表现是"仓库里图明明在、页面里是破图"）。
 *
 * ASCII 输出（AGENTS.md：脚本一律不用 emoji）。
 * 用法：node .AGENT/scripts/ai-tools-audit/verify-image-tool.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageSizeOf, exceedsPixelGuard } from '../../../electron/lib/imageHeaderPure.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS  ${label}`)
  else { console.log(`FAIL  ${label}${extra ? ' --- ' + extra : ''}`); fails.push(label) }
}

/** 递归收集源码文件（给定扩展名），跳过 node_modules / 产物目录 */
function walk(dir, exts, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

// ---- 抽工具块（与 verify-graph-topology-tool.mjs 同一量法）----
const toolsSrc = read('electron/lib/builtinTools.ts')
const toolsLines = toolsSrc.split(/\r?\n/)
const starts = []
toolsLines.forEach((l, i) => { if (/^\s{2}registerTool\(\{/.test(l)) starts.push(i) })
const blockOf = (name) => {
  const nameLine = toolsLines.findIndex((l) => l.includes(`name: '${name}'`))
  if (nameLine < 0) return null
  let start = -1
  for (const s of starts) { if (s < nameLine) start = s }
  if (start < 0) return null
  let end = toolsLines.length - 1
  for (let i = start + 1; i < toolsLines.length; i++) {
    if (/^ {2}\}\);?\s*$/.test(toolsLines[i])) { end = i; break }
  }
  return toolsLines.slice(start, end + 1).join('\n')
}

console.log('[1 工具 image]')
const block = blockOf('image')
ok(block !== null, '1.1 工具 image 已注册（electron/lib/builtinTools.ts）')
if (block) {
  ok(/requires:\s*'write'/.test(block), "1.2 requires: 'write'（写盘 + 花钱，权限面刻意与 visual.html 同口径）")
  ok(/tier:\s*'ondemand'/.test(block), "1.3 tier: 'ondemand'（铁律 16：默认折叠，零常驻 token）")
  ok(/readOnly:\s*false/.test(block), '1.4 readOnly: false')
  // schema 字符数：从 inputSchema 起按大括号配平、去换行缩进与注释行（量法同 measure-tool-schema.mjs）
  const at = block.indexOf('inputSchema:')
  const s0 = block.indexOf('{', at)
  let depth = 0, schema = ''
  for (let i = s0; i < block.length; i++) {
    if (block[i] === '{') depth++
    else if (block[i] === '}') { depth--; if (depth === 0) { schema = block.slice(s0, i + 1); break } }
  }
  const chars = schema.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).join('').length
  ok(chars > 0 && chars <= 800, `1.5 inputSchema ${chars} 字符 <= 800（铁律 16 红线）`)
  // A4 = 只出 1 张；插图是第二次写入（§3.3）—— 两个花钱/走偏的旋钮都不许有
  ok(!/count:/.test(schema), '1.6 schema 不提供 count（A4 = 1 张）')
  ok(!/insert:/.test(schema), '1.7 schema 不提供 insert（插图是第二次写入，见方案 §3.3）')
  ok(/ref:\s*\{/.test(schema) && /aspect:\s*\{/.test(schema) && /prompt:\s*\{/.test(schema),
    '1.8 schema 含 prompt / aspect / ref 三参数（A2/A3/A4/D7）')
  ok(/downgraded/.test(block), '1.9 改图槽留空 -> 结果里标 downgraded（不静默降级）')
}

// 不在 core 常驻清单：core = 未标 tier 或显式 core。这里断言 image 不可能是 core
ok(!block || !/tier:\s*'core'/.test(block), '1.10 image 不在 core 常驻清单里')
// 铁律 18：新写工具必须同步补 builtin.tool.request 的 description 清单
const reqAt = toolsSrc.indexOf("name: 'builtin.tool.request'")
ok(reqAt > 0 && /\/ image \//.test(toolsSrc.slice(reqAt, reqAt + 1400)),
  '1.11 builtin.tool.request 的 description 清单已补 image（铁律 18）')

console.log('\n[2 生图适配器（llmService）]')
const llm = read('electron/lib/llmService.ts')
// 端点断言按**请求 URL 的构造**数（模板串），不按裸字符串数 —— 错误文案与注释里也会提到这两个路径，
// 那是给人看的说明，不是第二处调用点
const genHits = (llm.match(/\$\{provider\.baseUrl\}\/images\/generations/g) ?? []).length
const editHits = (llm.match(/\$\{provider\.baseUrl\}\/images\/edits/g) ?? []).length
ok(genHits === 1, `2.1 请求 URL \${baseUrl}/images/generations 恰构造 1 次（实数 ${genHits}）`)
ok(editHits === 1, `2.2 请求 URL \${baseUrl}/images/edits 恰构造 1 次（实数 ${editHits}）`)
ok(/export async function imageGenerate\(/.test(llm), '2.3 导出 imageGenerate')
ok(/export async function imageEdit\(/.test(llm), '2.4 导出 imageEdit')
ok(/b64_json/.test(llm) && /\burl\b/.test(llm) && /imagePayloadOf/.test(llm),
  '2.5 响应兼容 b64_json 与 url 两形状（方案 §4.1 / §11 风险 1）')
ok(/AbortSignal\.any/.test(llm) && /signal\?\: AbortSignal/.test(llm),
  '2.6 请求挂 AbortSignal（A6 停止 = 主进程真 abort，不落盘）')
ok(/未配置\$\{label\}|未配置/.test(llm) && /resolveImageSlot/.test(llm),
  '2.7 两个模型槽留空 -> 报「未配置」，不做自动挑选（方案 §7）')
ok(/friendlyImageError/.test(llm) && /401/.test(llm) && /429/.test(llm) && /policy\|safety\|moderation/.test(llm),
  '2.8 错误面分档：401/403 权限、429 额度、400+policy 内容策略（A8 一行字）')
ok(/IMAGE_SIZE_MAP/.test(llm), '2.9 画幅映射表落成常量（方案 §4.1「映射表放一个常量」）')
// 不新增 ProviderType（方案 §4.1 首要约束）
ok(!/type ProviderType =/.test(llm) && !/ProviderType\s*=\s*'/.test(llm),
  '2.10 未新增 ProviderType（复用现有供应商，只打不同端点）')

console.log('\n[3 命名口径]')
const ws = read('electron/lib/workspaceManager.ts')
ok(/export function uniqueVersionedName/.test(ws), '3.1 抽出 uniqueVersionedName（方案 §4.3）')
ok(/export function stageImageVersioned/.test(ws), '3.2 生图产物有独立落盘入口 stageImageVersioned')
ok(/\$\{stem\}-v\$\{v\}\$\{ext\}/.test(ws), '3.3 去重是版本式 -v2/-v3（不是时间戳式）')
ok(!/stageImageVersioned[\s\S]{0,600}Date\.now\(\)/.test(ws.slice(ws.indexOf('export function stageImageVersioned'))),
  '3.4 stageImageVersioned 内不出现时间戳去重（版本式口径不被时间戳顶掉）')
ok(/\.attachments/.test(ws) && /ATTACHMENTS_DIR/.test(ws), '3.5 阶段一落 .attachments/<年-月>/（B2）')

console.log('\n[4 trace.artifact 扩类（两处镜像）]')
const svc = read('electron/lib/agentService.ts')
const types = read('src/types/index.ts')
for (const [label, src] of [['agentService', svc], ['src/types', types]]) {
  ok(/kind\?:\s*'html'\s*\|\s*'mindmap'\s*\|\s*'image'/.test(src), `4.x ${label} 的 artifact.kind 含 'image'`)
  ok(/w\?: number[\s\S]{0,200}h\?: number[\s\S]{0,200}bytes\?: number/.test(src),
    `4.x ${label} 的 artifact 含 w/h/bytes`)
}
ok(/realName === 'image'/.test(svc) && /kind: 'image'/.test(svc),
  "4.1 agentService 的 artifact 组装分支含 kind: 'image'")
ok(/'image': '生成图片'/.test(svc), '4.2 CHANGE_LABELS 纳入 image（改动清单里可点回产物）')
ok(/buildRecentImagesHint/.test(svc) && /本会话最近生成的图/.test(svc),
  '4.3 跨轮薄索引 buildRecentImagesHint（§5.4）')
ok(/requestInjection = \[scheduleHint, refInjection, perceptionInjection, recentImagesHint\]/.test(svc),
  '4.4 薄索引并进首条 user 消息层（requestInjection），**不进 system** —— prompt cache 前缀逐字稳定')
ok(/【生图工具 image】/.test(svc), '4.5 系统提示词注入 image 规则（§4.5）')

console.log('\n[5 水印在渲染层（E1）]')
const srcFiles = walk(path.join(ROOT, 'src'), ['.ts', '.tsx'])
const eleFiles = walk(path.join(ROOT, 'electron'), ['.ts'])
const aigcInSrc = srcFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('data-aigc'))
const aigcInElectron = eleFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('data-aigc'))
ok(aigcInSrc.length === 1 && aigcInSrc[0].endsWith('ImageCard.tsx'),
  '5.1 AIGC 水印锚 data-aigc 只在 src/components/shared/AssistantPanel/ImageCard.tsx')
ok(aigcInElectron.length === 0, '5.2 electron/ 侧不得出现水印标记（不改写落盘字节）')

console.log('\n[6 相对路径前缀只有一处（负向断言，方案 §9）]')
const allFiles = [...walk(path.join(ROOT, 'src'), ['.ts', '.tsx']), ...eleFiles]
const prefixFiles = allFiles.filter((f) => fs.readFileSync(f, 'utf8').includes("startsWith('../')"))
ok(prefixFiles.length === 1 && prefixFiles[0].endsWith(path.join('lib', 'attachmentImage.ts')),
  `6.1 前导 ../ 的归一化只在 attachmentImage.ts 一处（实数 ${prefixFiles.length}：${prefixFiles.map((f) => path.relative(ROOT, f)).join(', ')}）`)
const img = read('src/lib/attachmentImage.ts')
ok(/export function normalizeVaultRel/.test(img) && /export async function loadVaultImage/.test(img),
  '6.2 生图卡走既有取回通道 normalizeVaultRel / loadVaultImage（§5.3，零安全面变更）')
ok(/【生图工具 image】[\s\S]{0,900}目标页所在目录/.test(svc),
  '6.3 注入文案明确「按目标页所在目录算相对路径」（§3.3 那条最难查的错）')

console.log('\n[7 斜杠指令收口（§5.1）]')
const cmds = read('src/lib/chatCommands.ts')
ok(/export const PASSTHROUGH_COMMANDS/.test(cmds), '7.1 PASSTHROUGH_COMMANDS 表存在')
ok(/name: '生图'[\s\S]{0,120}surfaces: \['assistant', 'aiTeaching'\]/.test(cmds),
  "7.2 /生图 入表且 surfaces = ['assistant','aiTeaching']")
ok(/name: 'mindmap'[\s\S]{0,120}surfaces: \['aiTeaching'\]/.test(cmds),
  '7.3 /mindmap 迁表后仍只在教学面')
ok(!/name === 'mindmap'/.test(cmds), '7.4 handleChatCommand 里不再有 /mindmap 硬编码白名单')
ok(/passthroughCommandsForSurface/.test(cmds), '7.5 放行判定与弹层候选读同一张表')
const menu = read('src/components/shared/SlashCommandMenu.tsx')
ok(/passthroughCommandsForSurface/.test(menu), '7.6 弹层候选由 PASSTHROUGH_COMMANDS 生成')
const teach = read('src/modules/ai-teaching/index.tsx')
ok(!/MINDMAP_SLASH_ITEM/.test(teach), '7.7 教学模块不再另写一份指令清单（搬进表）')
ok(/ImageCard/.test(teach) && /imageGroupsOf/.test(teach),
  '7.8 教学面消息区渲染生图卡（/生图 两面可见 -> 两面都得有卡）')

console.log('\n[8 设置项（§7）]')
const settings = read('src/lib/settings.ts')
ok(/aiImageModel:/.test(settings) && /aiImageEditModel:/.test(settings), '8.1 两个设置键存在')
ok(/anchor: 'aiTools.imageModel'/.test(settings) && /anchor: 'aiTools.imageEditModel'/.test(settings),
  '8.2 两个键都有 anchor（设置搜索要能跳到）')
const modelsTab = read('src/modules/settings/views/AiModelsTab.tsx')
ok(/aiImageModel/.test(modelsTab) && /aiImageEditModel/.test(modelsTab), '8.3 进「哪个场景用哪个模型」表')
// 锚点必须是**字面量**：设置搜索按 DOM 找落点、verify-ai-tab-anchors.mjs 按字面量文本数 anchor，
// 表达式形式（data-setting-anchor={sc.anchor}）两边都认不出来（2026-10-14 实测踩到）
ok(/data-setting-anchor="aiTools\.imageModel"/.test(modelsTab)
  && /data-setting-anchor="aiTools\.imageEditModel"/.test(modelsTab),
  '8.4 两行挂字面量 data-setting-anchor（设置搜索 / anchor 契约都只认字面量）')

console.log('\n[9 真跑纯函数：图片尺寸解析（imageHeaderPure）]')
// 1x1 PNG（手工构造最小合法头：签名 + IHDR 长度/类型 + 宽高）
const png = Buffer.alloc(24)
png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4)
png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1')
png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20)
ok(JSON.stringify(imageSizeOf(png)) === JSON.stringify({ w: 640, h: 480 }),
  '9.1 PNG 尺寸解析（640x480）', JSON.stringify(imageSizeOf(png)))
// JPEG：SOI + SOF0（长度 17, 精度 8, 高 200, 宽 300）
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03, 0x01, 0x11, 0x00])
ok(JSON.stringify(imageSizeOf(jpg)) === JSON.stringify({ w: 300, h: 200 }),
  '9.2 JPEG 尺寸解析（300x200）', JSON.stringify(imageSizeOf(jpg)))
ok(imageSizeOf(Buffer.from('not an image at all')) === null, '9.3 非法字节 -> null（不抛，落盘路径不被打断）')
ok(imageSizeOf(Buffer.alloc(0)) === null, '9.4 空 buffer -> null')
ok(exceedsPixelGuard(png) === false, '9.5 1 亿像素守卫：正常图放行')
const huge = Buffer.alloc(24)
huge.writeUInt32BE(0x89504e47, 0); huge.writeUInt32BE(0x0d0a1a0a, 4)
huge.writeUInt32BE(13, 8); huge.write('IHDR', 12, 'latin1')
huge.writeUInt32BE(20000, 16); huge.writeUInt32BE(20000, 20)
ok(exceedsPixelGuard(huge) === true, '9.6 1 亿像素守卫：20000x20000 拦下（与渲染侧同口径）')

console.log('\n[10 文件齐备]')
ok(exists('src/components/shared/AssistantPanel/ImageCard.tsx'), '10.1 ImageCard.tsx 存在')
ok(exists('electron/lib/imageHeaderPure.ts'), '10.2 imageHeaderPure.ts 存在（纯函数，契约可真跑）')

console.log(fails.length ? `\n${fails.length} FAIL` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)

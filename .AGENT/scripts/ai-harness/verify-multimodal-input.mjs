// 契约脚本：多模态输入（P2）
// 覆盖：data URL 校验 / 内容块 / 历史图片裁剪、协议适配、主进程落盘与注入、渲染层接线。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: I } = await loadTsModule(join(ROOT, 'electron/lib/assistantChatImagesPure.ts'))
const { mod: B } = await loadTsModule(join(ROOT, 'electron/lib/agentContextBudget.ts'))
const { mod: P } = await loadTsModule(join(ROOT, 'electron/lib/llmProtocolPure.ts'))

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q=='

// ── ① data URL / 输入校验 ─────────────────────────────────────────────────────
{
  const p = I.parseImageDataUrl(PNG)
  ok('PNG data URL 解析', p && p.mime === 'image/png' && p.base64.length > 0 && p.bytes > 0)
  ok('JPEG data URL 解析', I.parseImageDataUrl(JPEG)?.mime === 'image/jpeg')
  ok('拒绝非图片 mime', I.parseImageDataUrl('data:image/gif;base64,AAAA') === null)
  ok('拒绝非 data URL', I.parseImageDataUrl('https://x/y.png') === null)
  ok('拒绝空内容', I.parseImageDataUrl('data:image/png;base64,') === null)
  ok('拒绝超大图片（>2MB）', I.parseImageDataUrl(`data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`) === null)
}
{
  const one = I.validateChatImageInputs([{ dataUrl: PNG }])
  ok('合法单图通过', one.ok && one.images.length === 1)
  const five = I.validateChatImageInputs(Array.from({ length: 5 }, () => ({ dataUrl: PNG })))
  ok('超过 4 张拒绝', !five.ok && /最多 4 张/.test(five.error))
  const bad = I.validateChatImageInputs([{ dataUrl: 'nope' }])
  ok('非法图片拒绝', !bad.ok)
  ok('扩展名映射', I.extForImageMime('image/png') === 'png' && I.extForImageMime('image/jpeg') === 'jpg' && I.extForImageMime('image/webp') === 'webp' && I.extForImageMime('image/gif') === null)
  ok('data URL 回拼', I.dataUrlOfBase64('image/png', 'AAAA') === 'data:image/png;base64,AAAA')
}
{
  const parts = I.buildUserContent('看看这张图', [{ mime: 'image/png', dataUrl: PNG }])
  ok('多模态 content 为数组', Array.isArray(parts) && parts.length === 2)
  ok('文本在前、图片在后', parts[0].type === 'text' && parts[1].type === 'image_url')
  const noText = I.buildUserContent('  ', [{ mime: 'image/png', dataUrl: PNG }])
  ok('空文本有占位文字', Array.isArray(noText) && noText[0].text.length > 0)
  ok('无图片返回纯文本', I.buildUserContent('hi', []) === 'hi')
  ok('textOfContent 提取文本', I.textOfContent(parts) === '看看这张图' && I.textOfContent('plain') === 'plain')
  ok('图片 token 估算包含固定值', I.estimateContentTokens(parts) >= I.CHAT_IMAGE_TOKEN_ESTIMATE)
}

// ── ② 协议适配 ────────────────────────────────────────────────────────────────
{
  const input = P.buildResponsesInput([{ role: 'user', content: I.buildUserContent('看图', [{ mime: 'image/png', dataUrl: PNG }]) }])
  const content = input[0].content
  ok('Responses 输出 input_text / input_image', content.some((p) => p.type === 'input_text') && content.some((p) => p.type === 'input_image'))
  ok('Responses 图片 URL 原样', content.find((p) => p.type === 'input_image').image_url === PNG)
}
{
  const budget = B.estimateContentTokens(I.buildUserContent('看图', [{ mime: 'image/png', dataUrl: PNG }]))
  ok('历史预算把图片按固定值计入', budget >= 1200)
  ok('纯文本预算仍按字折算', B.estimateContentTokens('abcd') === Math.ceil(4 / 2.6))
}

// ── ③ 主进程接线 ──────────────────────────────────────────────────────────────
const imgIo = readFileSync(join(ROOT, 'electron/lib/assistantChatImages.ts'), 'utf8')
ok('图片存 .knowbase/agent/images', /agent\/images/.test(imgIo) && /IMAGES_SEG = 'agent\/images'/.test(imgIo))
ok('只读本模块路径（防篡改消息越界读）', /isChatImageRel/.test(imgIo) && /startsWith\(`\.knowbase\/\$\{IMAGES_SEG\}\/`\)/.test(imgIo))
ok('历史最多带 8 张', /MAX_HISTORY_IMAGES/.test(imgIo) && /capHistoryImages/.test(imgIo))
ok('删消息 / 删会话清理图片', /deleteChatImages/.test(imgIo) && /deleteSessionChatImages/.test(imgIo))

const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('请求接受图片', /images\?: ChatImageInput\[\]/.test(svc))
ok('发送前校验视觉模型', /visionChatCapable\(spec\)/.test(svc) && /当前模型不支持图片输入/.test(svc))
ok('图片落盘后才写消息', /saveChatImages\(sessionId, incomingImages\)/.test(svc) && /appendAgentMessage\(sessionId, 'user', message, undefined, savedImages\)/.test(svc))
ok('标题兜底图片消息', /ensureSessionTitle\(sessionId, message \|\| '图片消息'\)/.test(svc))
ok('手朋通道不接图片', /图片消息一律走通用助手/.test(svc))
ok('历史装配带图片', /buildHistoryWithImages\(capHistoryImages\(history\)\)/.test(svc))
ok('历史预算按内容数组估算', /estimateContentTokens\(m\.content\)/.test(svc))
ok('删消息清理图片', /deleteChatImages\(getMessageById\(sid, mid\)\?\.images\)/.test(svc))
ok('删会话清理图片', /deleteSessionChatImages\(sid\)/.test(svc))
ok('感知 / 作用域清单只取文本', /textOfContent\(lastUser\?\.content\)/.test(svc) && /textOfContent\(\[\.\.\.history\]/.test(svc))

const llm = readFileSync(join(ROOT, 'electron/lib/llmService.ts'), 'utf8')
ok('ChatMessage 内容支持数组', /content\?: string \| unknown\[\]/.test(llm))
ok('Anthropic 图片块转换', /type: 'image', source: \{ type: 'base64'/.test(llm))
ok('视觉能力不自动挑模型', /visionChatCapable\(modelSpec\?: string\)/.test(llm) && /不做自动挑选/.test(llm))
ok('视觉能力覆盖三种协议族', /familyOf\(p\.type, p\.modelFamilies, model\) !== null/.test(llm))
ok('IPC 暴露 llm:visionChatCapable', /llm:visionChatCapable/.test(llm))

const preload = readFileSync(join(ROOT, 'electron/preload/index.ts'), 'utf8')
ok('preload 暴露能力检测', /llmVisionChatCapable/.test(preload))
const ipc = readFileSync(join(ROOT, 'src/lib/ipc.ts'), 'utf8')
ok('ipc 包装与 agentChat 图片参数', /llmVisionChatCapable/.test(ipc) && /images\?: AgentImageInput\[\]/.test(ipc))

// ── ④ 渲染层 ──────────────────────────────────────────────────────────────────
const hook = readFileSync(join(ROOT, 'src/lib/useComposerImages.ts'), 'utf8')
ok('共用 hook 限制 4 张 / 2048px', /MAX_COMPOSER_IMAGES = 4/.test(hook) && /MAX_IMAGE_DIMENSION = 2048/.test(hook))
ok('共用 hook 支持粘贴 / 拖入 / 选文件', /onPaste/.test(hook) && /onDrop/.test(hook) && /onFileInputChange/.test(hook))
ok('压缩为 JPEG 并二次降质', /toDataURL\('image\/jpeg'/.test(hook) && /\[0\.65, 0\.5\]/.test(hook))
ok('超过 2MB 拒绝', /图片压缩后仍超过 2MB/.test(hook))

const body = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/ChatBody.tsx'), 'utf8')
ok('ChatBody 接入图片胶囊', /ComposerImageStrip/.test(body) && /composerImages\.onPaste/.test(body))
ok('ChatBody 图片按钮', /ImagePlus/.test(body) && /composerImages\.openPicker/.test(body))
ok('ChatBody 模型不支持提示', /imageModelWarn/.test(body) && /当前模型不支持图片输入/.test(body))
ok('ChatBody 发送守卫', /imageBlocked/.test(body) && /trySend/.test(body))

const chat = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/useAssistantChat.ts'), 'utf8')
ok('控制器发送图片', /outgoingImages/.test(chat) && /agentChat\(sid, body, outgoingCtx, cid, sessionSource, modelId \|\| undefined, effort, sk\?\.registryName,/.test(chat))
ok('乐观消息带图片', /images: outgoingImages\.map/.test(chat))
ok('刷新映射保留图片', /m\.images && m\.images\.length > 0 \? \{ images: m\.images \}/.test(chat))

const list = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/MessageList.tsx'), 'utf8')
ok('消息列表渲染缩略图', /ChatImageThumbs images=\{m\.images\}/.test(list))
const thumbs = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/ChatImageThumbs.tsx'), 'utf8')
ok('缩略图按路径加载', /loadVaultImage\(image\.relPath\)/.test(thumbs))
const strip = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/ComposerImageStrip.tsx'), 'utf8')
ok('输入区胶囊可移除', /onRemove\(im\.id\)/.test(strip))

// ── ⑤ AI 教学面（v3.42.0：与统一助手共用同一套图片输入）──────────────────────────
const teach = readFileSync(join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')
ok('教学面复用 useComposerImages', /useComposerImages\(\)/.test(teach))
ok('教学面共用图片胶囊与缩略图', /<ComposerImageStrip images=\{composerImages\.images\}/.test(teach) && /<ChatImageThumbs images=\{m\.images\}/.test(teach))
ok('教学面粘贴 / 拖入 / 选文件三入口', /onPaste=\{composerImages\.onPaste\}/.test(teach) && /onDrop=\{composerImages\.onDrop\}/.test(teach) && /composerImages\.openPicker/.test(teach))
ok('教学面模型能力检测用当前会话模型', /llmVisionChatCapable\(convoModel \|\| ''\)/.test(teach))
ok('教学面不支持时提示 + 发送禁用', /aiTeachImageModelWarn/.test(teach) && /disabled=\{imageBlocked \|\| \(!input\.trim\(\) && !composerImages\.hasImages\)\}/.test(teach))
ok('教学面发送带图片', /sendText\(text, cid, true, sk\?\.registryName, images\)/.test(teach) && /images\.length > 0 \? images\.map\(im => \(\{ name: im\.name, mime: im\.mime, dataUrl: im\.dataUrl/.test(teach))
ok('教学面乐观消息回显图片', /images\.map\(\(im\): AgentImageRef => \(\{/.test(teach))
ok('教学面刷新映射保留图片', /m\.images && m\.images\.length > 0 \? \{ images: m\.images \}/.test(teach))
ok('教学面带图不走斜杠指令通道', /images\.length === 0 && text\.startsWith\('\/'\)/.test(teach))

report('多模态输入（P2）')

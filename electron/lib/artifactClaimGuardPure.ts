/**
 * 产物声称核验（artifact claim guard）—— 零依赖纯函数，契约脚本 strip 类型后直接跑真实实现。
 *
 * 背景（2026-11-17 取证）：AI 教学里模型有时**没有调用** visual.html / mindmap / image，
 * 却在正文里写「右侧工件栏已打开示意图…」。历史会话留下过两次「本轮 trace 无任何工具步骤」
 * 的证据，模型随后自认「我只说了位置，没有真正调用工具」。工具成功时前端会自动开页签，
 * 所以这不是渲染失败，而是「声称 vs 事实」没有核验。
 *
 * 本文件只做两件事：检测「无产物支撑的完成态声称」、拼装补救 / 校正文案。
 * 补救轮本身由 agentService 执行（纯函数不碰会话）。
 *
 * 判定原则：**宁可漏报，不可大面积误报** —— 每次误报都会白烧一轮 LLM。
 *  - 先剥掉 Markdown 代码围栏（围栏里是示例文本，不算声称）；
 *  - 只认完成态：已生成 / 已经打开 / 生成好了 / 画好了 / 已更新……；「接下来会生成」不算；
 *  - 产物名词要落在完成态动词附近（±24 字），或命中「右侧 / 右栏 / 工件栏 已打开 + 产物路径」；
 *  - 否定句（没有 / 未能 / 无法 / 失败）、不确定句（应该 / 可能 / 似乎 / 要不要）、
 *    未来句（稍后 / 接下来）一律不算；
 *  - 「上一张 / 刚才 / 之前」这类指代已有产物的说法不算；「这张图已打开」只在动词是「打开」时
 *    视为旧图提醒（「这张图已生成」仍是完成态声称）。
 *
 * 契约：`.AGENT/scripts/ai-teaching/verify-artifact-claim-guard.mjs`
 */

export type ArtifactProductKind = 'visual' | 'mindmap' | 'image'

export interface ArtifactClaim {
  kind: ArtifactProductKind
  /** 命中的原文片段（≤120 字，仅用于诊断与契约脚本） */
  evidence: string
}

interface KindMeta {
  /** 用户可见名（校正文案用） */
  label: string
  /** 注册表工具名（补救提示用） */
  tool: string
}

const KIND_META: Record<ArtifactProductKind, KindMeta> = {
  visual: { label: '示意图', tool: 'visual.html' },
  mindmap: { label: '思维导图', tool: 'mindmap' },
  image: { label: '图片', tool: 'image' },
}

const KIND_ORDER: ArtifactProductKind[] = ['visual', 'mindmap', 'image']

/** 产物名词：主规则不用裸「图」（「这张图 / 下图」太容易误报）；裸「图已生成」另有窄规则 */
const KIND_NOUN_RE: Record<ArtifactProductKind, RegExp> = {
  visual: /(?:示意图|图示|结构图|流程图|函数图|几何图|关系图)/,
  mindmap: /(?:思维导图|脑图|导图)/,
  image: /(?:图片|配图|生图|图像|插画)/,
}

/** 完成态动词（必须带「已 / 好了 / 完毕」这类完成标记，避免把祈使句当成声称） */
const COMPLETION_RE = /(?:已经|已)(?:为你|帮你|给你)?(?:生成|画好|画完|创建|保存|写入|打开|做好|更新)|(?:画好|生成好|生成完毕|做好了|出图了|更新好)(?:了)?/g

/** 裸「图已生成 / 图已画好」：产物名词只有一个「图」字，单独走一条窄规则。
 *  用负向后顾排除「示意图 / 思维导图 / 图片」等复合词（那些由 KIND_NOUN_RE 负责）。 */
const BARE_FIGURE_DONE_RE = /(?<![思导意片])图已(?:经)?(?:生成|画好|画完)/g

/** 右侧面板已打开 + 产物路径（覆盖「标题里写示意图、正文只报路径」的声称） */
const PANE_OPEN_RE = /(?:(?:右侧|右栏|右边栏|工件栏|右面)[^\n。；]{0,14}已(?:经)?打开|已(?:经)?打开[^\n。；]{0,14}(?:右侧|右栏|右边栏|工件栏|右面))/g

const ARTIFACT_PATH_RE: Record<ArtifactProductKind, RegExp> = {
  visual: /visuals\/[^\s`'"()（）]+\.html/i,
  mindmap: /mindmaps\/[^\s`'"()（）]+\.json/i,
  image: /(?:outputs|\.attachments)\/[^\s`'"()（）]+\.(?:png|jpe?g|webp|gif|bmp|avif)/i,
}

const NEG_RE = /(?:没有|没能|未能|尚未|无法|不能|失败|不要|不用|无需|不需要|别再)/
const HEDGE_RE = /(?:应该|可能|大概|也许|似乎|看起来|要不要|是否需要|是否|如果|若|待会|稍后|接下来)/
const REF_RE = /(?:上一张|上一条|上一幅|上一个|上图|下图|刚才|之前|此前|原有|旧版|旧图|上次|先前)/
/**
 * 「这张 / 那张 / 该图 + 已打开」通常只是提醒旧图还开着；但「这张图已生成」是完成态声称，
 * 不能一起放过 —— 所以弱指代只在动词是「打开」时生效。
 */
const WEAK_REF_RE = /(?:这张|那张|该图|这个图|那个图)/
/** 「已经生成过 / 画过 / 打开过」= 既往经历（可能发生在之前的轮次），不是本轮新产物 */
const PAST_REF_RE = /(?:生成|画好|画|打开|创建|保存|写入|更新)过/

const FENCE_RE = /```[\s\S]*?```/g

function stripCodeFences(text: string): string {
  return text.replace(FENCE_RE, '\n')
}

function sliceAround(text: string, index: number, length: number, before: number, after: number): string {
  return text.slice(Math.max(0, index - before), Math.min(text.length, index + length + after))
}

function isNegatedOrHedged(text: string, index: number, length: number): boolean {
  const w = sliceAround(text, index, length, 12, 10)
  return NEG_RE.test(w) || HEDGE_RE.test(w)
}

function refersToExisting(text: string, index: number, length: number): boolean {
  if (REF_RE.test(sliceAround(text, index, length, 20, 0))) return true
  // 「已经生成过 / 画过 / 打开过」= 既往经历，不是本轮新产物
  if (PAST_REF_RE.test(sliceAround(text, index, length, 6, 8))) return true
  // 「打开」+ 弱指代（这张 / 该图）= 提醒旧图还开着，不是新产物声称
  const verb = text.slice(index, index + length)
  return verb.includes('打开') && WEAK_REF_RE.test(sliceAround(text, index, length, 24, 0))
}

function evidenceOf(text: string, index: number, length: number): string {
  return sliceAround(text, index, length, 24, 48).replace(/\s+/g, ' ').trim().slice(0, 120)
}

function makeClaim(kind: ArtifactProductKind, text: string, index: number, length: number): ArtifactClaim {
  return { kind, evidence: evidenceOf(text, index, length) }
}

/**
 * 检测「本轮没有产物支撑，却声称已经生成 / 打开」的完成态文本。
 *
 * @param reply    模型本轮最终正文（**不要**传拼接了「本次改动」清单的完整落库串）
 * @param produced 本轮已经成功写入的产物种类（visual.html / mindmap / image / artifact.edit）
 */
export function detectUnbackedArtifactClaim(
  reply: string,
  produced: readonly ArtifactProductKind[] = [],
): ArtifactClaim | null {
  const text = stripCodeFences(String(reply ?? ''))
  if (!text.trim()) return null
  const done = new Set<ArtifactProductKind>(produced)

  // ① 完成态动词 + 邻近产物名词
  for (const m of text.matchAll(COMPLETION_RE)) {
    const index = m.index ?? 0
    const length = m[0].length
    if (isNegatedOrHedged(text, index, length) || refersToExisting(text, index, length)) continue
    const near = sliceAround(text, index, length, 24, 24)
    for (const kind of KIND_ORDER) {
      if (done.has(kind)) continue
      if (KIND_NOUN_RE[kind].test(near)) return makeClaim(kind, text, index, length)
    }
  }

  // ② 裸「图已生成 / 图已画好」（产物名词只有一个「图」字，单独窄规则兜住）
  if (!done.has('visual')) {
    for (const m of text.matchAll(BARE_FIGURE_DONE_RE)) {
      const index = m.index ?? 0
      const length = m[0].length
      if (isNegatedOrHedged(text, index, length) || refersToExisting(text, index, length)) continue
      return makeClaim('visual', text, index, length)
    }
  }

  // ③ 右侧面板已打开 + 产物路径
  for (const m of text.matchAll(PANE_OPEN_RE)) {
    const index = m.index ?? 0
    const length = m[0].length
    if (isNegatedOrHedged(text, index, length) || refersToExisting(text, index, length)) continue
    for (const kind of KIND_ORDER) {
      if (done.has(kind)) continue
      if (ARTIFACT_PATH_RE[kind].test(text)) return makeClaim(kind, text, index, length)
    }
  }

  return null
}

/**
 * 补救轮提示：告诉模型「你声称了、但本轮没有产物」——要求它真正调用，或如实说明。
 * 以 role=user 注入，但开头明确「不是用户发言」，避免模型把系统核对当成用户追问。
 */
export function buildArtifactClaimRepairNotice(claim: ArtifactClaim): string {
  const { label, tool } = KIND_META[claim.kind]
  return '（系统核对（不是用户发言）：你上一条回答声称已生成/打开「' + label + '」，但本轮运行中没有任何 '
    + tool + ' 成功写入记录。请按事实处理：'
    + '① 确实需要这张' + label + ' → 现在调用 ' + tool + ' 真正生成（正文不必重复上一段讲解）；'
    + '② 你指的是之前已经存在的' + label + ' → 用一句话说明是哪一张，不要重新生成；'
    + '③ 当前没有该工具或生成失败 → 直接说明没有生成及原因，不要写「已生成 / 已打开」。'
    + '处理完只输出必要回应，不要提及本系统核对。）'
}

/** 确定性校正文案：补救轮也没能支撑时追加到回复末尾（不改写模型原文） */
export function artifactCorrectionNotice(claim: ArtifactClaim): string {
  const { label, tool } = KIND_META[claim.kind]
  return '——\n（系统核对：本轮没有生成任何新的' + label + '文件（' + tool + ' 没有成功写入），上文「已生成 / 已打开」的说法不成立。）'
}

/**
 * 补救轮前后正文合并：模型重写讲解时按「首 60 字指纹」去重，避免同一段出现两遍。
 */
export function mergeClaimRepairReply(original: string, repaired: string): string {
  const a = String(original ?? '').trim()
  const b = String(repaired ?? '').trim()
  if (!a) return b
  if (!b) return a
  const fingerprint = (s: string) => s.replace(/\s+/g, '').slice(0, 60)
  const fp = fingerprint(a)
  if (fp && fingerprint(b).includes(fp)) return b
  return a + '\n\n' + b
}

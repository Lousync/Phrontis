#!/usr/bin/env node
/**
 * qwerty-learner 嵌入补丁（v3.17.0）
 *
 * 上游是独立仓库，不把它的源码纳入 Phrontis 版本控制；构建时浅克隆到 vendor/，
 * 本脚本做**字符串级**补丁（不依赖 git apply 的上下文行号），任何一处匹配失败都会
 * 立即退出并指出文件与片段 —— 上游改动后人工更新这里，而不是静默产出一个带上报的包。
 *
 * 用法：node scripts/vocab/patch-upstream.mjs <upstreamDir>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root || !existsSync(root)) {
  console.error('[FAIL] 用法：node scripts/vocab/patch-upstream.mjs <qwerty-learner 目录>')
  process.exit(1)
}

let changed = 0
function read(rel) {
  const p = join(root, rel)
  if (!existsSync(p)) {
    console.error(`[FAIL] 缺少文件：${rel}`)
    process.exit(1)
  }
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}
function write(rel, text) {
  writeFileSync(join(root, rel), text, 'utf8')
  changed++
}
function replaceOnce(rel, from, to, label) {
  const text = read(rel)
  if (!text.includes(from)) {
    console.error(`[FAIL] ${rel} 未找到补丁锚点：${label}\n--- 期望片段 ---\n${from.slice(0, 300)}`)
    process.exit(1)
  }
  if (text.includes(to) && to.length > 0) {
    console.log(`[SKIP] ${rel} 已打过：${label}`)
    return
  }
  write(rel, text.replace(from, to))
  console.log(`[OK] ${rel}：${label}`)
}
function removeOnce(rel, from, label) {
  const text = read(rel)
  if (!text.includes(from)) {
    console.error(`[FAIL] ${rel} 未找到补丁锚点：${label}`)
    process.exit(1)
  }
  write(rel, text.replace(from, ''))
  console.log(`[OK] ${rel}：${label}`)
}

// ---------- 1. 去统计上报 + HashRouter + 桥初始化 ----------
{
  const rel = 'index.html'
  removeOnce(
    rel,
    `    <script async src="https://www.googletagmanager.com/gtag/js?id=G-3FTEQXFKNF"></script>
    <script>
      window.dataLayer = window.dataLayer || []
      function gtag() {
        dataLayer.push(arguments)
      }
      gtag('js', new Date())

      gtag('config', 'G-3FTEQXFKNF')
    </script>

`,
    '移除 Google Tag Manager（index.html）',
  )
}
{
  const rel = 'src/index.tsx'
  removeOnce(rel, "import { Analytics } from '@vercel/analytics/react'\n", '移除 Vercel Analytics import')
  removeOnce(rel, "import mixpanel from 'mixpanel-browser'\n", '移除 mixpanel import')
  removeOnce(
    rel,
    `if (process.env.NODE_ENV === 'production') {
  // for prod
  mixpanel.init('bdc492847e9340eeebd53cc35f321691')
} else {
  // for dev
  mixpanel.init('5474177127e4767124c123b2d7846e2a', { debug: true })
}

`,
    '移除 mixpanel.init 块',
  )
  removeOnce(rel, '      <Analytics />\n', '移除 <Analytics />')
  replaceOnce(
    rel,
    "import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'",
    "import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'",
    'BrowserRouter → HashRouter（import）',
  )
  replaceOnce(
    rel,
    `<BrowserRouter basename={REACT_APP_DEPLOY_ENV === 'pages' ? '/qwerty-learner' : ''}>`,
    '<HashRouter>',
    'BrowserRouter → HashRouter（JSX 开标签）',
  )
  replaceOnce(rel, '</BrowserRouter>', '</HashRouter>', 'BrowserRouter → HashRouter（JSX 闭标签）')
  replaceOnce(
    rel,
    "import Loading from './components/Loading'",
    "import Loading from './components/Loading'\nimport { initVocabBridge, isEmbed } from './utils/phrontisBridge'",
    '引入 phrontisBridge',
  )
  replaceOnce(
    rel,
    `      if (!isMobile) {
        window.location.href = '/'
      }`,
    `      if (!isMobile && !isEmbed()) {
        window.location.href = '/'
      }`,
    '嵌入模式禁止 resize 跳转（会丢 embed/nonce 查询参数）',
  )
  replaceOnce(
    rel,
    'const container = document.getElementById(\'root\')',
    "initVocabBridge()\n\nconst container = document.getElementById('root')",
    '启动桥',
  )
}

// ---------- 2. mixpanel 变 no-op（保留全部导出签名，调用点零改动） ----------
{
  const rel = 'src/utils/mixpanel.ts'
  replaceOnce(
    rel,
    "import mixpanel from 'mixpanel-browser'",
    "const mixpanel = { init: (_key: string, _opts?: unknown) => {}, track: (_event: string, _props?: unknown) => {} }",
    'mixpanel → no-op',
  )
}

// ---------- 2b. trackEvent 变 no-op（避免 @vercel/analytics 被调用） ----------
{
  const rel = 'src/utils/trackEvent.ts'
  replaceOnce(
    rel,
    "import { track } from '@vercel/analytics'",
    "const track = (_event: string, _properties?: Record<string, string>) => {}",
    'Vercel track → no-op',
  )
}

// ---------- 3. 嵌入模式：隐藏 Footer / DonateCard / 推广弹窗 ----------
{
  const rel = 'src/components/Layout.tsx'
  replaceOnce(
    rel,
    "import Footer from './Footer'",
    "import Footer from './Footer'\nimport { isEmbed } from '@/utils/phrontisBridge'",
    'Layout 引入 isEmbed',
  )
  replaceOnce(rel, '      <Footer />', '      {!isEmbed() && <Footer />}', '嵌入模式隐藏 Footer')
}
{
  const rel = 'src/components/EnhancedPromotionModal/index.tsx'
  replaceOnce(
    rel,
    "import noop from '../../utils/noop'",
    "import noop from '../../utils/noop'\nimport { isEmbed } from '@/utils/phrontisBridge'",
    '推广弹窗引入 isEmbed',
  )
  replaceOnce(rel, '    if (!hasSeenPromotion) {', '    if (!hasSeenPromotion && !isEmbed()) {', '嵌入模式不弹推广')
}
{
  const rel = 'src/pages/Typing/index.tsx'
  replaceOnce(
    rel,
    "import { useSaveChapterRecord } from '@/utils/db'",
    "import { useSaveChapterRecord } from '@/utils/db'\nimport { isEmbed, postTypingSession } from '@/utils/phrontisBridge'",
    'Typing 引入桥',
  )
  replaceOnce(
    rel,
    "import { useCallback, useEffect, useState } from 'react'",
    "import { useCallback, useEffect, useRef, useState } from 'react'",
    'Typing 引入 useRef',
  )
  replaceOnce(
    rel,
    '  const [state, dispatch] = useImmerReducer(typingReducer, structuredClone(initialState))',
    '  const [state, dispatch] = useImmerReducer(typingReducer, structuredClone(initialState))\n  const sessionIdRef = useRef(\'\')\n  const wasFinishedRef = useRef(false)',
    'Typing 会话 id ref',
  )
  replaceOnce(
    rel,
    '  const setCurrentChapter = useSetAtom(currentChapterAtom)',
    '  const setCurrentChapter = useSetAtom(currentChapterAtom)\n  const currentChapter = useAtomValue(currentChapterAtom)',
    'Typing 读取当前章节（会话 id / 上报需要）',
  )
  replaceOnce(
    rel,
    `  useEffect(() => {
    if (words !== undefined) {
      const initialIndex = isReviewMode && reviewModeInfo.reviewRecord?.index ? reviewModeInfo.reviewRecord.index : 0

      dispatch({
        type: TypingStateActionType.SETUP_CHAPTER,
        payload: { words, shouldShuffle: randomConfig.isOpen, initialIndex },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words])`,
    `  useEffect(() => {
    if (words !== undefined) {
      const initialIndex = isReviewMode && reviewModeInfo.reviewRecord?.index ? reviewModeInfo.reviewRecord.index : 0
      sessionIdRef.current = \`\${currentDictId}:\${currentChapter}:\${Date.now()}\`

      dispatch({
        type: TypingStateActionType.SETUP_CHAPTER,
        payload: { words, shouldShuffle: randomConfig.isOpen, initialIndex },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words])`,
    '章节开始时生成稳定会话 id',
  )
  replaceOnce(
    rel,
    '  useConfetti(state.isFinished)',
    `  // 重复本章 / 下一章：isFinished 从 true 回到 false 时换一个新会话 id，
  // 避免同一章重复练习把上一轮记录覆盖掉（同一次练习内的重复上报仍同 id，幂等）。
  useEffect(() => {
    if (state.isFinished) {
      wasFinishedRef.current = true
      return
    }
    if (wasFinishedRef.current) {
      sessionIdRef.current = \`\${currentDictId}:\${currentChapter}:\${Date.now()}\`
      wasFinishedRef.current = false
    }
  }, [state.isFinished, currentDictId, currentChapter])

  useConfetti(state.isFinished)`,
    '重复本章换会话 id',
  )
  replaceOnce(
    rel,
    `    if (state.isFinished && !state.isSavingRecord) {
      chapterLogUploader()
      saveChapterRecord(state)
    }`,
    `    if (state.isFinished && !state.isSavingRecord) {
      chapterLogUploader()
      saveChapterRecord(state)
      postTypingSession({
        dict: currentDictId,
        dictName: idDictionaryMap[currentDictId]?.name,
        chapter: currentChapter,
        sessionId: sessionIdRef.current,
        state,
        finished: true,
      })
    }`,
    '章节完成上报会话',
  )
  replaceOnce(
    rel,
    '      {state.isFinished && <DonateCard />}',
    '      {state.isFinished && !isEmbed() && <DonateCard />}',
    '嵌入模式隐藏 DonateCard',
  )
  // pagehide 快照：应用关闭时把当前未完成章节也落一份（同 session id，幂等）
  replaceOnce(
    rel,
    `  useConfetti(state.isFinished)

  return (`,
    `  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => {
    if (!isEmbed()) return
    const onHide = () => {
      if (!stateRef.current.chapterData.words.length) return
      postTypingSession({
        dict: currentDictId,
        dictName: idDictionaryMap[currentDictId]?.name,
        chapter: currentChapter,
        sessionId: sessionIdRef.current,
        state: stateRef.current,
        finished: false,
      })
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [currentDictId, currentChapter])

  useConfetti(state.isFinished)

  return (`,
    'pagehide 快照',
  )
}

// ---------- 3b. 嵌入模式关闭发音播放 / 预取 / 按键音（避免无音频设备时 Chromium 音频栈崩溃） ----------
{
  const rel = 'src/hooks/usePronunciation.ts'
  replaceOnce(
    rel,
    "import { pronunciationConfigAtom } from '@/store'",
    "import { pronunciationConfigAtom } from '@/store'\nimport { isEmbed } from '@/utils/phrontisBridge'",
    '发音 hook 引入 isEmbed',
  )
  replaceOnce(
    rel,
    'export default function usePronunciationSound(word: string, isLoop?: boolean) {',
    `export default function usePronunciationSound(word: string, isLoop?: boolean) {
  // 嵌入模式（尤其无音频设备的 Linux/CI）关闭播放：避免 Chromium 音频栈崩溃。
  if (isEmbed()) return { play: noop, stop: noop, isPlaying: false }
  return usePronunciationSoundInner(word, isLoop)
}

function usePronunciationSoundInner(word: string, isLoop?: boolean) {`,
    '嵌入模式关闭发音播放',
  )
  replaceOnce(
    rel,
    `  useEffect(() => {
    if (!word) return

    const soundUrl = generateWordSoundSrc(word, pronunciationConfig.type)`,
    `  useEffect(() => {
    if (!word || isEmbed()) return

    const soundUrl = generateWordSoundSrc(word, pronunciationConfig.type)`,
    '嵌入模式关闭发音预取',
  )
}
{
  const rel = 'src/hooks/useKeySounds.ts'
  replaceOnce(
    rel,
    "import { hintSoundsConfigAtom, keySoundsConfigAtom } from '@/store'",
    "import { hintSoundsConfigAtom, keySoundsConfigAtom } from '@/store'\nimport { isEmbed } from '@/utils/phrontisBridge'",
    '按键音 hook 引入 isEmbed',
  )
  replaceOnce(
    rel,
    'export default function useKeySound(): [PlayFunction, PlayFunction, PlayFunction] {',
    `export default function useKeySound(): [PlayFunction, PlayFunction, PlayFunction] {
  // 嵌入模式（尤其无音频设备的 Linux/CI）关闭按键音：避免 Chromium 音频栈崩溃。
  if (isEmbed()) return [noop, noop, noop] as [PlayFunction, PlayFunction, PlayFunction]
  return useKeySoundInner()
}

function useKeySoundInner(): [PlayFunction, PlayFunction, PlayFunction] {`,
    '嵌入模式关闭按键音',
  )
}

// ---------- 4. 外链改内部 + 嵌入模式去掉品牌头（保留控制条） ----------
{
  const rel = 'src/components/Header/index.tsx'
  replaceOnce(
    rel,
    "import logo from '@/assets/logo.svg'",
    "import logo from '@/assets/logo.svg'\nimport { isEmbed } from '@/utils/phrontisBridge'",
    'Header 引入 isEmbed',
  )
  replaceOnce(
    rel,
    `const Header: React.FC<PropsWithChildren> = ({ children }) => {
  return (`,
    `const Header: React.FC<PropsWithChildren> = ({ children }) => {
  // 嵌入 Phrontis：品牌头（logo + Qwerty Learner 大字）占高度且与宿主标题重复，
  // 只保留控制条（词库 / 章节 / 发音 / Start）。
  if (isEmbed()) {
    return (
      <header className="z-20 mx-auto w-full px-3 pt-2">
        <nav className="my-card on element flex w-full flex-wrap items-center justify-center gap-2 rounded-xl bg-white p-2 transition-colors duration-300 dark:bg-gray-800">
          {children}
        </nav>
      </header>
    )
  }
  return (`,
    '嵌入模式去掉品牌头',
  )
  replaceOnce(rel, 'to="https://qwerty.kaiyi.cool/"', 'to="/"', 'Header logo 指回首页')
}

// ---------- 5. 主题：embed 时用非持久 atom，避免覆盖宿主主题 ----------
{
  const rel = 'src/store/index.ts'
  replaceOnce(
    rel,
    "export const isOpenDarkModeAtom = atomWithStorage('isOpenDarkModeAtom', window.matchMedia('(prefers-color-scheme: dark)').matches)",
    `const embedTheme = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('theme') : null
export const isOpenDarkModeAtom = embedTheme
  ? atom(embedTheme === 'dark')
  : atomWithStorage('isOpenDarkModeAtom', window.matchMedia('(prefers-color-scheme: dark)').matches)`,
    'embed 主题跟随宿主',
  )
}

// ---------- 6. 新增桥文件 ----------
{
  const rel = 'src/utils/phrontisBridge.ts'
  const text = `import type { TypingState } from '@/pages/Typing/store/type'

/**
 * Phrontis 嵌入桥（v3.17.0）
 *
 * 只在 ?embed=1 时生效：
 * - 向宿主发 ready / session；
 * - 接收 init / theme / day（day 目前仅用于后续跨设备回灌，页面可忽略）。
 *
 * 会话载荷只含 AI 需要的语义字段（词/释义/错次/词库/章节），逐字母时序仍留在 Dexie。
 */
const CHANNEL = 'phrontis-vocab'

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

export function isEmbed(): boolean {
  return params().get('embed') === '1'
}

function nonce(): string {
  return params().get('nonce') || ''
}

export function postToHost(type: string, payload?: unknown): void {
  if (!isEmbed() || window.parent === window) return
  window.parent.postMessage({ channel: CHANNEL, v: 1, nonce: nonce(), type, payload }, '*')
}

export function initVocabBridge(): void {
  if (!isEmbed()) return
  let acked = false
  let ping: number | undefined
  const sendReady = () => postToHost('ready', { href: location.href })
  window.addEventListener('message', (e) => {
    const d = e.data as { channel?: string; type?: string; payload?: { dark?: boolean } } | undefined
    if (!d || d.channel !== CHANNEL) return
    if (d.type === 'init') {
      acked = true
      if (ping !== undefined) window.clearInterval(ping)
    }
    if (d.type === 'theme' && typeof d.payload?.dark === 'boolean') {
      document.documentElement.classList.toggle('dark', d.payload.dark)
    }
  })
  // 宿主 iframe 的 message 监听在 React effect 里才挂上；页面可能先加载完，
  // 这里每 500ms 重发一次 ready，直到收到 init（最多 10 秒）。
  sendReady()
  ping = window.setInterval(() => {
    if (acked) {
      if (ping !== undefined) window.clearInterval(ping)
      return
    }
    sendReady()
  }, 500)
  window.setTimeout(() => {
    if (ping !== undefined) window.clearInterval(ping)
  }, 10000)
}

function localDate(d: Date): string {
  const p = (n: number) => (n < 10 ? \`0\${n}\` : String(n))
  return \`\${d.getFullYear()}-\${p(d.getMonth() + 1)}-\${p(d.getDate())}\`
}

export function postTypingSession(opts: {
  dict: string
  dictName?: string
  chapter: number
  sessionId: string
  state: TypingState
  finished: boolean
}): void {
  if (!isEmbed()) return
  const { chapterData, timerData } = opts.state
  if (!chapterData.words.length) return
  const now = new Date()
  const startedAt = new Date(now.getTime() - timerData.time * 1000).toISOString()
  const words = chapterData.words.map((w, i) => {
    const log = chapterData.userInputLogs[i]
    return {
      word: w.name,
      trans: Array.isArray(w.trans) ? w.trans.join('；') : String(w.trans || ''),
      phonetic: w.usphone || w.ukphone || '',
      dict: opts.dict,
      chapter: opts.chapter,
      correctCount: log?.correctCount ?? 0,
      wrongCount: log?.wrongCount ?? 0,
    }
  })
  postToHost('session', {
    session: {
      date: localDate(now),
      id: opts.sessionId || \`\${opts.dict}:\${opts.chapter}:\${startedAt}\`,
      dict: opts.dict,
      dictName: opts.dictName,
      chapter: opts.chapter,
      startedAt,
      finishedAt: opts.finished ? now.toISOString() : '',
      wordCount: chapterData.wordCount,
      correctCount: chapterData.correctCount,
      wrongCount: chapterData.wrongCount,
      durationSec: timerData.time,
      words,
    },
  })
}
`
  if (existsSync(join(root, rel))) {
    console.log(`[SKIP] ${rel} 已存在`)
  } else {
    write(rel, text)
    console.log(`[OK] ${rel}：新增桥文件`)
  }
}

console.log(`\n[DONE] qwerty-learner 补丁完成，共 ${changed} 处写入`)

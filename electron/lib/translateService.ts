import { createHash } from 'crypto'
import { ipcMain } from 'electron'
import { invokeLlmInternal } from './llmService'
import { getTranslationCache, upsertTranslationCache } from '../database/repositories/translationRepo'
import { getDictionaryStatus, lookupWord } from './dictionaryService'
import type { DictLookupResult, TranslateInvokeRequest, TranslateInvokeResult, TranslateMode } from '../../src/lib/translateTypes'

/**
 * 划词翻译：单词走离线词典（dictionaryService），句子/段落与 AI 精讲走
 * invokeLlmInternal（单次补全、不经 agent 工具循环），结果按 cache_key 落
 * translation_cache 表，重复划词零 token。
 */

const MAX_TRANSLATE_CHARS = 5000

const SENTENCE_SYSTEM_PROMPT = `你是一位面向中国大学生的英语辅导老师,精通大学英语四六级(CET-4/CET-6)与考研英语。用户给出一段英文,请用 Markdown、以简体中文输出以下内容:

## 译文
通顺、准确的中文翻译。

## 结构拆解
(仅当原文是较复杂的长难句时给出;简单句可写"简单句,无需拆解")指出句子主干(主谓宾/主系表),并逐一标注从句、非谓语、插入语等修饰成分及其作用。

## 核心词与短语
挑出 3-6 个考试高频或易错的单词/短语,每项一行:\`词/短语\` (词性) 中文释义。

## 考点提示
语法、固定搭配或理解上最容易出错的地方;若没有值得说的就省略本节。

不要寒暄,不要复述原文。`

const WORD_AI_SYSTEM_PROMPT = `你是一位面向中国大学生的英语词汇辅导老师,熟悉四六级与考研英语大纲。用户给出一个英文单词及词典已知信息,请用 Markdown、以简体中文输出:

### 一句话释义
用一句话概括这个单词最核心的意思与典型用法场景。

### 例句
3 个例句,难度贴合四六级/考研阅读,每句后附中文翻译。例句必须自然真实,不得编造出处与年份。

### 词根词缀
若有明确的词根/词缀,拆解并说明,并举 1-2 个同根词;若没有则简要说明词源或跳过,不要编造。

### 记忆法
一个简短好记的联想/谐音/拆分记忆法。

### 易混词
列出 2-3 个形近或义近的词,各用一句话说明区别。

总字数控制在 350 字以内,不要寒暄。`

function detectMode(text: string): TranslateMode {
  return /^[A-Za-z][A-Za-z''-]*$/.test(text.trim()) ? 'word' : 'sentence'
}

function cacheKeyFor(mode: TranslateMode, ai: boolean, text: string): string {
  if (mode === 'word' && ai) return `word:${text.trim().toLowerCase()}`
  return `sent:${createHash('sha1').update(text).digest('hex')}`
}

function buildWordAiUserPrompt(word: string, dict: DictLookupResult): string {
  const e = dict.entry
  const known = e
    ? `词典释义:${e.translationLines.slice(0, 4).join('; ') || '(无)'}${e.definition ? `\n英文释义:${e.definition}` : ''}`
    : '词典未收录该词(可能是生僻词或人名等),请谨慎判断它是否为规范英文词。'
  return `单词:${word}\n${known}`
}

async function translateInvoke(req: TranslateInvokeRequest): Promise<TranslateInvokeResult> {
  const text = String(req?.text ?? '').trim()
  if (!text) return { ok: false, error: '内容为空', code: 'EMPTY_TEXT' }
  if (text.length > MAX_TRANSLATE_CHARS) {
    return { ok: false, error: `选区过长(>${MAX_TRANSLATE_CHARS} 字符),请缩短后重试`, code: 'TOO_LONG' }
  }

  const mode: TranslateMode = req.mode ?? detectMode(text)
  const wantAi = mode === 'sentence' ? true : Boolean(req.ai)
  const dict: DictLookupResult = mode === 'word' ? lookupWord(text) : { found: false }

  if (mode === 'word' && !wantAi) {
    return { ok: true, mode, markdown: '', model: '', cached: false, dict }
  }

  // 命中缓存直接返回(零 token)
  const key = cacheKeyFor(mode, wantAi, text)
  const cached = getTranslationCache(key)
  if (cached) {
    return { ok: true, mode, markdown: cached.result_md, model: cached.model, cached: true, dict }
  }

  const system = mode === 'word' ? WORD_AI_SYSTEM_PROMPT : SENTENCE_SYSTEM_PROMPT
  const user = mode === 'word' ? buildWordAiUserPrompt(text, dict) : text

  const r = await invokeLlmInternal({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // 划词翻译是单次调用、无对话上下文：固定用途名（会话头要稳定，不能是随机值）
    sessionId: 'translate',
  })
  if (!r.ok) {
    // 归因 P0 起 r.code 细化成 25 个归因码 + 3 个配置码；划词翻译的错误标签（TranslateInvokeResult）
    // 只认配置类三码，其余一律 LLM_ERROR —— 与本轮之前的行为逐字一致（以前也只有这三码或 undefined）。
    const cfg = r.code === 'PROVIDER_NOT_FOUND' || r.code === 'PROVIDER_DISABLED' || r.code === 'NO_DEFAULT_MODEL' ? r.code : undefined
    return { ok: false, mode, error: r.error, code: cfg ?? 'LLM_ERROR', dict }
  }
  const markdown = r.content.trim()
  if (markdown) upsertTranslationCache(key, mode, text, markdown, r.model)
  return { ok: true, mode, markdown, model: r.model, cached: false, dict }
}

export function registerTranslateHandlers(): void {
  ipcMain.handle('dict:lookup', (_e, word: string) => lookupWord(String(word ?? '')))
  ipcMain.handle('dict:status', () => getDictionaryStatus())
  ipcMain.handle('translate:invoke', (_e, req: TranslateInvokeRequest) => translateInvoke(req))
}

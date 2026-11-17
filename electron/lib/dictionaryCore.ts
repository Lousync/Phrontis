import type { DictExchange, DictLookupResult, DictWordEntry } from '../../src/lib/translateTypes'

/**
 * 离线词典的纯查询层（零 Electron 依赖）—— 定位/加载在 dictionaryService，
 * 这里只做「词条数据 + 查询词 → 结果」的纯函数变换，便于契约脚本直接跑真实算法
 * （.AGENT/scripts/translate/verify-dict-lookup.mjs）。
 *
 * 查询顺序：直接命中 → lemma 反查表 → 规则式词形还原 → 缩写还原（n't / 's / 're …）。
 * 结果命中任一即返回，并带上还原来源（inflectedFrom）供 UI 显示「xx 的词形还原」。
 */

// 精简库词条字段（数组按下标取值，省文件体积）
// [phonetic, translation, definition, tag, collins, oxford, bnc, frq, exchange]
export type RawEntry = [string, string, string, string, number, number, number, number, string]

export interface DictData {
  v: number
  words: Record<string, RawEntry>
  lemma: Record<string, string>
}

function parseExchange(raw: string): DictExchange {
  const out: DictExchange = {}
  if (!raw) return out
  for (const part of raw.split('/')) {
    const i = part.indexOf(':')
    if (i < 1) continue
    const key = part.slice(0, i)
    const value = part.slice(i + 1).trim()
    if (!value) continue
    // ECDICT exchange 键位: p过去式 d过去分词 i现在分词 3三单 r比较级 t最高级 s复数
    if (key === 'p') out.past = value
    else if (key === 'd') out.pp = value
    else if (key === 'i') out.ing = value
    else if (key === '3') out.s3 = value
    else if (key === 's') out.plural = value
    else if (key === 'r') out.er = value
    else if (key === 't') out.est = value
  }
  return out
}

function toEntry(query: string, word: string, raw: RawEntry, inflectedFrom?: string): DictWordEntry {
  return {
    word,
    query,
    inflectedFrom,
    phonetic: raw[0] || '',
    translationLines: (raw[1] || '').split('\n').map(l => l.trim()).filter(Boolean),
    definition: raw[2] || '',
    tags: (raw[3] || '').split(/\s+/).filter(Boolean),
    collins: Number(raw[4]) || 0,
    oxford: Number(raw[5]) || 0,
    bnc: Number(raw[6]) || 0,
    frq: Number(raw[7]) || 0,
    exchange: parseExchange(raw[8] || ''),
  }
}

/** 统一弯引号（文章排版常见 ’）后去首尾非字母；词内的连字符 / 撇号保留 */
function normalize(word: string): string {
  return word.trim().toLowerCase().replace(/[’‘`´]/g, "'").replace(/^[^a-z]+|[^a-z]+$/g, '')
}

/** 规则式变形还原（lemma 表未覆盖时兜底） */
function morphologicalCandidates(w: string): string[] {
  const cands: string[] = []
  const push = (s: string) => { if (s.length > 1) cands.push(s) }
  if (w.endsWith('ies')) push(w.slice(0, -3) + 'y')
  if (w.endsWith('es')) push(w.slice(0, -2))
  if (w.endsWith('s') && !w.endsWith('ss')) push(w.slice(0, -1))
  if (w.endsWith('ied')) push(w.slice(0, -3) + 'y')
  if (w.endsWith('ed')) {
    push(w.slice(0, -1))       // doubled consonant: stopped → stopp-ed? 先试去 e
    push(w.slice(0, -2))
    push(w.slice(0, -2) + 'e') // hoped → hope
  }
  if (w.endsWith('ing')) {
    push(w.slice(0, -3))
    push(w.slice(0, -3) + 'e') // hoping → hope
  }
  // 双写辅音还原: stopped → stopp → stop
  if (/(.)\1ed$/.test(w) || /(.)\1ing$/.test(w)) {
    push(w.slice(0, -3))
  }
  if (w.endsWith('est')) {
    push(w.slice(0, -3))
    push(w.slice(0, -3) + 'e')
  }
  if (w.endsWith('er')) {
    push(w.slice(0, -2))
    push(w.slice(0, -2) + 'e')
  }
  return cands
}

/** 缩写的不规则展开（n't 规则会把 can't 切坏，需单独纠正） */
const IRREGULAR_CONTRACTIONS: Record<string, string> = {
  "can't": 'can',
  "won't": 'will',
  "shan't": 'shall',
  "ain't": 'be',
}

/** 缩写还原：don't → do / isn't → is / they're → they / it's → it …（仅用于词典查询） */
function contractionCandidates(w: string): string[] {
  const cands: string[] = []
  // 这里允许单字母原形（I'm → i），与词形还原的「至少两字母」规则不同
  const push = (s: string) => { if (s.length >= 1) cands.push(s) }
  if (!w.includes("'")) return cands
  const irregular = IRREGULAR_CONTRACTIONS[w]
  if (irregular) push(irregular)
  if (w.endsWith("n't")) push(w.slice(0, -3))
  for (const suffix of ["'re", "'ve", "'ll", "'s", "'d", "'m"]) {
    if (w.endsWith(suffix)) push(w.slice(0, -suffix.length))
  }
  return cands
}

interface Resolution {
  word: string
  raw: RawEntry
}

/** 一个候选词在词库内的解析（直接命中 / lemma / 规则变形） */
function resolve(d: DictData, w: string): Resolution | null {
  const direct = d.words[w]
  if (direct) return { word: w, raw: direct }

  // 词形还原表（inflected → base）优先
  const lemmaBase = d.lemma[w]
  if (lemmaBase) {
    const hit = d.words[lemmaBase]
    if (hit) return { word: lemmaBase, raw: hit }
  }
  // 规则式变形兜底
  for (const cand of morphologicalCandidates(w)) {
    const base = d.lemma[cand] ?? cand
    const hit = d.words[base]
    if (hit) return { word: base, raw: hit }
  }
  return null
}

export function lookupInDict(d: DictData | null, rawWord: string): DictLookupResult {
  const query = rawWord.trim()
  if (!d || !query) return { found: false }
  const norm = normalize(query)
  if (!norm) return { found: false }

  const direct = resolve(d, norm)
  if (direct) {
    return {
      found: true,
      entry: toEntry(query, direct.word, direct.raw, direct.word === norm ? undefined : norm),
    }
  }

  // 缩写还原：命中后仍按「原词的还原」展示
  for (const base of contractionCandidates(norm)) {
    const hit = resolve(d, base)
    if (hit) return { found: true, entry: toEntry(query, hit.word, hit.raw, norm) }
  }
  return { found: false }
}

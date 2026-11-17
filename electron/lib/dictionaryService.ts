import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'
import type { DictLookupResult, DictStatus } from '../../src/lib/translateTypes'
import { lookupInDict } from './dictionaryCore'
import type { DictData } from './dictionaryCore'

/**
 * 离线词典：ECDICT 精简库（resources/dict/ecdict-exam.json，构建脚本
 * scripts/build-exam-dict.py 从全量 ECDICT 筛选四六级/考研等考纲词生成）。
 * 惰性加载一次进内存，查询为纯 Map 命中；查询算法在 ./dictionaryCore（零 Electron 依赖）。
 *
 * 路径口径：打包后 extraResources 把 resources/dict 落到 `process.resourcesPath/dict`
 * （见 package.json build.extraResources），**不能再拼一层 resources** —— 早前这里多拼一层
 * 导致所有安装版词典加载失败、每个单词都显示「未收录」。dev 下 appPath 可能偏，
 * 故按 helpService 同款多探几个位置。
 */

let data: DictData | null = null
let wordCount = 0
let loadFailed = false

function dictCandidates(): string[] {
  if (app.isPackaged) return [join(process.resourcesPath, 'dict', 'ecdict-exam.json')]
  const appPath = app.getAppPath()
  return [
    join(appPath, 'resources', 'dict', 'ecdict-exam.json'),
    resolve(appPath, '..', '..', 'resources', 'dict', 'ecdict-exam.json'),
    join(process.cwd(), 'resources', 'dict', 'ecdict-exam.json'),
  ]
}

function ensureLoaded(): DictData {
  if (data) return data
  for (const p of dictCandidates()) {
    try {
      if (!existsSync(p)) continue
      data = JSON.parse(readFileSync(p, 'utf-8')) as DictData
      wordCount = Object.keys(data.words).length
      return data
    } catch (err) {
      console.error('[dict] Failed to load dictionary:', p, err)
    }
  }
  // 只打一次错误日志，避免每次划词都刷屏
  if (!loadFailed) {
    loadFailed = true
    console.error('[dict] Dictionary not found. Tried:', dictCandidates().join(' | '))
  }
  data = { v: 1, words: {}, lemma: {} }
  return data
}

export function lookupWord(rawWord: string): DictLookupResult {
  return lookupInDict(ensureLoaded(), rawWord)
}

export function getDictionaryStatus(): DictStatus {
  ensureLoaded()
  return { available: wordCount > 0, wordCount }
}

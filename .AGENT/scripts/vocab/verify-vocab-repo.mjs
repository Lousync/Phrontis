/**
 * 背单词 vault 仓库契约（v3.17.0 数据层，2026-11-06 补建）
 *
 * 为什么需要它：phrontis-core 的 vocabVaultRepo 曾整个缺失，导致 electron-vite 的
 * main SSR bundle 报 Rollup failed to resolve import，源码 dev 起不来。本脚本钉住三件
 * 容易改坏的事：session 幂等（章节结束 + pagehide 双发不能翻倍）、当天词表聚合口径
 * （dict|word 唯一、计数累加、章节省略取最近）、复习取词窗口（当天全量 + 往日只取错词）。
 *
 * 跑法（Node 22 的 --experimental-strip-types 不解析 .ts 里的无扩展名相对导入，必须先打包）：
 *   node node_modules/esbuild/bin/esbuild .AGENT/scripts/vocab/verify-vocab-repo.mjs  *     --bundle --platform=node --format=esm --outfile=tmp/vocab-repo.mjs
 *   node tmp/vocab-repo.mjs
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureCore, setCurrentVault } from '../../../../phrontis-core/src/kbStore/vaultContext.ts'
import {
  vaultVocabDayGet,
  vaultVocabRecordSession,
  vaultVocabReviewWords,
} from '../../../../phrontis-core/src/kbStore/vocabVaultRepo.ts'

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [OK] ' + label) }
  else { fail++; console.log('  [FAIL] ' + label + (extra ? '  → ' + JSON.stringify(extra) : '')) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-repo-'))
const vault = path.join(tmp, 'vault')
fs.mkdirSync(vault, { recursive: true })
configureCore({ userDataDir: tmp })
setCurrentVault({ rootId: 'test', name: 'test', rootPath: vault })

const DAY = '2026-11-06'
const YES = '2026-11-05'

function session(over) {
  return {
    date: DAY, id: 's1', dict: 'cet4', dictName: '四级', chapter: 1,
    startedAt: DAY + 'T10:00:00.000Z', finishedAt: DAY + 'T10:05:00.000Z',
    wordCount: 3, correctCount: 2, wrongCount: 1, durationSec: 300,
    words: [
      { word: 'apple', trans: '苹果', phonetic: '/ˈæpl/', dict: 'cet4', chapter: 1, correctCount: 2, wrongCount: 1 },
      { word: 'banana', trans: '香蕉', phonetic: '/bəˈnɑːnə/', dict: 'cet4', chapter: 1, correctCount: 1, wrongCount: 0 },
      { word: 'cherry', trans: '樱桃', phonetic: '/ˈtʃeri/', dict: 'cet4', chapter: 1, correctCount: 1, wrongCount: 0 },
    ],
    ...over,
  }
}

console.log('\n§1 空仓库')
ok(vaultVocabDayGet(DAY) === null, '无记录返回 null')
ok(vaultVocabReviewWords({ date: DAY }).count === 0, '无记录时复习结果为空')

console.log('\n§2 记录会话')
{
  const d = vaultVocabRecordSession(session())
  ok(d.date === DAY, '返回当天日期')
  ok(d.words.length === 3, '词表 3 个', d.words.length)
  ok(d.sessions.length === 1, '会话 1 条')
  const apple = d.words.find(w => w.word === 'apple')
  ok(apple && apple.wrongCount === 1 && apple.correctCount === 2, 'apple 对错次数正确', apple)
  ok(d.words.every(w => w.chapter === 1), '章节号写入')
  ok(fs.existsSync(path.join(vault, '.knowbase/modules/vocab/days', DAY + '.json')), '落盘路径正确')
}

console.log('\n§3 幂等：同 id 重发不累加')
{
  const d = vaultVocabRecordSession(session())
  ok(d.sessions.length === 1, '会话仍 1 条（替换而非追加）', d.sessions.length)
  const apple = d.words.find(w => w.word === 'apple')
  ok(apple.wrongCount === 1, 'apple 错次仍 1（未翻倍）', apple.wrongCount)
}

console.log('\n§4 第二个会话：同词累加、新词并入')
{
  const d = vaultVocabRecordSession({
    ...session(),
    id: 's2', chapter: 2,
    startedAt: DAY + 'T12:00:00.000Z', finishedAt: DAY + 'T12:04:00.000Z',
    wordCount: 2, correctCount: 1, wrongCount: 1,
    words: [
      { word: 'apple', trans: '苹果', phonetic: '/ˈæpl/', dict: 'cet4', chapter: 2, correctCount: 0, wrongCount: 2 },
      { word: 'dragon', trans: '龙', phonetic: '/ˈdræɡən/', dict: 'cet4', chapter: 2, correctCount: 1, wrongCount: 0 },
    ],
  })
  ok(d.sessions.length === 2, '会话 2 条')
  ok(d.words.length === 4, '词表 4 个（apple 合并，dragon 新增）', d.words.length)
  const apple = d.words.find(w => w.word === 'apple')
  ok(apple.correctCount === 2 && apple.wrongCount === 3, 'apple 计数跨会话累加', apple)
  ok(apple.chapter === 2, 'apple 章节取最近一次', apple.chapter)
}

console.log('\n§5 复习取词：当天全量')
{
  const r = vaultVocabReviewWords({ date: DAY })
  ok(r.count === 4, '当天 4 个词全出', r.count)
  ok(r.range.start === '2026-10-30' && r.range.end === DAY, '默认窗口 7 天', r.range)
  const apple = r.words.find(w => w.word === 'apple')
  ok(apple.wrongCount === 3, 'apple 错次 3', apple.wrongCount)
  // sources 是「哪些天背过」：同一天多次背诵已在 rebuildWords 合并成一条（chapter 取最近）
  ok(Array.isArray(apple.sources) && apple.sources.length === 1 && apple.sources[0].date === DAY,
    'apple sources 标出当天（同日多会话已聚合）', apple.sources)
  ok(r.words[0].wrongCount >= r.words[r.words.length - 1].wrongCount, '按错次降序')
}

console.log('\n§6 onlyWrong / limit')
{
  const r = vaultVocabReviewWords({ date: DAY, onlyWrong: true })
  ok(r.count === 1, '只错词：仅 apple（错 3 次）', r.count)
  ok(r.words.every(w => w.wrongCount > 0), '结果全是错词')
  const r2 = vaultVocabReviewWords({ date: DAY, limit: 2 })
  ok(r2.count === 2, 'limit=2 生效', r2.count)
  const r3 = vaultVocabReviewWords({ date: DAY, limit: 9999 })
  ok(r3.count === 4, 'limit 超上限不崩（clamp 200）', r3.count)
}

console.log('\n§7 跨天：往日只取错词')
{
  vaultVocabRecordSession({
    ...session(),
    date: YES, id: 'y1', chapter: 3,
    startedAt: YES + 'T09:00:00.000Z', finishedAt: YES + 'T09:03:00.000Z',
    wordCount: 2, correctCount: 1, wrongCount: 1,
    words: [
      { word: 'eagle', trans: '鹰', phonetic: '/ˈiːɡl/', dict: 'cet4', chapter: 3, correctCount: 0, wrongCount: 4 },
      { word: 'fish', trans: '鱼', phonetic: '/fɪʃ/', dict: 'cet4', chapter: 3, correctCount: 2, wrongCount: 0 },
    ],
  })
  const r = vaultVocabReviewWords({ date: DAY, wrongDays: 7 })
  const names = r.words.map(w => w.word)
  ok(names.includes('eagle'), '往日错词纳入', names)
  ok(!names.includes('fish'), '往日正确词不纳入', names)
  ok(r.range.start <= YES, '窗口覆盖昨天', r.range)
  const eagle = r.words.find(w => w.word === 'eagle')
  ok(eagle.sources[0].date === YES, 'sources 标出日期', eagle.sources)

  const r0 = vaultVocabReviewWords({ date: DAY, wrongDays: 0 })
  ok(!r0.words.map(w => w.word).includes('eagle'), 'wrongDays=0 只看当天')
}

console.log('\n§8 损坏兜底')
{
  const p = path.join(vault, '.knowbase/modules/vocab/days', '2026-11-07.json')
  fs.writeFileSync(p, '{ 这不是 json')
  const d = vaultVocabDayGet('2026-11-07')
  ok(d === null, '损坏文件按无记录处理')
  ok(fs.readdirSync(path.dirname(p)).some(n => n.includes('.corrupt-')), '损坏文件已备份')
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' (' + pass + '/' + (pass + fail) + ')')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)

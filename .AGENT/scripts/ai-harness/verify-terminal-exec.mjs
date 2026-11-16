// 契约脚本：终端 exec 增强（P1-3）
// 覆盖：tailLines / filter / 输出续读 offset、后台任务输出句柄、清理与接线。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: M } = await loadTsModule(join(ROOT, 'electron/lib/terminalOutputPure.ts'))

// ── ① 整形：tailLines ─────────────────────────────────────────────────────────
{
  const text = 'a\nb\nc\nd'
  ok('tailLines 取末尾 N 行', M.shapeAiOutput(text, { tailLines: 2 }) === 'c\nd')
  ok('tailLines=0 不裁', M.shapeAiOutput(text, { tailLines: 0 }) === text)
  ok('tailLines 负数按不裁', M.shapeAiOutput(text, { tailLines: -3 }) === text)
  ok('tailLines 上限 2000', M.clampTailLines(999999) === 2000)
  ok('tailLines 小数向下取整', M.clampTailLines(2.9) === 2)
}

// ── ② 整形：filter（行级 AND / 不区分大小写）──────────────────────────────────
{
  const text = 'INFO build start\nERROR build failed\nERROR test failed\nINFO done'
  ok('单关键词过滤', M.shapeAiOutput(text, { filter: 'error' }) === 'ERROR build failed\nERROR test failed')
  ok('多关键词 AND', M.shapeAiOutput(text, { filter: 'error failed' }) === 'ERROR build failed\nERROR test failed')
  ok('AND 不命中则为空', M.shapeAiOutput(text, { filter: 'error done' }) === '')
  ok('过滤词大小写不敏感', M.shapeAiOutput(text, { filter: 'ERROR' }).includes('ERROR build failed'))
  ok('过滤词归一：去重', JSON.stringify(M.normalizeFilterTokens(' a  A b ')) === JSON.stringify(['a', 'b']))
  ok('过滤词长度上限', M.normalizeFilterTokens('x'.repeat(400))[0].length === 200)
}
{
  const text = 'match 1\nskip\nmatch 2\nskip\nmatch 3'
  ok('先过滤再取尾部（最近 N 条匹配）', M.shapeAiOutput(text, { filter: 'match', tailLines: 2 }) === 'match 2\nmatch 3')
}

// ── ③ 续读：offset / nextOffset / hasMore ─────────────────────────────────────
{
  const view = '0123456789'
  const s1 = M.sliceAiOutput(view, 0, 4)
  ok('首段切片', s1.output === '0123' && s1.hasMore && s1.nextOffset === 4 && s1.totalChars === 10)
  const s2 = M.sliceAiOutput(view, s1.nextOffset, 4)
  ok('续读下一段', s2.output === '4567' && s2.hasMore && s2.nextOffset === 8)
  const s3 = M.sliceAiOutput(view, s2.nextOffset, 4)
  ok('末段无更多', s3.output === '89' && !s3.hasMore && s3.nextOffset === 10)
  const s4 = M.sliceAiOutput(view, 999, 4)
  ok('offset 越界返回空且不报错', s4.output === '' && !s4.hasMore && s4.nextOffset === 10)
  const s5 = M.sliceAiOutput(view, -5, 4)
  ok('负 offset 归零', s5.output === '0123')
  const big = M.sliceAiOutput('x'.repeat(9000), 0)
  ok('默认 8000 字符上限', big.output.length === 8000 && big.hasMore && big.nextOffset === 8000 && big.totalChars === 9000)
}
{
  ok('CRLF 统一为 LF 便于按行裁', M.shapeAiOutput('a\r\nb\r\nc', { tailLines: 1 }) === 'c')
}

// ── ④ 接线（源码断言）─────────────────────────────────────────────────────────
const svc = readFileSync(join(ROOT, 'electron/lib/terminalService.ts'), 'utf8')
ok('exec 结果带 outputId / nextOffset / hasMore', /outputId: reqId/.test(svc) && /nextOffset: sliced\.nextOffset/.test(svc) && /hasMore: sliced\.hasMore/.test(svc))
ok('后台执行立即返回 running + outputId', /background: true, status: 'running'/.test(svc))
ok('输出保留最近 40 条 / 4M 字符', /AI_OUTPUT_KEEP = 40/.test(svc) && /AI_OUTPUT_TOTAL_CHARS = 4_000_000/.test(svc))
ok('后台任务可被 kill 且应用退出时清理', /export function aiReadOutput/.test(svc) && /killAllAiJobs/.test(svc) && /entry\.status = 'killed'/.test(svc))
ok('输出失控保险丝仍保留', /AI_OUTPUT_RAW_CAP/.test(svc) && /entry\.overCap = true/.test(svc))
ok('前台输出先整形再切片', /shapeAiOutput\(entry\.text/.test(svc) && /sliceAiOutput\(shaped, 0\)/.test(svc))

const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('exec 暴露 tailLines / filter / background', /tailLines: \{ type: 'number'/.test(bt) && /filter: \{ type: 'string'/.test(bt) && /background: \{ type: 'boolean'/.test(bt))
ok('新增 terminal.output 工具', /name: 'builtin\.terminal\.output'/.test(bt) && /aiReadOutput\(/.test(bt))
ok('terminal.output 需要 outputId 且可 kill', /required: \['outputId'\]/.test(bt) && /kill: \{ type: 'boolean'/.test(bt))

const main = readFileSync(join(ROOT, 'electron/main/index.ts'), 'utf8')
ok('应用退出时终止后台任务', /killAllAiJobs\(\)/.test(main))

const labels = readFileSync(join(ROOT, 'src/lib/toolLabels.ts'), 'utf8')
ok('新工具有中文动作标签', /builtin\.terminal\.exec': '执行命令'/.test(labels) && /builtin\.terminal\.output': '读取终端输出'/.test(labels))

report('终端 exec 增强（P1-3）')

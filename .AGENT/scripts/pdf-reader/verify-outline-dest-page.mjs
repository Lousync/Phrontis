// 行为契约：PDF 大纲目录 dest → 页码的基数契约（台账 F-9，2026-09-26 修复批注）。
//
// 锁的行为（全部真机可见症状，验**真实现**不是复制品）：
//   ① destToPageNum 返回 **1 基页码**：下游 goPage / scrollPageIntoView / 页码输入框全程 1 基，
//      旧实现把 dest 首元素的 .num 直接当页码 → 跳到哪全看该 PDF 怎么编对象号。
//   ② 基数换算必经 pdf.getPageIndex(ref)（0 基）再 +1：.num 是 PDF **对象号**不是页号 ——
//      顺序编号的 PDF 恰好近似页序（表象=差一页），对象流压缩 / 增量保存的 PDF 对象号
//      散乱（表象=真机所见「差很多且无规律」）。getPageIndex 穿页树解析，才是权威。
//   ③ 失败兜底 = 1（保留旧语义）；jumpOutline 守卫必须放行 p=1（dest 指向第 1 页是合法跳转，
//      写成 p > 1 会把「dest 指第 1 页点目录没反应」原样复发）。
//   ④ 静态负向：PdfOutlineTree 不许出现「return d[0].num / return .num」直返路径（①②的回归防线）。
//
// 为什么走 esbuild 打包而非 strip-types 直 import：PdfOutlineTree.tsx 含 JSX，
// node strip-types 不认 .tsx（探针先例 = probe-s6-selfheal.cjs 头注）。本函数是纯渲染层
// 逻辑（零 electron 依赖），打包后普通 node 即可跑，不需要 electron。
//
// 跑法（仓库根目录，两步）：
//   node_modules/.bin/esbuild src/components/shared/pdf/PdfOutlineTree.tsx --bundle \
//     --platform=node --format=cjs --external:pdfjs-dist --external:react \
//     --outfile=tmp/f9-destToPageNum-bundle.cjs
//   node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-outline-dest-page.mjs
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? `  [${extra}]` : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? `  [${extra}]` : '')) }
}

// ---- 打包真实现（契约自含打包步骤，跑前不依赖手工预备）----
// Windows 注意：node_modules/.bin/esbuild 是 sh shim（spawn ENOENT），真身是
// node_modules/esbuild/bin/esbuild（由 esbuild 包的 install 脚本放置）。
const esbuildBin = process.platform === 'win32'
  ? join(repo, 'node_modules/esbuild/bin/esbuild')
  : join(repo, 'node_modules/.bin/esbuild')
const bundlePath = join(repo, 'tmp/f9-destToPageNum-bundle.cjs')
console.log('[0] esbuild 打包真实现（PdfOutlineTree.tsx → CJS）')
try {
  execFileSync(process.execPath, [
    esbuildBin,
    join(repo, 'src/components/shared/pdf/PdfOutlineTree.tsx'),
    '--bundle', '--platform=node', '--format=cjs',
    '--external:pdfjs-dist', '--external:react',
    `--outfile=${bundlePath}`,
  ], { cwd: repo, stdio: 'pipe' })
  ok(existsSync(bundlePath), '打包产物存在')
} catch (e) {
  ok(false, 'esbuild 打包失败', String(e.stderr ?? e.message).split('\n')[0])
}

if (existsSync(bundlePath)) {
  // ---- ①② 行为用例（stub 的对象号→索引映射刻意乱序：模拟「页对象不连续 / 夹非页对象」）----
  console.log('[1] destToPageNum 行为（真实现 + stub getPageIndex）')
  const { pathToFileURL } = await import('node:url')
  const { destToPageNum } = await import(pathToFileURL(bundlePath).href)
  const refToIndex = new Map([
    [100, 0],  // 对象 100 → 页索引 0（第 1 页）
    [205, 5],  // 对象 205 → 页索引 5（第 6 页）
    [17, 2],   // 对象 17 → 页索引 2（第 3 页）
  ])
  const pdf = {
    async getPageIndex(ref) {
      if (!refToIndex.has(ref.num)) throw new Error(`bad ref ${ref.num}`)
      return refToIndex.get(ref.num)
    },
    async getDestination(id) {
      if (id === 'first') return [{ num: 100, gen: 0 }]
      if (id === 'sixth') return [{ num: 205, gen: 0 }]
      return null
    },
  }
  ok(await destToPageNum(pdf, [{ num: 100, gen: 0 }]) === 1,
    '① 页索引 0 → 返回 1（1 基；顺序编号 PDF 的旧表象 = 差一页）')
  ok(await destToPageNum(pdf, [{ num: 205, gen: 0 }]) === 6,
    '② 对象号 205（页索引 5）→ 返回 6（旧实现按 .num 直算得 205 —— 乱跳无规律的真形态）')
  ok(await destToPageNum(pdf, [{ num: 17, gen: 0 }]) === 3,
    '③ .num 是对象号≠页号：换算必经 getPageIndex（无「按 .num 直算」残留路径）')
  ok(await destToPageNum(pdf, 'first') === 1 && await destToPageNum(pdf, 'sixth') === 6,
    '④ 命名字符串 dest 先 getDestination 再走同一换算')
  ok(await destToPageNum(pdf, [{ num: 999, gen: 0 }]) === 1
    && await destToPageNum(pdf, { notAnArray: true }) === 1
    && await destToPageNum(pdf, 'unknown-name') === 1,
    '⑤ 失败兜底 = 1（getPageIndex 抛错 / dest 形状不识 / 解析为 null）')
}

// ---- ⑥ 静态负向：直返 .num 的回归防线 + jumpOutline 守卫放行 1 ----
console.log('[2] 静态负向（剥注释后匹配，防注释文字假命中）')
const { stripComments } = await import('../shared/strip-comments.mjs')
const treeSrc = stripComments(readFileSync(join(repo, 'src/components/shared/pdf/PdfOutlineTree.tsx'), 'utf8'))
const railSrc = stripComments(readFileSync(join(repo, 'src/components/shared/pdf/PdfRailPanel.tsx'), 'utf8'))
ok(!/return\s+\(?(first|d\[0\])\)?\s*\.?\s*num/.test(treeSrc) && !/return\s+\w+\.num\b/.test(treeSrc),
  '⑥a 负向：destToPageNum 无「直返 .num」路径（①②的文本回归防线）')
ok(treeSrc.includes('getPageIndex'), '⑥b 基数换算走 getPageIndex（0 基权威）')
ok(/if\s*\(p\s*>=\s*1\)/.test(railSrc),
  '⑥c jumpOutline 守卫放行 p=1（dest 指第 1 页是合法跳转；p>1 会复发「点了没反应」）')

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)

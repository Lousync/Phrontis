// 契约验证：摘录先行批次（书架阅读器划选摘录，bookshelf-reader-upgrade-design 二期拆批）。
//
// 覆盖：
//   ① excerptSchema 纯函数用例（键归一 / 创建载荷白名单 / patch 白名单 / 存量修补）
//   ② 负向：excerpts.json 单写方（只允许出现在 excerptVaultRepo.ts）
//   ③ IPC 三处同步：excerpt 四通道在 preload / types / ipc.ts 均有声明
//   ④ DataChangeScope 双侧含 'excerpt'
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-excerpts.mjs

import { stripComments } from '../shared/strip-comments.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ===== ① excerptSchema 纯函数用例 =====
console.log('\n--- ① excerptSchema：键归一 / 创建载荷 / patch / 修补 ---')
const S = await import('../../../electron/lib/kbStore/excerptSchema.ts')

check('键归一：基础', S.excerptKey('r1', '.books/a.txt') === 'r1/.books/a.txt')
check('键归一：反斜杠 → posix', S.excerptKey('r1', '.books\\a.txt') === 'r1/.books/a.txt')
check('键归一：空 rootId 拒绝', S.excerptKey('', 'a.txt') === '')
check('键归一：绝对 relPath 拒绝', S.excerptKey('r1', '/a.txt') === '')
check('键反解', S.excerptKeyRel('r1/.books/a.txt') === '.books/a.txt')

// 创建载荷：pdf 分支
const pdfOk = S.sanitizeExcerptCreate({ kind: 'pdf', text: ' 重点内容 ', page: 3, rects: [{ l: 0.1, t: 0.2, w: 0.3, h: 0.02 }] })
check('创建：pdf 合法收（text 去首尾空白）', !!pdfOk && pdfOk.kind === 'pdf' && pdfOk.page === 3 && pdfOk.text === '重点内容' && pdfOk.rects?.length === 1)
check('创建：pdf 缺 page 拒', S.sanitizeExcerptCreate({ kind: 'pdf', text: 'x', page: 0 }) === null)
check('创建：pdf page 非整数拒', S.sanitizeExcerptCreate({ kind: 'pdf', text: 'x', page: 1.5 }) === null)
check('创建：rects 越界（>1）拒', S.sanitizeExcerptCreate({ kind: 'pdf', text: 'x', page: 1, rects: [{ l: 1.5, t: 0, w: 0.1, h: 0.1 }] }) === null)
check('创建：rects 空数组拒', S.sanitizeExcerptCreate({ kind: 'pdf', text: 'x', page: 1, rects: [] }) === null)
// 创建载荷：txt 分支
const txtOk = S.sanitizeExcerptCreate({ kind: 'txt', text: '段落摘文', paraIndex: 4, start: 2, end: 8 })
check('创建：txt 合法收', !!txtOk && txtOk.paraIndex === 4 && txtOk.start === 2 && txtOk.end === 8)
check('创建：txt 缺 paraIndex 拒', S.sanitizeExcerptCreate({ kind: 'txt', text: 'x' }) === null)
check('创建：txt start/end 缺一半拒', S.sanitizeExcerptCreate({ kind: 'txt', text: 'x', paraIndex: 1, start: 2 }) === null)
check('创建：txt end<=start 拒', S.sanitizeExcerptCreate({ kind: 'txt', text: 'x', paraIndex: 1, start: 5, end: 5 }) === null)
// 通用拒绝
check('创建：kind 非法拒', S.sanitizeExcerptCreate({ kind: 'epub', text: 'x', paraIndex: 1 }) === null)
check('创建：空 text 拒', S.sanitizeExcerptCreate({ kind: 'txt', text: '   ', paraIndex: 1 }) === null)
check('创建：text 超 8000 拒', S.sanitizeExcerptCreate({ kind: 'txt', text: 'x'.repeat(8001), paraIndex: 1 }) === null)
check('创建：payload 注入 id/at/updatedAt 不进白名单', (() => { const r = S.sanitizeExcerptCreate({ kind: 'txt', text: 'x', paraIndex: 1, id: 'hack', at: 'hack', updatedAt: 'hack' }); return !!r && !('id' in r) && !('at' in r) && !('updatedAt' in r) })())

// patch
check('patch：note 合法收（超长截断 500）', (() => { const r = S.sanitizeExcerptPatch({ note: 'n'.repeat(600) }); return !!r && r.note?.length === 500 })())
check('patch：note 非字符串拒', S.sanitizeExcerptPatch({ note: 3 }) === null)
check('patch：updatedAt 不在白名单', S.sanitizeExcerptPatch({ updatedAt: 'x' }) === null)
check('patch：非对象拒', S.sanitizeExcerptPatch('note') === null)

// 修补
const coerced = S.coerceExcerpt({ id: 'e1', kind: 'txt', text: '摘文', note: '', paraIndex: 2, start: 0, end: 2, at: 'AT', updatedAt: 'UP' }, 'NOW')
check('修补：合法条目保留 id/at/updatedAt', !!coerced && coerced.id === 'e1' && coerced.at === 'AT' && coerced.updatedAt === 'UP')
check('修补：缺 id 返回 null（由仓库层剔除）', S.coerceExcerpt({ kind: 'txt', text: 'x', paraIndex: 1 }, 'NOW') === null)
check('修补：坏 kind 返回 null', S.coerceExcerpt({ id: 'e2', kind: 'mobi', text: 'x' }, 'NOW') === null)

// ===== ② 负向：excerpts.json 单写方 =====
console.log('\n--- ② 负向：excerpts.json 唯一写方 ---')
{
  const offenders = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
        const src = readFileSync(p, 'utf8')
        if (stripComments(src).includes('excerpts.json') && !p.replaceAll('\\', '/').endsWith('electron/lib/kbStore/excerptVaultRepo.ts')) offenders.push(p)
      }
    }
  }
  walk(join(ROOT, 'electron'))
  walk(join(ROOT, 'src'))
  check('excerpts.json 只出现在 excerptVaultRepo.ts', offenders.length === 0, offenders.join(', '))
}

// ===== ③ IPC 三处同步 =====
console.log('\n--- ③ IPC 三处同步：preload / types / ipc.ts ---')
{
  const preload = stripComments(read('electron/preload/index.ts'))
  const types = stripComments(read('src/types/index.ts'))
  const ipc = stripComments(read('src/lib/ipc.ts'))
  for (const ch of ['excerpt:list', 'excerpt:create', 'excerpt:patch', 'excerpt:delete']) {
    check(`preload 桥含 ${ch}`, preload.includes(`'${ch}'`))
  }
  check('types 声明 ExcerptItem', types.includes('interface ExcerptItem'))
  check('types 声明 excerptList/Create/Patch/Delete', /excerptList:|excerptCreate:|excerptPatch:|excerptDelete:/.test(types))
  check('ipc.ts 封装四函数', /export const excerptList|export const excerptCreate|export const excerptPatch|export const excerptDelete/.test(ipc))
}

// ===== ④ DataChangeScope 双侧 =====
console.log('\n--- ④ DataChangeScope 双侧含 excerpt ---')
{
  const scopeSrc = stripComments(read('src/lib/dataChanged.ts'))
  check("渲染层 union 含 'excerpt'", scopeSrc.includes("'excerpt'"))
  const repoSrc = stripComments(read('electron/database/repositories/excerptRepo.ts'))
  check("主进程 broadcastDataChanged('excerpt')", repoSrc.includes("broadcastDataChanged('excerpt')"))
  // 阅读器消费：TxtReaderView / PdfReaderView / ReadingSidePanel 都监听 excerpt scope
  for (const f of ['src/components/shared/txt/TxtReaderView.tsx', 'src/components/shared/pdf/PdfReaderView.tsx', 'src/components/workbench/ReadingSidePanel.tsx']) {
    check(`${f.split('/').pop()} 消费 excerpt 广播`, stripComments(read(f)).includes("useDataChanged('excerpt'"))
  }
}

console.log(`\n${pass ? '全部通过' : '存在失败项'}`)
process.exit(pass ? 0 : 1)

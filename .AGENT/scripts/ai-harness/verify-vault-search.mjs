// 契约脚本：仓库内容搜索升级（P0-A `builtin.vault.search` / v3.31.0）
// 搜索逻辑在工具 handler 内（含 fs 遍历），此处断言能力面与安全边界；
// glob 语义本身由 verify-vault-find 覆盖。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
const seg = bt.slice(bt.indexOf("name: 'builtin.vault.search'"), bt.indexOf("name: 'builtin.vault.write'"))

ok('支持正则（regex 参数 + RegExp 构造）', /regex: \{ type: 'boolean'/.test(seg) && /new RegExp\(q, caseSensitive/.test(seg))
ok('正则长度上限 200（回溯风险）', /q\.length > 200/.test(seg) && /正则过长/.test(seg))
ok('正则语法错误回喂模型', /正则语法错误/.test(seg))
ok('支持 glob 文件过滤（复用 vaultFindPure）', /matchesFindPattern\(\{ rel: relPath, type: 'file' \}, globPat\)/.test(seg))
ok('支持大小写敏感', /caseSensitive: \{ type: 'boolean'/.test(seg))
ok('支持上下文行（≤5）', /contextLines: \{ type: 'number'/.test(seg) && /clamp\(Math\.floor\(num\(args\.contextLines, 0\)\), 0, 5\)/.test(seg))
ok('命中带行号与列号', /line: i \+ 1/.test(seg) && /column/.test(seg))
ok('每文件最多 5 条命中（上下文预算）', /matches\.length < 5/.test(seg))
ok('默认跳过忽略项，includeIgnored 可含', /includeIgnored/.test(seg) && /walkAiFiles\(root, root, files, budget, \{ includeIgnored \}\)/.test(seg))
ok('伪文本（含 NUL）跳过', /text\.includes\('\\u0000'\)/.test(seg))
ok('保留 hasMore / scanTruncated / skippedLarge 口径', /scanTruncated: budget\.truncated/.test(seg) && /hasMore: offset \+ hits\.length < allHits\.length/.test(seg))

report('verify-vault-search')

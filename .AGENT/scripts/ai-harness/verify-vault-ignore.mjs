// 契约脚本：默认忽略与索引策略（P0-C / v3.31.0）
// 覆盖：默认目录清单、否定规则可恢复、索引跳过点文件、三处消费同一份清单、includeIgnored。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
const ignore = require('ignore')

const { mod: D } = await loadTsModule(join(ROOT, '../phrontis-core/src/kbStore/ignoreDefaults.ts'))
const { mod: IG } = await loadTsModule(join(ROOT, '../phrontis-core/src/kbStore/ignoreFile.ts'))

// ── ① 默认清单 ─────────────────────────────────────────────────────────────────
const need = ['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'vendor', '.next', '.cache']
ok('默认清单含依赖/产物目录', need.every((d) => D.DEFAULT_IGNORE_DIRS.includes(d)), D.DEFAULT_IGNORE_DIRS.join(','))
ok('规则行以 dir/ 结尾（任意深度）', D.DEFAULT_IGNORE_RULES.every((r) => r.endsWith('/')))
ok('规则行与目录清单一一对应', D.DEFAULT_IGNORE_RULES.length === D.DEFAULT_IGNORE_DIRS.length)

// ── ② 真实编译语义（默认层 + 用户层）──────────────────────────────────────────
const ign = ignore().add(D.DEFAULT_IGNORE_RULES.join('\n'))
ok('node_modules 命中', ign.ignores('node_modules/pkg/index.js'))
ok('嵌套 dist 命中', ign.ignores('packages/a/dist/bundle.js'))
ok('同名目录整棵命中', ign.ignores('build/'))
ok('普通笔记不命中', ign.ignores('笔记/a.md') === false)
ok('src 不命中', ign.ignores('src/index.ts') === false)
const withNeg = ignore().add(D.DEFAULT_IGNORE_RULES.join('\n')).add('!node_modules')
ok('用户 !node_modules 可恢复（否定规则优先）', withNeg.ignores('node_modules/pkg/a.js') === false)

// ── ③ 消费方统一 ───────────────────────────────────────────────────────────────
const builtin = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
const watcher = readFileSync(join(ROOT, 'electron/lib/fsWatcher.ts'), 'utf8')
const index = readFileSync(join(ROOT, '../phrontis-core/src/kbStore/knowledgeIndex.ts'), 'utf8')
const ignoreFile = readFileSync(join(ROOT, '../phrontis-core/src/kbStore/ignoreFile.ts'), 'utf8')

ok('builtinTools 引用默认忽略清单（不再手抄）', /SEARCH_IGNORE_DIRS = new Set\(DEFAULT_IGNORE_DIRS\)/.test(builtin))
ok('builtinTools 不再手写四目录清单', !/new Set\(\['node_modules', 'dist', 'out', 'build'\]\)/.test(builtin))
ok('fsWatcher 并入默认清单', /IGNORED_SEGMENTS = new Set<string>\(\[.*DEFAULT_IGNORE_DIRS/.test(watcher))
ok('ignoreFile 编译时先落默认层', /ign\.add\(DEFAULT_IGNORE_RULES\.join\('\\n'\)\)/.test(ignoreFile))
ok('无 .ignore 时也返回默认层（不再返回 null）', /cache\.absPath === ''/.test(ignoreFile))

// ── ④ 索引：点文件跳过 + 对账判据改 ruleLines ─────────────────────────────────
ok('索引跳过点文件', /entry\.name\.startsWith\('\.'\)\) continue/.test(index))
ok('对账判据改为 ruleLines.length > 0', /const ignoreAudit = ignoreResult\.ruleLines\.length > 0/.test(index))
ok('索引仍放行 .knowbase/_inbox', /_inbox/.test(index))

// ── ⑤ ignoreFile 导出的默认层 ──────────────────────────────────────────────────
ok('ignoreFile 再导出默认清单（单一入口）', /export \{ DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_RULES \}/.test(ignoreFile))
ok('IG 模块可载入', !!IG.getVaultIgnore)

report('verify-vault-ignore')

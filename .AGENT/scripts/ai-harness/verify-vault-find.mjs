// 契约脚本：仓库查找 glob / 深度（P0-A `builtin.vault.find` / v3.31.0）
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: F, dir } = await loadTsModule(join(ROOT, 'electron/lib/vaultFindPure.ts'))

const m = (rel, type, pattern) => F.matchesFindPattern({ rel, type }, pattern)

// ── ① 通配符语义 ────────────────────────────────────────────────────────────────
ok('空模式全命中', m('a/b/c.md', 'file', '') === true)
ok('* 只在本段内', m('src/a.ts', 'file', '*.ts') === true && m('src/deep/a.ts', 'file', 'src/*.ts') === false)
ok('** 跨目录', m('src/deep/a.ts', 'file', 'src/**/*.ts') === true)
ok('** 零层也命中', m('src/a.ts', 'file', 'src/**/*.ts') === true)
ok('裸 ** 匹配任意', m('x/y/z.py', 'file', '**/*.py') === true)
ok('? 单字符', m('a1.md', 'file', 'a?.md') === true && m('a12.md', 'file', 'a?.md') === false)
ok('大小写不敏感', m('README.MD', 'file', 'readme.md') === true)
ok('不带 / 的模式只比文件名', m('deep/dir/a.md', 'file', 'a.md') === true)
ok('带 / 的模式比全路径', m('deep/dir/a.md', 'file', 'dir/a.md') === false)
ok('尾部 / 只匹配目录', m('docs/x.md', 'file', 'docs/') === false && m('docs', 'dir', 'docs/') === true)
ok('正则特殊字符按字面处理', m('a+b/c.md', 'file', 'a+b/*.md') === true && m('aab/c.md', 'file', 'a+b/*.md') === false)

// ── ② 深度 / 上限钳制 ───────────────────────────────────────────────────────────
ok('depth 缺省 8', F.clampFindDepth(undefined) === 8)
ok('depth 上限 20', F.clampFindDepth(999) === 20)
ok('depth 非法回落', F.clampFindDepth(-3) === 8)
ok('limit 缺省 500', F.clampFindLimit(undefined) === 500)
ok('limit 上限 2000', F.clampFindLimit(99999) === 2000)

// ── ③ 路径算术 ─────────────────────────────────────────────────────────────────
ok('父目录（有前缀）', F.parentDirOf('a/b/c.md') === 'a/b')
ok('父目录（根）', F.parentDirOf('c.md') === '')
ok('相对深度', F.depthUnder('a', 'a/b/c.md') === 2)
ok('相对深度（根）', F.depthUnder('', 'a/b.md') === 2)

rmSync(dir, { recursive: true, force: true })
report('verify-vault-find')

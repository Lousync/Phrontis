// 契约脚本：AI 文件策略（P0-A / v3.31.0）
// 覆盖：预设合并、读写允许/拒绝矩阵、密钥、点目录、收件箱例外、大小上限、仓库收窄。
// 规矩：直接载入真实 pure 模块（不复制规则），只构造入参。
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: P, dir } = await loadTsModule(join(ROOT, 'electron/lib/aiFilePolicyPure.ts'))

const DEFAULT = P.resolveAiFilePolicy(null)
const evalFile = (rel, op = 'read', extra = {}, policy = DEFAULT) => P.evaluateAiFile({ rel, op, ...extra }, policy)

// ── ① 预设与合并 ────────────────────────────────────────────────────────────────
ok('默认预设为 all-text', DEFAULT.preset === 'all-text')
ok('all-text 含配置类 json/yml/toml/ini', ['json', 'yml', 'toml', 'ini'].every((e) => P.AI_PRESET_WRITE_EXTS['all-text'].includes(e)))
ok('notes 只有笔记类', P.AI_PRESET_WRITE_EXTS.notes.join(',') === 'md,markdown,txt,text')
ok('notes+code 含 ts 不含 json', P.AI_PRESET_WRITE_EXTS['notes+code'].includes('ts') && !P.AI_PRESET_WRITE_EXTS['notes+code'].includes('json'))
const custom = P.resolveAiFilePolicy({ preset: 'custom', writeExts: ['.MD', 'json'] })
ok('custom 归一扩展名（去点、小写）', custom.writeExts.join(',') === 'md,json')
ok('custom 空名单回落默认预设', P.resolveAiFilePolicy({ preset: 'custom', writeExts: [] }).preset === 'all-text')
const narrowed = P.resolveAiFilePolicy({ preset: 'notes' })
ok('仓库覆盖可收窄预设', P.writableExtsOf(narrowed).has('md') && !P.writableExtsOf(narrowed).has('ts'))
ok('仓库覆盖不能把扩展名加回去（notes 预设下 json 不可写）', evalFile('a.json', 'write', {}, narrowed).allow === false)

// ── ② 读矩阵 ───────────────────────────────────────────────────────────────────
ok('读 .md 允许', evalFile('笔记/a.md').allow)
ok('读 .ts 允许', evalFile('src/a.ts').allow)
ok('读 .json 允许（配置类读放开）', evalFile('package.json').allow)
ok('读 .yml 允许', evalFile('config/app.yml').allow)
ok('读 .pdf 允许（文本提取）', evalFile('资料/a.pdf').allow)
ok('读 .png 拒绝', evalFile('img/a.png').allow === false)
ok('读 .exe 拒绝', evalFile('bin/a.exe').allow === false)

// ── ③ 写矩阵 ───────────────────────────────────────────────────────────────────
ok('写 .md 允许', evalFile('a.md', 'write').allow)
ok('写 .json 允许', evalFile('package.json', 'write').allow)
ok('写 .png 拒绝', evalFile('a.png', 'write').allow === false)
ok('notes 预设下写 .json 拒绝', evalFile('package.json', 'write', {}, narrowed).allow === false)
ok('写超 2MB 拒绝', evalFile('big.md', 'write', { size: 3 * 1024 * 1024 }).allow === false)
ok('读超 10MB 拒绝', evalFile('big.md', 'read', { size: 11 * 1024 * 1024 }).allow === false)

// ── ④ 硬拒绝：点目录 / 密钥 / 符号链接 / 二进制 / 越界 ───────────────────────────
ok('.git/config 拒绝', evalFile('.git/config', 'write').allow === false)
ok('.env 拒绝', evalFile('.env', 'write').allow === false)
ok('.attachments/a.md 拒绝', evalFile('.attachments/a.md', 'write').allow === false)
ok('.knowbase/modules/x.json 只读允许', evalFile('.knowbase/modules/x.json', 'read').allow)
ok('.knowbase/modules/x.json 不可写', evalFile('.knowbase/modules/x.json', 'write').allow === false)
ok('.knowbase/cache/a.json 不可读', evalFile('.knowbase/cache/a.json', 'read').allow === false)
ok('.knowbase/_inbox/a.md 可读写（收件箱例外）', evalFile('.knowbase/_inbox/a.md', 'read').allow && evalFile('.knowbase/_inbox/a.md', 'write').allow)
ok('收件箱只放行文本（png 拒绝）', evalFile('.knowbase/_inbox/a.png', 'write').allow === false)
ok('密钥 id_rsa 读也拒', evalFile('id_rsa').allow === false)
ok('密钥 server.pem 拒绝', evalFile('certs/server.pem', 'write').allow === false)
ok('credentials.json 拒绝', evalFile('credentials.json', 'write').allow === false)
ok('符号链接拒绝', evalFile('a.md', 'write', { isSymlink: true }).allow === false)
ok('二进制内容拒绝', evalFile('a.md', 'read', { binary: true }).allow === false)
ok('绝对路径拒绝', evalFile('/etc/passwd', 'read').allow === false)
ok('盘符路径拒绝', evalFile('C:/x/a.md', 'write').allow === false)
ok('.. 拒绝', evalFile('a/../../etc/passwd', 'read').allow === false)

// ── ⑤ 点目录白名单（仓库策略）──────────────────────────────────────────────────
const withDot = P.resolveAiFilePolicy({ allowDotDirs: ['.github'] })
ok('allowDotDirs 放行 .github/workflows', evalFile('.github/workflows/a.yml', 'write', {}, withDot).allow)
ok('allowDotDirs 不能放行 .git', P.resolveAiFilePolicy({ allowDotDirs: ['.git'] }).allowDotDirs.length === 0)
ok('.ssh 始终拒绝', evalFile('.ssh/config', 'write', {}, P.resolveAiFilePolicy({ allowDotDirs: ['.ssh'] })).allow === false)

// ── ⑥ denyPaths（仓库额外拒绝）────────────────────────────────────────────────
const denied = P.resolveAiFilePolicy({ denyPaths: ['草稿/', 'package-lock.json'] })
ok('denyPaths 目录前缀生效', evalFile('草稿/a.md', 'write', {}, denied).allow === false)
ok('denyPaths 基名生效', evalFile('package-lock.json', 'write', {}, denied).allow === false)
ok('denyPaths 不影响其它文件', evalFile('src/a.ts', 'write', {}, denied).allow)

// ── ⑦ 目录准入 ─────────────────────────────────────────────────────────────────
const dirPolicy = P.resolveAiFilePolicy(null)
ok('mkdir 普通目录允许', P.evaluateAiDir('新目录', dirPolicy).allow)
ok('mkdir .knowbase 拒绝', P.evaluateAiDir('.knowbase/x', dirPolicy).allow === false)
ok('mkdir 点目录拒绝', P.evaluateAiDir('.cache/x', dirPolicy).allow === false)
ok('mkdir 越界拒绝', P.evaluateAiDir('../x', dirPolicy).allow === false)

rmSync(dir, { recursive: true, force: true })
report('verify-ai-file-policy')

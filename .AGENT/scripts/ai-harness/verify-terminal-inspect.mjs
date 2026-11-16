// 契约脚本：终端只读通道 builtin.terminal.inspect（P1-2）
// 覆盖：命令白名单、参数白名单（git / rg / find / tail）、路径归一、超时与输出上限、接线（不走 shell）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: M } = await loadTsModule(join(ROOT, 'electron/lib/terminalInspectPure.ts'))

const call = (program, args) => M.validateInspectCall(program, args)

// ── ① 命令白名单 ──────────────────────────────────────────────────────────────
{
  const sample = { git: () => call('git', ['status']), pwd: () => call('pwd', []), which: () => call('which', ['node']) }
  ok('白名单命令可用', ['git', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'find', 'file', 'which', 'pwd']
    .every((p) => {
      const r = p === 'git' ? sample.git() : p === 'pwd' ? sample.pwd() : p === 'which' ? sample.which() : call(p, [])
      // 无参但要求路径的命令（cat / head / tail / wc / file / rg / find）会报缺参，这是预期；
      // 这里只验证「不是白名单拒绝」。
      return r.ok || !/白名单/.test(r.error)
    }))
  ok('未知命令拒绝', !call('rm', ['-rf', '.']).ok)
  ok('shell 命令名不能混进来', !call('bash', ['-c', 'echo hi']).ok && !call('sh', ['-c', 'x']).ok)
  ok('缺 program 拒绝', !call('', []).ok)
  ok('args 非数组拒绝', !call('ls', '-la').ok)
  ok('参数含换行拒绝（不支持多行脚本）', !call('ls', ['a\nb']).ok)
  ok('参数含 NUL 拒绝', !call('ls', ['a\u0000b']).ok)
}

// ── ② 路径归一 ────────────────────────────────────────────────────────────────
{
  ok('根路径归一为空', M.normalizeInspectRel('') === '' && M.normalizeInspectRel('.') === '' && M.normalizeInspectRel('./') === '')
  ok('去掉 ./ 与尾部斜杠', M.normalizeInspectRel('./src/') === 'src')
  ok('反斜杠归一', M.normalizeInspectRel('src\\lib\\a.ts') === 'src/lib/a.ts')
  ok('绝对路径拒绝', M.normalizeInspectRel('/etc/passwd') === null && M.normalizeInspectRel('C:\\Windows\\win.ini') === null)
  ok('.. 拒绝', M.normalizeInspectRel('../x') === null && M.normalizeInspectRel('a/../../../x') === null)
}
{
  ok('ls 绝对路径拒绝', !call('ls', ['/etc']).ok)
  ok('cat .. 拒绝', !call('cat', ['../secret']).ok)
  ok('head 绝对路径拒绝', !call('head', ['-n', '5', '/etc/passwd']).ok)
  ok('wc 绝对路径拒绝', !call('wc', ['-l', '/etc/passwd']).ok)
  ok('find 绝对路径拒绝', !call('find', ['/etc', '-name', 'passwd']).ok)
}

// ── ③ git 只读子命令 ──────────────────────────────────────────────────────────
{
  ok('git status 允许', call('git', ['status', '--short']).ok)
  ok('git diff / log / show 允许', call('git', ['diff']).ok && call('git', ['log', '--oneline']).ok && call('git', ['show', 'HEAD']).ok)
  ok('git 非只读子命令拒绝', !call('git', ['push']).ok && !call('git', ['checkout', '.']).ok && !call('git', ['config', 'user.name', 'x']).ok)
  ok('git --output 拒绝（会写文件）', !call('git', ['diff', '--output=/tmp/x']).ok)
  ok('git --no-index 拒绝（可读仓库外文件）', !call('git', ['diff', '--no-index', 'a', 'b']).ok)
  ok('git --ext-diff 拒绝', !call('git', ['diff', '--ext-diff']).ok)
  ok('git --textconv 拒绝', !call('git', ['show', '--textconv', 'HEAD']).ok)
  ok('git -- 之后的路径必须是仓库相对路径', !call('git', ['diff', '--', '../secret']).ok && call('git', ['diff', '--', 'src/a.ts']).ok)
  ok('git 参数不能是绝对路径', !call('git', ['show', '/etc/passwd']).ok)
}

// ── ④ rg 只读参数 ─────────────────────────────────────────────────────────────
{
  ok('rg 基本搜索允许', call('rg', ['TODO', 'src']).ok)
  ok('rg 常用只读 flag 允许', call('rg', ['-i', '-n', 'todo', 'src']).ok)
  ok('rg 缺模式拒绝', !call('rg', ['-i']).ok)
  ok('rg --pre 拒绝（会执行外部程序）', !call('rg', ['--pre', 'cat', 'todo']).ok)
  ok('rg -z / --search-zip 拒绝', !call('rg', ['-z', 'todo']).ok && !call('rg', ['--search-zip', 'todo']).ok)
  ok('rg --hidden / -u / --no-ignore 拒绝', !call('rg', ['--hidden', 'x']).ok && !call('rg', ['-u', 'x']).ok && !call('rg', ['--no-ignore', 'x']).ok)
  ok('rg -g / -t 拒绝（避免绕过扩展名白名单）', !call('rg', ['-g', '*', 'x']).ok && !call('rg', ['-t', 'js', 'x']).ok)
  ok('rg --follow 拒绝（防符号链接越界）', !call('rg', ['--follow', 'x']).ok)
  ok('rg 绝对路径 / .. 拒绝', !call('rg', ['x', '/etc']).ok && !call('rg', ['x', '../']).ok)
  ok('rg --files 模式允许无模式', call('rg', ['--files']).ok && call('rg', ['--files', 'src']).ok)
}

// ── ⑤ find / tail ─────────────────────────────────────────────────────────────
{
  ok('find 常用写法允许', call('find', ['.', '-name', '*.ts', '-type', 'f', '-maxdepth', '3']).ok)
  ok('find -exec 拒绝', !call('find', ['.', '-exec', 'rm', '{}', ';']).ok)
  ok('find -delete 拒绝', !call('find', ['.', '-delete']).ok)
  ok('find -fprint 拒绝（会写文件）', !call('find', ['.', '-fprint', '/tmp/x']).ok)
  ok('tail -f 拒绝', !call('tail', ['-f', 'a.log']).ok)
  ok('pwd 不接受参数', !call('pwd', ['x']).ok)
  ok('which 需要程序名', !call('which', []).ok)
  ok('cat / file 需要路径', !call('cat', []).ok && !call('file', []).ok)
}

// ── ⑥ 超时 / 输出上限 ─────────────────────────────────────────────────────────
{
  ok('超时默认 15s', M.clampInspectTimeout(undefined) === 15000)
  ok('超时下限 1s', M.clampInspectTimeout(10) === 1000)
  ok('超时上限 60s', M.clampInspectTimeout(999999) === 60000)
  const t = M.truncateInspectOutput('x'.repeat(9000))
  ok('输出截断并标注总长度', t.truncated && t.text.includes('输出已截断') && t.text.length < 9000)
  ok('短输出不截断', !M.truncateInspectOutput('ok').truncated)
}

// ── ⑦ 接线（源码断言）─────────────────────────────────────────────────────────
const impl = readFileSync(join(ROOT, 'electron/lib/terminalInspect.ts'), 'utf8')
ok('外部命令 spawn 直呼 argv、明确 shell:false', /spawn\(file, args, \{[^}]*shell: false/.test(impl))
ok('git 关闭分页器与 textconv', /--no-pager/.test(impl) && /--no-textconv/.test(impl))
ok('rg 只搜索 AI 可读文本扩展名', /TEXT_VIEWABLE_EXTS/.test(impl) && /globs\.push\('-g'/.test(impl))
ok('文件路径过 AI 文件策略与作用域', /evaluateAiFile\(\{ rel, op: 'read'/.test(impl) && /assertCanRead\(rel, ctx\)/.test(impl))
ok('作用域收窄时拒绝整仓命令', /scopeOf\(ctx\)/.test(impl) && /不能运行 git \/ rg/.test(impl))
ok('输出失控保险丝', /INSPECT_RAW_CAP/.test(impl) && /killChild\(child\)/.test(impl))

const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('工具已注册：readOnly + requires read + vaultFile read + ondemand', /name: 'builtin\.terminal\.inspect'/.test(bt)
  && /readOnly: true,[\s\S]{0,200}requires: 'read'/.test(bt) && /vaultFile: 'read'/.test(bt) && /tier: 'ondemand'/.test(bt))
ok('工具实现走 aiInspect', /aiInspect\(args, ctx\)/.test(bt))
ok('tool.request 的终端信任闸也只拦 requires=write', /t\.module === 'terminal' && \(t\.requires \?\? 'read'\) === 'write'/.test(bt))

const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('终端写闸只拦 requires=write（只读通道在规划模式可用）', /t\.module === 'terminal' && \(t\.requires \?\? 'read'\) === 'write'/.test(svc))
ok('扩展工具提示提到只读通道', /builtin\.terminal\.inspect/.test(svc))
const labels = readFileSync(join(ROOT, 'src/lib/toolLabels.ts'), 'utf8')
ok('过程气泡有中文动作标签', /builtin\.terminal\.inspect': '只读查看'/.test(labels))

report('终端只读通道 builtin.terminal.inspect（P1-2）')

// 契约脚本：仓库规则文件（P1-6）
// 覆盖：相对目录归一、目录裁剪、去重 / 截断 / 总量上限、真实磁盘读取、agentService 接线、设置开关。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: R } = await loadTsModule(join(ROOT, 'electron/lib/repoRulesPure.ts'))
const { mod: F } = await loadTsModule(join(ROOT, 'electron/lib/repoRules.ts'))

// ── ① 目录归一 ────────────────────────────────────────────────────────────────
{
  ok('根目录 / 空串归一为根', R.normalizeRelDir('') === '' && R.normalizeRelDir('.') === '')
  ok('去掉 ./ 与尾部斜杠', R.normalizeRelDir('./src/lib/') === 'src/lib')
  ok('反斜杠归一', R.normalizeRelDir('src\\lib') === 'src/lib')
  ok('拒绝绝对路径 / 盘符', R.normalizeRelDir('/etc') === null && R.normalizeRelDir('C:\\Windows') === null)
  ok('拒绝越界', R.normalizeRelDir('src/../..') === null && R.normalizeRelDir('../out') === null)
  ok('拒绝点目录（.git / .knowbase / .assistant）', R.normalizeRelDir('.git') === null && R.normalizeRelDir('src/.hidden') === null)
}
{
  const dirs = R.normalizeRuleDirs(['', 'src/lib', 'src', 'src/lib', './'])
  ok('浅 → 深、去重、根在首位', JSON.stringify(dirs) === JSON.stringify(['', 'src', 'src/lib']))
  const many = Array.from({ length: 12 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `d${j}`).join('/'))
  const clipped = R.normalizeRuleDirs(many)
  ok('超过上限只保留根 + 最深的几层', clipped.length === R.MAX_RULE_DIRS && clipped[0] === '')
  ok('保留的是最深目录', clipped[clipped.length - 1] === many[many.length - 1])
  ok('非法目录被丢弃', JSON.stringify(R.normalizeRuleDirs(['.git', '..', 'ok'])) === JSON.stringify(['', 'ok']))
}

// ── ② 文案拼装 ────────────────────────────────────────────────────────────────
{
  ok('没有规则文件 → 空串', R.renderRepoRulesHint([]) === '')
  const hint = R.renderRepoRulesHint([
    { dir: '', name: 'AGENTS.md', text: '根规则' },
    { dir: 'src/lib', name: 'CLAUDE.md', text: '模块规则' },
  ])
  ok('根规则与子目录规则都出现', hint.includes('【仓库规则 · AGENTS.md】') && hint.includes('【仓库规则 · src/lib/CLAUDE.md（更具体，优先）】'))
  ok('说明优先级', /更具体者为准/.test(hint) && /用户 \/ 助手要求为准/.test(hint))
  ok('空文件跳过', R.renderRepoRulesHint([{ dir: '', name: 'AGENTS.md', text: '  \n ' }]) === '')
  ok('不认识的文件名跳过', R.renderRepoRulesHint([{ dir: '', name: 'README.md', text: 'x' }]) === '')
  ok('点目录里的规则跳过', R.renderRepoRulesHint([{ dir: '.git', name: 'AGENTS.md', text: 'x' }]) === '')
  const dup = R.renderRepoRulesHint([
    { dir: '', name: 'AGENTS.md', text: '同一份' },
    { dir: '', name: 'CLAUDE.md', text: '同一份' },
  ])
  ok('相同正文只注入一次', (dup.match(/同一份/g) ?? []).length === 1)
}
{
  const huge = 'x'.repeat(5000)
  const one = R.renderRepoRulesHint([{ dir: '', name: 'AGENTS.md', text: huge }])
  ok('单文件截断到 4000 字', one.includes('规则文件过长，已截断') && !one.includes('x'.repeat(R.MAX_RULE_FILE_CHARS + 1)))
  const many = R.renderRepoRulesHint(Array.from({ length: 5 }, (_, i) => ({
    dir: `d${i}`, name: 'AGENTS.md', text: String(i).repeat(5000),
  })))
  ok('总量超限时截断', many.includes('仓库规则总量超限，已截断'))
  const bodyLen = many.length - many.indexOf('【仓库规则')
  ok('总量接近但不超过上限（含标题与截断标注）', bodyLen < R.MAX_REPO_RULES_CHARS + 1200)
  const bom = R.renderRepoRulesHint([{ dir: '', name: 'AGENTS.md', text: '\uFEFF规则' }])
  ok('BOM 被剥掉', !bom.includes('\uFEFF') && bom.includes('规则'))
}

// ── ③ 真实磁盘读取 ────────────────────────────────────────────────────────────
{
  const root = mkdtempSync(join(ROOT, 'tmp', 'kb-repo-rules-'))
  try {
    writeFileSync(join(root, 'AGENTS.md'), '根目录规则\n', 'utf-8')
    mkdirSync(join(root, 'src', 'lib'), { recursive: true })
    writeFileSync(join(root, 'src', 'lib', 'CLAUDE.md'), '模块规则\n', 'utf-8')
    writeFileSync(join(root, 'src', 'lib', 'a.md'), '# 普通文件\n', 'utf-8')
    mkdirSync(join(root, 'src', 'lib', 'deep'), { recursive: true })
    writeFileSync(join(root, 'src', 'lib', 'deep', 'AGENTS.md'), '更深一层\n', 'utf-8')

    const dirs = F.ruleDirsForScopePaths(root, ['src/lib/a.md'])
    ok('文件条目取所在目录 + 祖先', JSON.stringify(dirs) === JSON.stringify(['', 'src', 'src/lib']))
    const dirDirs = F.ruleDirsForScopePaths(root, ['src/lib/deep'])
    ok('目录条目包含自身', dirDirs.includes('src/lib/deep'))
    ok('不在作用域路径上的目录不读', !dirDirs.includes('src/lib/deep/other'))

    const hint = F.readRepoRulesFrom(root, ['', 'src/lib', 'src/lib/deep'])
    ok('磁盘读取顺序 = 根 → 深', hint.indexOf('根目录规则') < hint.indexOf('模块规则') && hint.indexOf('模块规则') < hint.indexOf('更深一层'))
    ok('没有规则文件的目录不产生空段', !hint.includes('【仓库规则 · src/】'))
    ok('rootPath 为空 → 空串', F.readRepoRulesFrom(null, ['']) === '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── ④ 接线与开关 ──────────────────────────────────────────────────────────────
const svc = (await import('node:fs')).readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('agentService 导入读取器', /import \{ readRepoRulesFrom, ruleDirsForScopePaths \} from '\.\/repoRules'/.test(svc))
ok('开关：关掉不注入', /getSettingReader\(\)\('agentInjectRepoRules'\) === false/.test(svc))
ok('根目录恒读', /: \[''\]\n    return readRepoRulesFrom/.test(svc))
ok('缩窄作用域时读目录规则', /unifiedAssistant && !scopeAll && aiScope && aiScope\.length > 0/.test(svc))
ok('规则段位于助手要求之前（助手要求更优先）', /scopeInstHint \+ repoRulesHint \+ assistantConstraintHint/.test(svc))
ok('手册通道不注入', /if \(manual\) return ''/.test(svc))

const settings = (await import('node:fs')).readFileSync(join(ROOT, 'src/lib/settings.ts'), 'utf8')
ok('设置项默认开启', /agentInjectRepoRules: \{ default: true, type: 'toggle'/.test(settings))
ok('设置项在 Agent 循环分组且可搜索', /agentInjectRepoRules:[\s\S]*?group: 'Agent 循环'[\s\S]*?ui: true/.test(settings))

const fsMod = (await import('node:fs')).readFileSync(join(ROOT, 'electron/lib/repoRules.ts'), 'utf8')
ok('只读 AGENTS.md / CLAUDE.md', /RULE_FILE_NAMES/.test(fsMod) && /MAX_RULE_FILE_BYTES = 512 \* 1024/.test(fsMod))
ok('读不到不打断对话', /读不到就跳过/.test(fsMod))

report('仓库规则文件（P1-6）')

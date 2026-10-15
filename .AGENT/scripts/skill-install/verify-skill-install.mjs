#!/usr/bin/env node
/**
 * Skill 安装契约（2026-10-13）。
 *
 * 钉两件事：
 *   1) **决策 F「只装根目录那个」**：入口定位规则（根目录优先 → 恰好一个顶层目录才退让 →
 *      多个就直接报错）。此前是"取第一个命中的"，顺序取决于 zip 条目 / 目录遍历顺序 ——
 *      等于随机装一个，而用户看到的是"安装成功"。
 *   2) **文件夹安装这条路径是通的**：原先唯一的独立安装入口是个"拖入 .zip"的拖拽区，
 *      而 src/App.tsx 在 document 捕获阶段把任何 .zip 拖放都吃掉去开备份恢复弹窗了，
 *      所以那个区从来没收到过事件（界面和 AI 手册却在教用户拖进去）。
 *
 * 跑法：node .AGENT/scripts/skill-install/verify-skill-install.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSkillEntry, SKILL_ENTRY_NAMES } from '../../../electron/lib/skillPackPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

// ===== 1. 入口定位 =====

console.log('\n[入口定位] resolveSkillEntry')
eq('根目录 SKILL.md 优先，prefix 为空',
  resolveSkillEntry(['SKILL.md', 'scripts/run.md'], '包'), { ok: true, entryPath: 'SKILL.md', prefix: '' })
eq('根目录没有 SKILL.md 时认 skill.json',
  resolveSkillEntry(['skill.json', 'a.md'], '包'), { ok: true, entryPath: 'skill.json', prefix: '' })
eq('根目录同时有两者时优先 SKILL.md',
  resolveSkillEntry(['skill.json', 'SKILL.md'], '包'), { ok: true, entryPath: 'SKILL.md', prefix: '' })
eq('只有一个顶层目录含入口 → 退让到它（系统压缩工具默认多套一层）',
  resolveSkillEntry(['我的技能/SKILL.md', '我的技能/a.md'], '包'),
  { ok: true, entryPath: '我的技能/SKILL.md', prefix: '我的技能/' })
eq('同一顶层目录下两者并存 → 优先 SKILL.md',
  resolveSkillEntry(['x/skill.json', 'x/SKILL.md'], '包'),
  { ok: true, entryPath: 'x/SKILL.md', prefix: 'x/' })

console.log('\n[决策 F] 多个 Skill 时必须报错，不许随机挑一个')
const two = resolveSkillEntry(['带带/SKILL.md', '查词/SKILL.md', '带带/a.md'], '文件夹')
check('两个 Skill 目录 → 不返回 ok', two.ok === false)
check('错误里点出有几个目录', !two.ok && /检测到 2 个 Skill 目录/.test(two.error), !two.ok ? two.error : '')
check('错误里列出目录名（用户才知道该选哪个）', !two.ok && two.error.includes('带带') && two.error.includes('查词'))
check('错误文案用「文件夹」而不是「包」（按来源用词）',
  !two.ok && two.error.includes('一个文件夹只能装一个'))
check('同一份输入换成包来源 → 用「包」这个词',
  (() => { const r = resolveSkillEntry(['a/SKILL.md', 'b/SKILL.md'], '包'); return !r.ok && r.error.includes('一个包只能装一个') })())
check('顺序无关：倒过来也是报错（不是"取第一个"）',
  resolveSkillEntry(['查词/SKILL.md', '带带/SKILL.md'], '文件夹').ok === false)
check('三个及以上同样报错',
  resolveSkillEntry(['a/SKILL.md', 'b/SKILL.md', 'c/skill.json'], '文件夹').ok === false)

console.log('\n[边界] 路径归一化与错误文案')
eq('反斜杠路径（zip 条目可能是 Windows 分隔符）也算单层',
  resolveSkillEntry(['my-skill\\SKILL.md', 'my-skill\\a.md'], '包'),
  { ok: true, entryPath: 'my-skill\\SKILL.md', prefix: 'my-skill/' })
check('entryPath 返回原始键（含反斜杠），调用方才能直接从文件表取到内容',
  (() => { const r = resolveSkillEntry(['my-skill\\SKILL.md'], '包'); return r.ok && r.entryPath === 'my-skill\\SKILL.md' })())
check('prefix 是归一化后的（含正斜杠），调用方按 / 归一化后切片',
  (() => { const r = resolveSkillEntry(['my-skill\\SKILL.md'], '包'); return r.ok && r.prefix === 'my-skill/' })())
check('嵌套两层不算单层顶层（不做无限退让）',
  resolveSkillEntry(['a/b/SKILL.md'], '包').ok === false)
check('完全没有入口 → 报错并给出该怎么办',
  (() => { const r = resolveSkillEntry(['readme.md', 'src/x.ts'], '文件夹'); return !r.ok && /没有 SKILL.md 或 skill.json/.test(r.error) && /请选中 Skill 自身的文件夹/.test(r.error) })())
check('空输入 → 报错不抛',
  resolveSkillEntry([], '包').ok === false)
check('入口名单只认这两个',
  SKILL_ENTRY_NAMES.length === 2 && SKILL_ENTRY_NAMES[0] === 'SKILL.md' && SKILL_ENTRY_NAMES[1] === 'skill.json')

// ===== 2. 接线 =====

console.log('\n[接线] 主进程')
const svc = read('electron/lib/skillService.ts')
check('skillService 用零依赖模块做入口定位（而不是自己再写一遍）',
  svc.includes("from './skillPackPure'") && svc.includes('resolveSkillEntry(files.keys(), unit)'))
check('已删除"取第一个命中的"旧逻辑', !svc.includes('for (const p of files.keys())'))
check('新增 installSkillFromDirectory', svc.includes('function installSkillFromDirectory'))
check('新增 readDirAsFileMap（文件夹 → 文件表）', svc.includes('function readDirAsFileMap'))
check('文件夹遍历跳过点目录（.git / .tmp-* 不该进 Skill）', svc.includes("ent.name.startsWith('.')"))
check('文件夹遍历跳过非普通文件（符号链接等）', svc.includes('if (!ent.isFile()) continue'))
check('文件夹遍历有深度上限', svc.includes('MAX_SKILL_DIR_DEPTH'))
check('文件夹安装同样受 8MB / 文件数上限约束',
  /function readDirAsFileMap[\s\S]*MAX_SKILL_FILES[\s\S]*MAX_SKILL_BYTES/.test(svc))
check('注册了 aiTools:installSkillFromFolder', svc.includes("ipcMain.handle('aiTools:installSkillFromFolder'"))
check('文件夹对话框用 openDirectory', /installSkillFromFolder[\s\S]{0,400}properties: \['openDirectory'\]/.test(svc))
check('zip 路径的行为没变（只有入口一个条目仍然拒绝）', svc.includes("if (files.size <= 1) return { success: false, message: 'Skill 包内容为空（缺少提示词）' }"))

console.log('\n[接线] 桥与类型')
check('preload 暴露了 installSkillFromFolder',
  read('electron/preload/index.ts').includes("ipcRenderer.invoke('aiTools:installSkillFromFolder')"))
check('ElectronAPI 类型里有它', read('src/types/index.ts').includes('aiToolsInstallSkillFromFolder:'))
check('ipc.ts 有包装函数', read('src/lib/ipc.ts').includes('export const aiToolsInstallSkillFromFolder'))

console.log('\n[接线] 界面：死掉的拖拽区已撤，换成可点的文件夹安装')
const view = read('src/modules/settings/views/AiToolsView.tsx')
check('新增「选择文件夹安装」按钮', view.includes('选择文件夹安装'))
check('调的是文件夹安装 IPC', view.includes('aiToolsInstallSkillFromFolder()'))
check('拖拽区（onDrop / dragOver）已撤掉',
  !view.includes('onDrop={handleDrop}') && !view.includes('const [dragOver'))
// 只查**用户可见文案**是否撤净（注释里留着"这里原本是个拖拽区"的来龙去脉是故意的，
// 删掉注释等于把这段踩坑史也删了）
const DEAD_COPY = ['拖入 Skill 包', '释放以安装', '可拖入 zip 独立安装', '拖入 zip 独立安装', '到此处，或点击选择文件']
const leftover = DEAD_COPY.filter(s => view.includes(s))
check('不再教用户"拖入 .zip"（用户可见文案已撤净）', leftover.length === 0, leftover.join(' / '))
check('保留一条说明来龙去脉的注释（别再手滑加回拖拽区）', view.includes('从来没收到过事件'))
check('.zip 包作为次要入口保留（能力没丢）', view.includes('aiToolsInstallSkillFromFile()'))
// 2026-10-13 文案减负 + 语气升级：这句从卡片里的一段话压成一行、措辞也改过两次。
// 断言只锁**内容要点**（提到"多个 Skill"、并且"要求指定其中一个"），不锁某一句原话 ——
// 否则每次改文案都要动契约，契约就成了文案的副本。
check('界面说明了"多个 Skill 时不会替你挑"', view.includes('包含多个 Skill') && view.includes('要求指定其中一个'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)

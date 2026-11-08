// 契约验证：phrontis-core 宿主注入必须发生在「开发版数据隔离 setPath」之后。
//
// 背景（2026-11-07 探针实测）：kbcore 抽取（2026-11-01）把 data/vaults.json 与 globalJsonStore
// 的读取收进 core（configureCore 注入的 userDataDir）。若 configureCore 在 app.setPath 之前调用，
// dev / 探针实例会解析到**全局目录**的 vault 注册表 —— 表象是 dev 实例打开全局注册的真实仓库，
// 探针隔离 userData 形同虚设（且 dev 与正式版数据互相污染）。
//
// 运行（项目根目录）：
//   node .AGENT/scripts/vault-list/verify-core-configure-order.mjs
// 期望：输出 PASS 且 exit=0

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const proj = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const src = readFileSync(join(proj, 'electron/main/index.ts'), 'utf8')

let pass = true
const check = (name, ok) => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}

const setPathIdx = src.indexOf("app.setPath('userData', devDir)")
const configureIdx = src.indexOf('configureCore({ userDataDir:')
const isolationIdx = src.indexOf('app.isPackaged')

check('找到隔离分支（app.isPackaged 门控）', isolationIdx > -1)
check("找到隔离落点 app.setPath('userData', devDir)", setPathIdx > -1)
check('找到 configureCore 注入调用', configureIdx > -1)
if (setPathIdx > -1 && configureIdx > -1) {
  check('configureCore 在隔离 setPath 之后（core 全局域必须随隔离目录）', configureIdx > setPathIdx)
}
check('configureCore 不再出现在隔离分支之前的模块顶层',
  src.slice(0, src.indexOf('// ===== 数据隔离')).indexOf('configureCore({') === -1)

console.log(`\n${pass ? 'PASS' : 'FAIL'}: core configure order contract`)
process.exit(pass ? 0 : 1)

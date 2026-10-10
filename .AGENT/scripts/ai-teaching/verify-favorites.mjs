#!/usr/bin/env node
/**
 * AI教学 · 左栏「收藏」契约：全链路接线断言。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-favorites.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[后端] aiTeachingFavorites.ts')
const be = read('electron/lib/aiTeachingFavorites.ts')
check('存储 = modules/aiTeaching/favorites.json（随仓库走）', be.includes("MODULE = 'modules/aiTeaching'") && be.includes("KEY = 'favorites.json'"))
check('按工作区分组 byWs', be.includes('byWs: Record<string, AiTeachFavorite[]>'))
check('rel = 仓库相对路径 + addedAt 倒序', be.includes('unshift(') && be.includes('addedAt'))
check('三个业务函数', ['listFavorites', 'addFavorite', 'removeFavorite'].every((s) => be.includes(`export function ${s}`)))
check('注册 3 个 handler', ['aiTeachFav:list', 'aiTeachFav:add', 'aiTeachFav:remove'].every((s) => be.includes(s)))

console.log('\n[接线] main / preload / types / ipc')
check('main 引入并注册', read('electron/main/index.ts').includes('registerAiTeachingFavoriteHandlers'))
check('preload 三通道', ['aiTeachFavList', 'aiTeachFavAdd', 'aiTeachFavRemove'].every((s) => read('electron/preload/index.ts').includes(s)))
check('types: AiTeachFavorite + 三方法', read('src/types/index.ts').includes('export interface AiTeachFavorite') && read('src/types/index.ts').includes('aiTeachFavList:'))
check('ipc.ts 三封装', ['aiTeachFavList', 'aiTeachFavAdd', 'aiTeachFavRemove'].every((s) => read('src/lib/ipc.ts').includes(`export const ${s}`)))

console.log('\n[渲染层] index.tsx / AiTeachFileTree.tsx')
const idx = read('src/modules/ai-teaching/index.tsx')
check('收藏 state + 载入', idx.includes('const [favorites, setFavorites]') && idx.includes('aiTeachFavList(ws)'))
check('togglePin / isPinned（稳定回调）', idx.includes('const togglePin = useCallback') && idx.includes('const isPinned = useCallback'))
check('左栏顶部细行（0 条隐藏）', idx.includes('{favorites.length > 0 && (') && idx.includes('收藏</span>'))
check('收藏项点击 openArtFile 打开', idx.includes('openArtFile(f.rel, { name: f.name })'))
check('「已生成文档」旁可钉', idx.includes("isPinned(rel)") && idx.includes('void togglePin(rel, rel.split'))
check('传给资源管理器', idx.includes('isPinned={isPinned}') && idx.includes('onTogglePin={togglePin}'))
const tree = read('src/modules/ai-teaching/AiTeachFileTree.tsx')
check('资源管理器右键「钉到收藏 / 取消收藏」', tree.includes('★ 钉到收藏') && tree.includes('取消收藏') && tree.includes('isPinned?.(repoRel)'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)

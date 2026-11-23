#!/usr/bin/env node
/**
 * 契约：AI 教学产物「原地修改」的边界与文本补丁（2026-11-17）。
 *
 * 背景：改一张示意图时 AI 总是新建 `-v2`，用户要的是直接在原文件上改。
 * 落盘覆盖 / relPath 原地改 / artifact.edit 都依赖两件事：
 *   ① 目标路径只能落在**本会话产物目录**里（不能借机改用户笔记 / SOURCES / 点目录）；
 *   ② 多段替换必须「全部命中才落盘」，否则会留下改一半的产物。
 * 这两条都是纯函数，直接 import 跑用例（读源码正则锁不住边界）。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-artifact-inplace.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_EDIT_EXTS, MAX_ARTIFACT_EDIT_BYTES, MAX_ARTIFACT_EDITS,
  normalizeArtifactRel, resolveProductFileRel, applyArtifactEdits,
} from '../../../electron/lib/aiTeachingArtifactPure.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}
const SESSION = 'AI教学/接口备考/第1章 基础/段2'

console.log('=== A. 路径归一 / 边界 ===')
{
  const a = normalizeArtifactRel('AI教学/接口备考/第1章 基础/段2/visuals/a.html')
  ok('rel' in a && a.rel === 'AI教学/接口备考/第1章 基础/段2/visuals/a.html', 'A1 正常仓库相对路径原样通过')
  ok('error' in normalizeArtifactRel(''), 'A2 空路径拒绝')
  ok('error' in normalizeArtifactRel('../etc/passwd'), 'A3 含 .. 拒绝')
  ok('error' in normalizeArtifactRel('C:/Windows/win.ini'), 'A4 盘符绝对路径拒绝')
  ok('error' in normalizeArtifactRel(SESSION + '/visuals/.hidden.html'), 'A5 点文件拒绝')
  ok('error' in normalizeArtifactRel('SOURCES/a.html'), 'A6 SOURCES/ 拒绝')
  ok('error' in normalizeArtifactRel(SESSION + '/.knowbase/a.html'), 'A7 点目录拒绝')
}

console.log('\n=== B. 产物目录收敛 ===')
{
  const hit = resolveProductFileRel(SESSION, SESSION + '/visuals/a.html', 'visuals', ['html'])
  ok('rel' in hit, 'B1 本会话 visuals/ 直接文件通过')
  ok('error' in resolveProductFileRel(SESSION, 'AI教学/接口备考/第1章 基础/段3/visuals/a.html', 'visuals', ['html']),
    'B2 跨会话拒绝')
  ok('error' in resolveProductFileRel(SESSION, SESSION + '/visuals/sub/a.html', 'visuals', ['html']),
    'B3 visuals/ 子目录拒绝')
  ok('error' in resolveProductFileRel(SESSION, SESSION + '/visuals/a.png', 'visuals', ['html']),
    'B4 扩展名不符拒绝')
  ok('error' in resolveProductFileRel(SESSION, SESSION + '/mindmaps/a.html', 'visuals', ['html']),
    'B5 目录不符拒绝')
  ok('rel' in resolveProductFileRel(SESSION, SESSION + '/outputs/a.png', 'outputs', ['png', 'jpg', 'jpeg', 'webp']),
    'B6 outputs/ 图片覆盖通过')
}

console.log('\n=== C. 多段替换 / 追加 ===')
{
  const src = '<svg><text>开口大小</text><text>顶点</text></svg>'
  const one = applyArtifactEdits(src, [{ oldText: '开口大小', newText: '开口变小' }], '')
  ok(one.ok && one.next.includes('开口变小') && one.changed === 1, 'C1 单段替换')

  const two = applyArtifactEdits(src, [
    { oldText: '开口大小', newText: '开口变小' },
    { oldText: '顶点', newText: '顶点 (h,k)' },
  ], '')
  ok(two.ok && two.next.includes('开口变小') && two.next.includes('顶点 (h,k)') && two.changed === 2,
    'C2 多段替换（按顺序应用）')

  const dup = applyArtifactEdits('<b>x</b><b>x</b>', [{ oldText: 'x', newText: 'y' }], '')
  ok(!dup.ok && dup.error.includes('多处'), 'C3 原文命中多处 → 拒绝')

  const miss = applyArtifactEdits(src, [{ oldText: '不存在', newText: 'y' }], '')
  ok(!miss.ok && miss.error.includes('未找到'), 'C4 原文不存在 → 拒绝')

  const emptyOld = applyArtifactEdits(src, [{ oldText: '', newText: 'y' }], '')
  ok(!emptyOld.ok, 'C5 oldText 为空 → 拒绝')

  const del = applyArtifactEdits(src, [{ oldText: '<text>顶点</text>', newText: '' }], '')
  ok(del.ok && !del.next.includes('顶点'), 'C6 newText 空串 = 删除片段')

  const appended = applyArtifactEdits('<p>正文</p>\n\n', [], '补充说明')
  ok(appended.ok && appended.next === '<p>正文</p>\n补充说明\n', 'C7 append 去掉文末空白后追加')

  const allOrNothing = applyArtifactEdits(src, [
    { oldText: '开口大小', newText: '开口变小' },
    { oldText: '不存在', newText: 'y' },
  ], '')
  ok(!allOrNothing.ok && !('next' in allOrNothing), 'C8 有任一组失败 → 不返回新文本（全有或全无）')

  const both = applyArtifactEdits('<p>正文</p>', [{ oldText: '正文', newText: '新正文' }], '结尾')
  ok(both.ok && both.changed === 2 && both.next === '<p>新正文</p>\n结尾\n', 'C9 edits 与 append 并用')

  const none = applyArtifactEdits(src, [], '')
  ok(!none.ok, 'C10 edits / append 都没给 → 拒绝')

  const tooMany = applyArtifactEdits(src, Array.from({ length: MAX_ARTIFACT_EDITS + 1 }, (_, i) => ({ oldText: 'x' + i, newText: 'y' })), '')
  ok(!tooMany.ok && tooMany.error.includes('最多'), 'C11 超过组数上限 → 拒绝')
}

console.log('\n=== D. 常量口径 ===')
ok(ARTIFACT_EDIT_EXTS.join(',') === 'html,json,md', 'D1 只改文本类产物')
ok(MAX_ARTIFACT_EDIT_BYTES === 1024 * 1024, 'D2 大小上限 1MB')
ok(MAX_ARTIFACT_EDITS === 10, 'D3 单次最多 10 组替换')

console.log('\n=== E. 渲染侧原地刷新（2026-11-23 工件栏 → 查看器 file 页签） ===')
{
  // 原地改产物在渲染侧只有两条出口：壳的 commitArtifact（同路径不新开）+ 文件页签自己订阅外部写。
  // 这两条都在纯函数之外，只能静态断言接线；缺任一条的表象是「改完还是旧图 / 旧讲义」。
  const shell = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/right-viewer/RightViewer.tsx'), 'utf8')
  const filePane = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/right-viewer/FilePane.tsx'), 'utf8')
  const notesPane = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/right-viewer/NotesPane.tsx'), 'utf8')
  const vtabs = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/right-viewer/viewerTabs.ts'), 'utf8')
  ok(/const formal = findFileTab\(tabsRef\.current, rel\)/.test(shell)
    && /const closed = closeTabById\(tabsRef\.current, activeIdRef\.current, ph\.id\)/.test(shell)
    && /apply\(closed\.tabs, formal\.id\)/.test(shell),
    'E1 同 relPath 已有正式页签 → 删占位并聚焦已有（不新开第二份）')
  ok(/patchTab\(formal\.id, \{\s*rev: \(formal\.rev \?\? 0\) \+ 1/.test(shell),
    'E2 聚焦已有页签时 bump rev，查看器重读磁盘')
  ok(/rev: \(t\.rev \?\? 0\) \+ 1/.test(shell) && shell.includes('原地转正：`generating` / `slug` 必须摘掉'),
    'E3 占位原地转正式：摘掉 generating / slug 并 bump rev')
  ok(/onWsExternalChange\(\(p\) => \{[\s\S]{0,200}?bump\(\)/.test(filePane)
    && /addEventListener\('kb:file-saved', onSaved\)/.test(filePane),
    'E4 文件页签自己订阅 ws:external-change + kb:file-saved（外部写原地重读）')
  ok(/onWsExternalChange\(\(\) => scheduleRescan\(\)\)/.test(notesPane)
    && /addEventListener\('kb:file-saved', onSaved\)/.test(notesPane),
    'E5 笔记页签的既有外部变更订阅未被改坏')
  ok(/function isGeneratingFileTab\(tab: ViewerTab\)/.test(vtabs)
    && /!isGeneratingFileTab\(t\)/.test(vtabs),
    'E6 生成中占位不落持久化（重启不残留禁关页签）')
  ok(!shell.includes('ArtifactsPane') && !shell.includes('artTabs'),
    'E7 负向：查看器壳不再挂工件栏页签数组')
  const chrome = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/right-viewer/ViewerChrome.tsx'), 'utf8')
  ok(/const canClose = !\(tab\.type === 'file' && tab\.generating\)/.test(chrome)
    && /canClose && \(/.test(chrome),
    'E8 生成中占位禁关（✕ 不渲染）')
  ok(/tab\.type === 'file' && tab\.generating\) \|\| closeTimersRef\.current\.has\(id\)/.test(shell),
    'E9 壳的 closeTab 也拒绝关闭生成中占位（中键 / 菜单路径）')
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}

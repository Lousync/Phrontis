#!/usr/bin/env node
/**
 * Contract: AI teaching "tutor" (conversation) mode - pure routing + protocol prompts + wiring.
 *
 * Plan: docs/ai-teaching-tutor-mode-plan.md (section 2 frozen interfaces).
 * Covers:
 *   1. src/lib/tutorModePure.ts   - resolveTutorMode (auto routing) + labels
 *   2. electron/lib/aiTeachingTutorPrompt.ts - chat/ask/solve/read protocol hints + reading injection cap
 *   3. source wiring: session flag, folder path/anchor, IPC channel, request fields, system injection
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-tutor-mode.mjs
 * Output is pure ASCII (no emoji).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`)
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-mode-'))
async function loadTs(rel, outName) {
  const file = path.join(tmpDir, outName)
  fs.writeFileSync(file, stripTypeScriptTypes(read(rel), { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

// ------------------------------------------------------------------ 1. routing pure function
const routeRel = 'src/lib/tutorModePure.ts'
const routeSrc = read(routeRel)
console.log(`\n[1] ${routeRel}`)
const route = await loadTs(routeRel, 'tutorModePure.mjs')

const cases = [
  // [text, hasImages, hasMaterial, readingQuestion, expected]
  ['', false, false, false, 'chat'],
  ['帮我解一下这张图', true, false, false, 'solve'],
  ['求函数 y=x^2 的导数', false, false, false, 'solve'],
  ['请证明勾股定理', false, false, false, 'solve'],
  ['这道题怎么算', false, false, false, 'solve'],
  ['这页讲的是什么？', false, true, false, 'read'],
  ['给我讲讲这段原文', false, true, false, 'read'],
  ['这页讲的是什么？', false, false, false, 'chat'],
  ['帮我弄一下', false, false, false, 'ask'],
  ['随便，你看着办', false, false, false, 'ask'],
  ['什么是线性代数？', false, false, false, 'chat'],
  ['帮我解释一下特征值', false, false, false, 'chat'],
  ['', true, false, false, 'solve'],
  ['这里', false, true, true, 'read'],
]
for (let i = 0; i < cases.length; i++) {
  const [text, hasImages, hasMaterial, readingQuestion, expected] = cases[i]
  const got = route.resolveTutorMode({ text, hasImages, hasMaterial, readingQuestion })
  check(`route case ${i + 1}: img=${hasImages} mat=${hasMaterial} rq=${readingQuestion} -> ${expected}`, got === expected, `got ${got}`)
}
check('resolveTutorMode is deterministic (same input twice)',
  route.resolveTutorMode({ text: '求导', hasImages: false, hasMaterial: true, readingQuestion: false }) ===
  route.resolveTutorMode({ text: '求导', hasImages: false, hasMaterial: true, readingQuestion: false }))
const labels = route.TUTOR_MODE_LABELS || {}
check('labels: auto/chat/read/solve/ask',
  labels.auto === '自动' && labels.chat === '对话' && labels.read === '讲解' && labels.solve === '解题' && labels.ask === '先问我',
  JSON.stringify(labels))
check('routing file has no runtime imports (type-only)', !/^\s*import\s+(?!type\b)/m.test(stripComments(routeSrc)))

// ------------------------------------------------------------------ 2. protocol prompts
const promptRel = 'electron/lib/aiTeachingTutorPrompt.ts'
console.log(`\n[2] ${promptRel}`)
const prompt = await loadTs(promptRel, 'aiTeachingTutorPrompt.mjs')

const chat = prompt.buildTutorProtocolHint('chat')
const ask = prompt.buildTutorProtocolHint('ask')
const solve = prompt.buildTutorProtocolHint('solve')
const rd = prompt.buildTutorProtocolHint('read')
check('chat hint is empty', chat === '')
check('ask/solve/read hints are non-empty', !!ask && !!solve && !!rd)
check('every hint <= 800 chars', [ask, solve, rd].every((s) => s.length <= 800), `ask=${ask.length} solve=${solve.length} read=${rd.length}`)
check('ask: single fenced ask block', ask.includes('```ask') && ask.includes('最多一个'))
check('ask: 2-6 options + free input', ask.includes('2–6') && ask.includes('自由输入'))
check('ask: skip already answered questions', ask.includes('已经回答过'))
check('solve: asks where stuck first', solve.includes('卡在哪一步'))
check('solve: direct answer skip', solve.includes('直接给答案'))
check('solve: L1 direction / L2 key step', solve.includes('一级提示') && solve.includes('二级提示'))
check('solve: full solution + exam point + pitfalls', solve.includes('完整解') && solve.includes('考点') && solve.includes('易错点'))
check('solve: 2 variants in quiz fence, renumber 1..N', solve.includes('```quiz') && solve.includes('2 道') && solve.includes('1..N'))
check('read: three-sentence map', rd.includes('三句地图'))
check('read: layers intuition/derivation/example/exam', rd.includes('直觉') && rd.includes('推导') && rd.includes('例题') && rd.includes('考点'))
check('read: one layer + check question', rd.includes('每次只讲一层') && rd.includes('检查问题'))
check('read: [p.N] citation', rd.includes('[p.N]'))
check('read: generic explanation disclosure', rd.includes('这是通用解释，不是原文'))

const injection = prompt.buildTutorReadingInjection({ relPath: 'books/a.pdf', kind: 'pdf', page: 7, text: 'x'.repeat(4000) })
check('reading injection has [current material] header', injection.includes('【当前资料】') && injection.includes('books/a.pdf'))
check('reading injection carries page number', injection.includes('第 7 页'))
check('reading injection caps at 3000 chars', injection.includes('只读了前 3000 字'))
check('reading injection text part is 3000 chars', injection.includes('x'.repeat(3000)) && !injection.includes('x'.repeat(3001)))
check('empty reading text -> empty injection', prompt.buildTutorReadingInjection({ relPath: 'a.md', kind: 'md', text: '   ' }) === '')
check('normalizeTutorTurnMode: valid pass-through / invalid -> chat',
  prompt.normalizeTutorTurnMode('solve') === 'solve' && prompt.normalizeTutorTurnMode('auto') === 'chat' && prompt.normalizeTutorTurnMode(undefined) === 'chat')
check('reading text cap constant = 3000', prompt.TUTOR_READING_TEXT_CAP === 3000)

// ------------------------------------------------------------------ 3. source wiring
console.log('\n[3] source wiring')
const repo = stripComments(read('electron/lib/agentSessionRepo.ts'))
const msgStore = stripComments(read('electron/lib/agentMessageStore.ts'))
const folders = stripComments(read('electron/lib/aiTeachingFolders.ts'))
const tutor = stripComments(read('electron/lib/aiTeachingTutor.ts'))
const service = stripComments(read('electron/lib/agentService.ts'))
const types = stripComments(read('src/types/index.ts'))
const ipc = stripComments(read('src/lib/ipc.ts'))
const preload = stripComments(read('electron/preload/index.ts'))

check('session row has aiTeachMode', repo.includes("aiTeachMode?: 'tutor'"))
check('createAgentSession accepts tutor opts', /createAgentSession\([\s\S]{0,220}aiTeachMode\?: 'tutor'/.test(repo))
check('message row has teach_mode', msgStore.includes('teach_mode?: TutorTurnMode'))
check('only assistant messages get teach_mode', /role === 'assistant' && teachMode[\s\S]{0,60}teach_mode/.test(repo))
check('tutor session flag exposed in renderer types', types.includes("aiTeachMode?: 'tutor'"))
check('stored message exposes teachMode', types.includes('teachMode?: TutorTurnMode'))

check('setTutorFolderResolver exported', /export function setTutorFolderResolver/.test(folders))
check('tutor resolver registered at module load', tutor.includes('setTutorFolderResolver(tutorParentRel)'))
check('tutor parent folder is {root}/对话', tutor.includes("TUTOR_FOLDER_NAME = '对话'") && /rootDirName\(getSetting\)[\s\S]{0,40}TUTOR_FOLDER_NAME/.test(tutor))
check('ensure order: lesson -> assistant -> tutor -> workspace/root',
  /lessonFolderResolver[\s\S]{0,260}assistantFolderResolver[\s\S]{0,260}tutorFolderResolver[\s\S]{0,260}getWorkspaceOfSession/.test(folders))
check('tutor anchor writes kind:tutor', /kind: 'tutor'/.test(folders) && folders.includes('SessionFolderAnchor'))
check('tutor folder reuses uniqueFileName + date prefix', /tutorRel[\s\S]{0,420}uniqueFileName\(baseAbs, folderBaseName\(/.test(folders))
check('createTutorSession defaults title to 新对话', tutor.includes("|| '新对话'"))
check('createTutorSession returns sessionId even when folder fails', /ensured\.ok\) return \{ ok: false, sessionId/.test(tutor))
check('isTutorSession reads session row (no global cache)', /getAgentSession\(id\)\?\.aiTeachMode === 'tutor'/.test(tutor))

check('request type has teachMode + reading', /teachMode\?: TutorTurnMode[\s\S]{0,200}reading\?: TutorReadingContext/.test(service))
check('renderer request type has teachMode + reading', /teachMode\?: TutorTurnMode; reading\?: TutorReadingContext/.test(types))
check('preload does not swallow new request fields', /teachMode\?: string; reading\?: unknown/.test(preload))
check('tutor mode normalized through whitelist', /normalizeTutorTurnMode\(req\.teachMode\)/.test(service))
check('assistant append receives tutor mode', /appendAgentMessage\(sessionId, 'assistant', reply, trace, undefined, opts\?\.tutorMode\)/.test(service))
check('message camel mapping keeps teachMode', /teachMode: row\.teach_mode \?\? row\.teachMode/.test(service))
check('tutor hint merged into teachStyleHint', /teachStyleHint[\s\S]{0,260}buildTutorProtocolHint\(opts\?\.tutorMode/.test(service))
check('tutor hint gated by isTutorSession', /isTutorSession\(sessionId\)[\s\S]{0,160}buildTutorProtocolHint/.test(service))
check('reading hint goes to requestInjection (user layer)', /requestInjection = \[[\s\S]{0,260}opts\?\.tutorReadingHint/.test(service))
check('reading hint not appended to systemFull', !/systemFull[\s\S]{0,200}tutorReadingHint/.test(service))

check('IPC channel registered: aiTeach:tutor:create', folders.includes("ipcMain.handle('aiTeach:tutor:create'"))
check('preload exposes aiTeachTutorCreate', preload.includes("ipcRenderer.invoke('aiTeach:tutor:create'"))
check('ipc wrapper aiTeachTutorCreate', /export const aiTeachTutorCreate = \(title\?: string\)/.test(ipc))
check('renderer API declares aiTeachTutorCreate', types.includes('aiTeachTutorCreate: (title?: string)'))

check('last tutor mode helper reads teach_mode', /function lastTutorMode\([\s\S]{0,500}teach_mode/.test(service))
check('regenerate reuses last tutor mode', /const tutorMode = lastTutorMode\(sessionId\)[\s\S]{0,400}\{ tutorMode \}/.test(service))
check('resume reuses last tutor mode', /profile, tutorMode: lastTutorMode\(sessionId\)/.test(service))


console.log(`\nPASS -- ${pass}/${pass + fail} assertions passed`)
process.exit(fail > 0 ? 1 : 0)

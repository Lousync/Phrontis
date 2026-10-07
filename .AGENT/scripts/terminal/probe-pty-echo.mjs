/**
 * 终端 pty 流探针：对比 Windows PowerShell 5.1 在「默认 PSReadLine」与「原生 cooked 模式
 * （Remove-Module PSReadLine）」下的输出流质量。
 *
 * 检测项：
 *   A. banner 与提示符是否正常出现
 *   B. 回显完整性：echo 标记串（含 CJK）在流中恰好出现的次数（1 = 干净，>1 = 重画/重复）
 *   C. 乱码启发式：同一非空白字符在一行内连续重复 >= 10 次的行数（截图里「复复复复…」的特征）
 *
 * 运行：node .AGENT/scripts/terminal/probe-pty-echo.mjs [--plain]
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pty = createRequire(path.join(repo, 'package.json'))('@lydell/node-pty')

const plain = process.argv.includes('--plain')
const COLS = 110
const ROWS = 30
const MARKER = 'PTY-MARK-hello-9137'

const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
env.TERM = 'xterm-256color'

const args = plain
  ? ['-NoExit', '-Command', 'Remove-Module PSReadLine -ErrorAction SilentlyContinue']
  : []
const p = pty.spawn('powershell.exe', args, {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: repo, env,
})

let out = ''
p.onData(d => { out += d })

const sleep = ms => new Promise(r => setTimeout(r, ms))

await sleep(3000) // 等 banner + 首提示符
const afterBoot = out
p.write(`echo ${MARKER}-中文\r`)
await sleep(2000)
p.kill()
await sleep(300)

const countMarker = (s) => s.split(MARKER).length - 1
const garbageLines = (s) => s.split(/\r\n|\n|\r/).filter(line => {
  const m = line.match(/([^\s])\1{9,}/) // 同一字符连续 >= 10 次
  return !!m
}).length

const bannerOk = /Windows PowerShell/.test(afterBoot)
const promptOk = (/PS [^>\r\n]*>/).test(afterBoot)
const markerEchoed = countMarker(out)
const garbage = garbageLines(out)

console.log(`mode            : ${plain ? 'plain (Remove-Module PSReadLine)' : 'default (PSReadLine on)'}`)
console.log(`banner          : ${bannerOk ? '[OK]' : '[MISS]'}  prompt: ${promptOk ? '[OK]' : '[MISS]'}`)
console.log(`marker echoes   : ${markerEchoed} (expect 1 echo + 1 output = 2)` )
console.log(`garbage lines   : ${garbage}`)
console.log(`stream bytes    : ${out.length}`)
process.exit(0)

#!/usr/bin/env node
/**
 * 书桌伙伴 PNG 序列帧生成器（纯 Node，无 Electron）。
 *
 * 契约（src/components/shared/AiMascot/MascotPlayer.tsx）：
 *   一个动画 = 一张 PNG 网格，每行固定 8 帧；每帧格 = box[2]×box[3]（逻辑格）× grid.cell(px)；
 *   素材按帧自动裁边（宿主忽略 box[0/1]，只按整图 100%×100% 拉伸）。
 *
 * 产出：resources/market-plugins/knowbase.mascot-desk-companions/sheets/<id>-<anim>.png
 *       并把 contributes.mascot 写回同目录 plugin.json（幂等）。
 *
 * 跑法：node .AGENT/scripts/mascot-gen/gen.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng } from './png.mjs'
import { makePainter, CHARACTERS, LW, LH, UNIT } from './draw.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OUT_DIR = join(ROOT, 'resources', 'market-plugins', 'knowbase.mascot-desk-companions')
const SHEETS_DIR = join(OUT_DIR, 'sheets')

const COLS = 8
/** [动画名, 画笔 state, 帧数] */
const ANIMS = [
  ['idle', 'idle', 24],
  ['thinking', 'thinking', 32],
  ['working', 'working', 24],
  ['sweeping', 'sweeping', 24],
  ['notification', 'notification', 16],
  ['error', 'error', 20],
  ['attention', 'attention', 28],
  ['sleeping', 'sweeping', 28],
  ['waking', 'attention', 12],
  ['poke-left', 'idle', 12],
  ['poke-right', 'idle', 12],
  ['tickle', 'idle', 16],
]
const STATES = { idle: 'idle', thinking: 'thinking', working: 'working', sweeping: 'sweeping', notification: 'notification', error: 'error', attention: 'attention' }

function tapOffset(anim, f, frames) {
  const pulse = Math.sin(Math.PI * (f / Math.max(1, frames - 1)))
  if (anim === 'poke-left') return [-2 * pulse, 0]
  if (anim === 'poke-right') return [2 * pulse, 0]
  if (anim === 'tickle') return [f % 2 ? 1.5 : -1.5, 0]
  return [0, 0]
}

function renderFrame(char, state, t, ox, oy) {
  const P = makePainter(LW * UNIT, LH * UNIT)
  P.setOffset(ox, oy)
  char.paint(P, state, t)
  return P
}

/** 并集非透明包围盒（设备像素） */
function unionBBox(frames) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (const F of frames) {
    const { buf, W, H } = F
    for (let y = 0; y < H; y++) {
      const row = y * W
      for (let x = 0; x < W; x++) {
        if (buf[(row + x) * 4 + 3] > 8) {
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
        }
      }
    }
  }
  if (maxX < 0) return { x0: 0, y0: 0, x1: 1, y1: 1 }
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 }
}

function blit(dst, dstW, src, srcW, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    const sRow = ((sy + y) * srcW + sx) * 4
    const dRow = ((dy + y) * dstW + dx) * 4
    dst.set(src.subarray(sRow, sRow + w * 4), dRow)
  }
}

function renderAnim(char, anim, state, frames) {
  // 第一遍：算并集包围盒
  const pass = []
  for (let f = 0; f < frames; f++) {
    const [ox, oy] = tapOffset(anim, f, frames)
    pass.push(renderFrame(char, state, f, ox, oy))
  }
  const bb = unionBBox(pass)
  const x0 = Math.floor(bb.x0 / UNIT), y0 = Math.floor(bb.y0 / UNIT)
  const x1 = Math.ceil(bb.x1 / UNIT), y1 = Math.ceil(bb.y1 / UNIT)
  const box = [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]
  const cellW = box[2] * UNIT, cellH = box[3] * UNIT
  const rows = Math.ceil(frames / COLS)
  const sheetW = COLS * cellW, sheetH = rows * cellH
  const sheet = new Uint8ClampedArray(sheetW * sheetH * 4)
  // 第二遍：把裁好的帧贴进网格
  pass.forEach((F, f) => {
    const dx = (f % COLS) * cellW, dy = Math.floor(f / COLS) * cellH
    blit(sheet, sheetW, F.buf, F.W, x0 * UNIT, y0 * UNIT, cellW, cellH, dx, dy)
  })
  return { png: encodePng(sheet, sheetW, sheetH), box, frames, still: 0, w: sheetW, h: sheetH }
}

function main() {
  mkdirSync(SHEETS_DIR, { recursive: true })
  const pluginJsonPath = join(OUT_DIR, 'plugin.json')
  if (!existsSync(pluginJsonPath)) throw new Error(`缺少 plugin.json：${pluginJsonPath}`)
  const pj = JSON.parse(readFileSync(pluginJsonPath, 'utf8'))

  const mascots = []
  let pngCount = 0
  for (const char of Object.values(CHARACTERS)) {
    const sheets = {}
    for (const [anim, state, frames] of ANIMS) {
      const r = renderAnim(char, anim, state, frames)
      const rel = `sheets/${char.id}-${anim}.png`
      writeFileSync(join(OUT_DIR, rel.replace(/\//g, dirsep())), r.png)
      pngCount++
      sheets[anim] = { body: rel, frames: r.frames, box: r.box, still: r.still }
      console.log(`  ${char.id.padEnd(8)} ${anim.padEnd(13)} ${String(r.frames).padStart(2)}f  box=[${r.box.join(',')}]  ${r.w}x${r.h}px`)
    }
    mascots.push({
      id: char.id,
      name: char.name,
      frameMs: char.frameMs,
      grid: { cell: UNIT, w: LW, h: LH },
      anchor: 'composer',
      states: STATES,
      sheets,
      tapLeft: 'poke-left',
      tapRight: 'poke-right',
      tapFlail: 'tickle',
    })
  }

  pj.contributes = pj.contributes || {}
  pj.contributes.mascot = mascots
  writeFileSync(pluginJsonPath, JSON.stringify(pj, null, 2) + '\n', 'utf8')

  console.log(`\n[OK] 生成 ${pngCount} 张 PNG → ${SHEETS_DIR}`)
  console.log(`[OK] 写回 ${pluginJsonPath}（${mascots.length} 只吉祥物）`)
}

const dirsep = () => (process.platform === 'win32' ? '\\' : '/')
main()

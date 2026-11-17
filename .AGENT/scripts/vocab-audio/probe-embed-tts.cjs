#!/usr/bin/env node
/**
 * 探针：嵌入版读单词 = 系统 TTS（运行期）
 *
 * 契约脚本只能证明源码/产物里有 TTS 代码，证明不了「点了真会构造语音」。本机往往没有
 * 系统语音（Linux/CI），所以这里**伪造** speechSynthesis：替换 getVoices / speak / cancel
 * 与 SpeechSynthesisUtterance，再按上游快捷键 Ctrl+J 触发朗读，断言 utterance 的文本 / 语言 /
 * 音量 / 速率来自当前单词与发音设置，并且 cancel 先于 speak。
 *
 * 用法（需要 GUI 环境；Linux 无 SUID sandbox 时加 --no-sandbox）：
 *   node_modules/.bin/electron --no-sandbox .AGENT/scripts/vocab-audio/probe-embed-tts.cjs
 *
 * 前置：resources/vocab 已构建（npm run build:vocab）。
 * 输出：[PASS] / [FAIL]，任一失败退出码 1。
 */
const { app, BrowserWindow } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const VOCAB = path.join(ROOT, 'resources', 'vocab')
const PORT = 0

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain',
}

if (!fs.existsSync(path.join(VOCAB, 'index.html'))) {
  console.error('[FAIL] resources/vocab 未构建，先跑 npm run build:vocab')
  process.exit(1)
}

let pass = 0
let fail = 0
function assert(cond, name, detail) {
  if (cond) {
    pass++
    console.log(`[PASS] ${name}`)
  } else {
    fail++
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '') || 'index.html'
  const file = path.join(VOCAB, rel)
  if (!file.startsWith(VOCAB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []

app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const port = server.address().port
  const win = new BrowserWindow({ show: false, width: 1280, height: 900 })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message.slice(0, 300))
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + JSON.stringify(d)))

  const probe = (js) => win.webContents.executeJavaScript(js, true)
  try {
    await win.loadURL(`http://127.0.0.1:${port}/index.html?embed=1`)
    await sleep(1800)

    const home = await probe(`({ voices: window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1, synth: typeof window.speechSynthesis })`)
    assert(home.synth === 'object', '页面暴露 speechSynthesis', JSON.stringify(home))

    const entered = await probe(`(() => {
      const el = Array.from(document.querySelectorAll('div,button,a')).find((e) => e.textContent.trim() === 'CET-4')
      if (!el) return false
      ;(el.closest('button,a') || el).click()
      return true
    })()`)
    assert(entered, '进入词库（CET-4 卡片可点）')
    await sleep(1500)

    const started = await probe(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /开始|Start/i.test(b.textContent))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    assert(started, '进入打字页（开始按钮可点）')
    await sleep(1200)

    await probe(`(() => {
      window.__spoken = []
      window.__cancels = 0
      class FakeUtterance {
        constructor(text) { this.text = text; this.lang = ''; this.voice = null; this.volume = 1; this.rate = 1 }
      }
      window.SpeechSynthesisUtterance = FakeUtterance
      const synth = window.speechSynthesis
      Object.defineProperty(synth, 'getVoices', { configurable: true, value: () => [{ name: 'Fake US', lang: 'en-US', localService: true }] })
      Object.defineProperty(synth, 'cancel', { configurable: true, value: () => { window.__cancels++ } })
      Object.defineProperty(synth, 'speak', { configurable: true, value: (u) => {
        window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate, volume: u.volume, voice: u.voice && u.voice.name })
        setTimeout(() => u.onstart && u.onstart(), 0)
        setTimeout(() => u.onend && u.onend(), 40)
      } })
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true }))
    })()`)
    await sleep(400)

    const result = await probe(`({ spoken: window.__spoken, cancels: window.__cancels })`)
    const first = result.spoken[0]
    assert(Array.isArray(result.spoken) && result.spoken.length >= 1, 'Ctrl+J 触发构造 utterance', JSON.stringify(result))
    if (first) {
      assert(typeof first.text === 'string' && first.text.length > 0, '朗读文本来自当前单词', JSON.stringify(first))
      assert(/^en/i.test(first.lang), '语言按美音设置选到 en-US', JSON.stringify(first))
      assert(first.voice === 'Fake US', '使用选中的系统语音', JSON.stringify(first))
      assert(first.volume >= 0 && first.volume <= 1, '音量映射到 0..1', String(first.volume))
      assert(first.rate > 0, '速率有效', String(first.rate))
    }
    assert(result.cancels >= 1, '播放前先 cancel（避免叠加）', String(result.cancels))
    assert(errors.length === 0, '渲染进程无报错', JSON.stringify(errors.slice(0, 5)))
  } catch (e) {
    fail++
    console.log(`[FAIL] 探针执行异常 — ${e && e.message ? e.message : e}`)
  }

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`)
  server.close()
  app.exit(fail > 0 ? 1 : 0)
})

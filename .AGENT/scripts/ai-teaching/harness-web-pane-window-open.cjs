/**
 * Electron 侧运行时探针（由 verify-web-pane-window-open.mjs 启动）。
 * `WEB_PANE_BUNDLE` = 打包后的 webPaneView bundle 路径（真实实现）。
 *
 * 输出只有 [OK] / [FAIL] 行 + 汇总；退出码交给 app.exit。
 */
const { app, BrowserWindow, shell } = require('electron')
const http = require('node:http')

const BUNDLE = process.env.WEB_PANE_BUNDLE
if (!BUNDLE) {
  console.log('[FAIL] missing WEB_PANE_BUNDLE')
  app.exit(1)
  return
}
const W = require(BUNDLE)

/* 系统浏览器出口：拦成数组，断言「http(s) 一条都不许进去」 */
const externalCalls = []
shell.openExternal = async (u) => { externalCalls.push(String(u)) }

const PAGES = {
  '/opener': `<!doctype html><html><body style="font:14px sans-serif;padding:12px">
<h1 id="h">opener</h1>
<a id="blank" href="/next" target="_blank">blank link</a>
<a id="mail" href="mailto:a@b.c">mail link</a>
<script>
  document.cookie = 'sid=abc123; path=/'
  window.__msgs = []
  window.addEventListener('message', (e) => window.__msgs.push(String(e.data)))
  window.__openBare = () => { window.open('/popup'); return 'ok' }
  window.__openSized = () => { window.open('/popup', 'auth', 'width=420,height=320'); return 'ok' }
  window.__openNamed = (n) => { window.open('/popup', 'auth' + n, 'width=420,height=320'); return 'ok' }
  window.__msgs_ = () => window.__msgs
</script></body></html>`,
  '/next': `<!doctype html><html><body><h1 id="n">next page</h1></body></html>`,
  '/popup': `<!doctype html><html><body style="font:14px sans-serif">
<h1>popup</h1><div id="out"></div>
<script>
  try { window.opener && window.opener.postMessage('hello-from-popup', '*') } catch (e) {}
  window.__info = () => ({ cookie: document.cookie, hasOpener: !!window.opener, name: window.name })
  window.__close = () => { window.close(); return 'ok' }
</script></body></html>`,
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGES[req.url] || PAGES['/next'])
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const expect = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '[OK]' : '[FAIL]'} ${name}${!pass && detail ? ' -> ' + detail : ''}`)
}

const stateUrl = (id) => {
  const s = W.getWebPaneState(id)
  return s ? s.url : ''
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const win = new BrowserWindow({ width: 1200, height: 800, show: true })
  await win.loadURL('about:blank')

  const made = W.createWebPane(win, 'w1', `${base}/opener`)
  expect('createWebPane ok', made.ok === true, JSON.stringify(made))
  W.setWebPaneBounds('w1', { x: 0, y: 0, width: 1100, height: 700 })
  W.setWebPaneVisible('w1', true)
  await wait(1400)

  const openerView = win.contentView.children.find(
    (c) => c.webContents && c.webContents.getURL().includes('/opener'),
  )
  expect('opener loaded in the native view', !!openerView, '')
  if (!openerView) {
    app.exit(1)
    return
  }

  const baseWinCount = BrowserWindow.getAllWindows().length

  /* ① target=_blank */
  await openerView.webContents.executeJavaScript(`document.getElementById('blank').click()`)
  await wait(900)
  expect('target=_blank navigates in place', stateUrl('w1').endsWith('/next'), stateUrl('w1'))
  expect('target=_blank opens no window', BrowserWindow.getAllWindows().length === baseWinCount, '')
  W.webPaneGoBack('w1')
  await wait(900)
  expect('back returns to the opener', stateUrl('w1').endsWith('/opener'), stateUrl('w1'))

  /* ② window.open without size */
  await openerView.webContents.executeJavaScript(`window.__openBare()`)
  await wait(900)
  expect('bare window.open navigates in place', stateUrl('w1').endsWith('/popup'), stateUrl('w1'))
  expect('bare window.open opens no window', BrowserWindow.getAllWindows().length === baseWinCount, '')
  W.webPaneGoBack('w1')
  await wait(900)

  /* ③ sized window.open -> in-app popup sharing the partition */
  await openerView.webContents.executeJavaScript(`window.__openSized()`)
  await wait(1400)
  const popup = BrowserWindow.getAllWindows().find((w) => w !== win)
  expect('sized window.open creates an in-app popup', !!popup, '')
  if (popup) {
    const info = await popup.webContents.executeJavaScript('window.__info()')
    expect('popup shares the webtabs cookie', /sid=abc123/.test(info.cookie), info.cookie)
    expect('popup keeps window.opener', info.hasOpener === true, '')
    expect('popup keeps window.name', info.name === 'auth', String(info.name))
    const msgs = await openerView.webContents.executeJavaScript('window.__msgs_()')
    expect('opener receives postMessage from the popup', msgs.includes('hello-from-popup'), JSON.stringify(msgs))
    await popup.webContents.executeJavaScript('window.__close()')
    await wait(700)
    expect('popup window.close() destroys it', popup.isDestroyed(), '')
  }

  /* ④ popup cap = 2 */
  await openerView.webContents.executeJavaScript(`window.__openNamed(1)`)
  await wait(1000)
  await openerView.webContents.executeJavaScript(`window.__openNamed(2)`)
  await wait(1000)
  await openerView.webContents.executeJavaScript(`window.__openNamed(3)`)
  await wait(1200)
  const livePopups = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed())
  expect('popup cap holds at 2', livePopups.length === 2, String(livePopups.length))

  /* ⑤ closing the pane closes its popups */
  W.closeWebPane('w1')
  await wait(900)
  const afterClose = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed())
  expect('closeWebPane closes the popups', afterClose.length === 0, String(afterClose.length))

  /* ⑥ mailto -> system, http(s) never */
  W.createWebPane(win, 'w2', `${base}/opener`)
  W.setWebPaneBounds('w2', { x: 0, y: 0, width: 1100, height: 700 })
  W.setWebPaneVisible('w2', true)
  await wait(1400)
  const view2 = win.contentView.children.find(
    (c) => c.webContents && c.webContents.getURL().includes('/opener'),
  )
  if (view2) {
    await view2.webContents.executeJavaScript(`document.getElementById('mail').click()`)
    await wait(600)
  }
  expect('mailto is handed to the system', externalCalls.some((u) => u.startsWith('mailto:')), JSON.stringify(externalCalls))
  expect('mailto does not navigate the pane', stateUrl('w2').endsWith('/opener'), stateUrl('w2'))
  expect('no http(s) url leaked to the system browser', !externalCalls.some((u) => /^https?:/i.test(u)), JSON.stringify(externalCalls))

  W.disposeAllWebPanes()
  const fails = results.filter((r) => !r.pass)
  console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} -- ${results.length - fails.length}/${results.length}`)
  setTimeout(() => {
    try { server.close() } catch { /* ignore */ }
    app.exit(fails.length === 0 ? 0 : 1)
  }, 300)
})

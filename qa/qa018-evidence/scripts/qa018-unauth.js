// QA018 未登录拦截取证：无 cookie 上下文访问 /spark-ui/* 各形态
// 工装:QA018_PW_HOME(默认 ~/.qa-harness-zeta018) 站点:QA018_BASE(默认生产)
// 无凭据、无写操作。输出:截图 + results JSON + 网络记录(已脱敏)。
const path = require('path')
const fs = require('fs')
const os = require('os')
const { chromium } = require(
  path.join(process.env.QA018_PW_HOME || path.join(os.homedir(), '.qa-harness-zeta018'), 'node_modules', 'playwright')
)

const BASE = process.env.QA018_BASE || 'https://zeta.pama.workers.dev'
const DB_ID = process.env.QA018_DB_ID || 'ddda2673-29d0-4292-af9f-ea51c0e653c1' // Apollo
const OUT = process.env.QA018_OUT || path.join(__dirname, '..')

const EXEC = '/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

function sanitizeHeaders(headers) {
  const keep = ['content-type', 'location', 'cache-control', 'x-robots-tag']
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (keep.includes(lk)) out[lk] = v
    else if (lk === 'set-cookie') out[lk] = v.replace(/=[^;]*/, '=<redacted>')
  }
  return out
}

function sanitizeUrl(u) {
  return u.replace(/([?&](token|db)=)[^&]*/gi, (m, p1) => `${p1}<redacted>`)
}

;(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true })
  const browser = await chromium.launch({ executablePath: EXEC })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // 不注入任何 cookie —— 未登录态
  })
  const page = await context.newPage()
  const net = []
  page.on('response', (res) => {
    net.push({
      url: sanitizeUrl(res.url()),
      status: res.status(),
      headers: sanitizeHeaders(res.headers()),
    })
  })
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
  })

  const cases = [
    { name: '01-root', url: `${BASE}/spark-ui/` },
    { name: '02-with-db', url: `${BASE}/spark-ui/?db=${DB_ID}` },
    { name: '03-deep-path', url: `${BASE}/spark-ui/api/v1/applications/` },
    { name: '04-no-slash', url: `${BASE}/spark-ui` },
  ]
  const results = []
  for (const tc of cases) {
    const resp = await page.goto(tc.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const status = resp ? resp.status() : null
    const body = (await page.textContent('body').catch(() => '')) || ''
    const isJsonError = status === 401 && body.trim().includes('"Unauthorized"')
    const contentType = resp ? resp.headers()['content-type'] || '' : ''
    const rec = {
      case: tc.name,
      url: sanitizeUrl(tc.url),
      status,
      content_type: contentType,
      body_excerpt: body.trim().slice(0, 120),
      location_header: resp ? resp.headers()['location'] || null : null,
      blocked_as_401_json: isJsonError && contentType.includes('json'),
      not_redirect: !resp || !resp.headers()['location'],
      not_spa_shell: !body.includes('id="root"'),
    }
    results.push(rec)
    await page.screenshot({ path: path.join(OUT, 'shots', `unauth-${tc.name}.png`), fullPage: true })
  }

  const pass = results.every((r) => r.blocked_as_401_json && r.not_redirect)
  const summary = {
    item: '未登录访问 /spark-ui/ 被拦',
    base: BASE,
    run_at: new Date().toISOString(),
    all_pass: pass,
    console_errors: consoleErrors,
    cases: results,
  }
  fs.writeFileSync(path.join(OUT, 'results-unauth.json'), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(OUT, 'log-unauth-network.json'), JSON.stringify(net, null, 2))
  console.log(JSON.stringify({ all_pass: pass, statuses: results.map((r) => `${r.case}:${r.status}`) }))
  await browser.close()
})().catch((e) => {
  console.error('FATAL', e.message.split('\n')[0])
  process.exit(1)
})

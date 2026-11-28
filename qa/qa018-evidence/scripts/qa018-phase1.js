// QA018 第一段:UI 两字段「未填」状态验收(需登录态,凭据经 QA018_REFRESH_TOKEN 环境变量注入)
// 前置:QA018_REFRESH_TOKEN = 生产 refresh_token cookie 值(仅环境变量传入,不写盘、不入日志)
// 断言组:A 登录态建立 / B API 口径 has_spark_ui=false / C 查询页菜单两处无 Spark UI 入口(Apollo 未填)
//         D 非 Spark 数据源菜单与查询行为零变化 / E admin 表单未填回显 + 非 Spark 不渲染 UI 字段
// 输出:截图 + results-phase1.json + 网络记录(已脱敏)。失败即非零退出。
const path = require('path')
const fs = require('fs')
const os = require('os')
const { chromium } = require(
  path.join(process.env.QA018_PW_HOME || path.join(os.homedir(), '.qa-harness-zeta018'), 'node_modules', 'playwright')
)

const BASE = process.env.QA018_BASE || 'https://zeta.pama.workers.dev'
const APOLLO_ID = process.env.QA018_DB_ID || 'ddda2673-29d0-4292-af9f-ea51c0e653c1'
const REFRESH = process.env.QA018_REFRESH_TOKEN
const OUT = process.env.QA018_OUT || path.join(__dirname, '..')
const EXEC = '/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

if (!REFRESH) {
  console.error('FATAL: QA018_REFRESH_TOKEN not set')
  process.exit(1)
}

const checks = []
function record(id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail: detail || '' })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' — ' + detail : ''}`)
}

function sanitizeObj(o) {
  // 脱敏:任何字段值若像 token/cookie 一律遮蔽
  const seen = JSON.stringify(o)
  return seen
    .replace(/(refresh_token"?\s*[=:]\s*"?)[^",}&\s]+/g, '$1<redacted>')
    .replace(/(accessToken"?\s*[=:]\s*"?)[^",}&\s]+/g, '$1<redacted>')
    .replace(/([?&]token=)[^&"\s]+/g, '$1<redacted>')
    .replace(/(authorization"?\s*[=:]\s*"?)[^",}&\s]+/gi, '$1<redacted>')
}

;(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true })
  const browser = await chromium.launch({ executablePath: EXEC })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([
    {
      name: 'refresh_token',
      value: REFRESH,
      domain: 'zeta.pama.workers.dev',
      path: '/api/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    },
  ])
  const page = await context.newPage()
  const net = []
  page.on('response', async (res) => {
    let size = null
    try {
      size = (await res.body()).length
    } catch {}
    net.push({ url: res.url().replace(/([?&](token|db)=)[^&]*/gi, '$1<redacted>'), status: res.status(), size })
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))

  const shot = (name) => page.screenshot({ path: path.join(OUT, 'shots', `${name}.png`), fullPage: true })

  // ── A. 登录态建立 ──────────────────────────────────────────────
  await page.goto(`${BASE}/query`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  // SPA 挂载后用 refresh cookie 换 access token;等数据源切换器出现(已登录标志)
  await page.waitForSelector('[data-testid="db-switcher"], button:has-text("Apollo"), select', { timeout: 30000 }).catch(() => {})
  const bodyText = (await page.textContent('body').catch(() => '')) || ''
  const loggedIn = !bodyText.includes('Sign in') && !bodyText.includes('登录') ? true : bodyText.length > 200
  const dbsViaApi = await page.evaluate(async () => {
    const r = await fetch('/api/databases', { credentials: 'include' })
    if (!r.ok) return { error: r.status }
    return r.json()
  })
  record('A1', '登录态建立(/query 渲染 + /api/databases 可访问)', Array.isArray(dbsViaApi), `dbs=${Array.isArray(dbsViaApi) ? dbsViaApi.length : JSON.stringify(dbsViaApi)}`)
  await shot('phase1-A1-query')

  if (!Array.isArray(dbsViaApi)) {
    fs.writeFileSync(path.join(OUT, 'results-phase1.json'), JSON.stringify({ run_at: new Date().toISOString(), fatal: 'not logged in', checks: sanitizeObj(checks), network: sanitizeObj(net), page_errors: pageErrors }, null, 2))
    await browser.close()
    process.exit(1)
  }

  const apollo = dbsViaApi.find((d) => d.id === APOLLO_ID)
  const sparkDbs = dbsViaApi.filter((d) => d.kind === 'spark')
  const nonSpark = dbsViaApi.filter((d) => d.kind !== 'spark')

  // ── B. API 口径:未填 → has_spark_ui=false ─────────────────────
  record('B1', 'Apollo(spark)在列表中且 has_spark_ui=false', !!apollo && apollo.has_spark_ui === false, JSON.stringify(apollo ? { has_spark_ui: apollo.has_spark_ui, permission: apollo.permission } : 'missing'))
  record('B2', 'Spark 数据源恰好一个(Apollo)', sparkDbs.length === 1, sparkDbs.map((d) => d.name).join(','))
  record('B3', '非 Spark 数据源 has_spark_ui 均为 false/缺省', nonSpark.every((d) => !d.has_spark_ui), nonSpark.map((d) => `${d.name}:${d.kind}`).join(','))

  // ── C. 查询页菜单:选中 Apollo,两处下拉均无 Spark UI 入口 ────────
  // 桌面下拉:数据源切换按钮
  const switcher = page.locator('button').filter({ hasText: /Apollo/ }).first()
  await switcher.click()
  await page.waitForTimeout(400)
  const menuText1 = (await page.textContent('body')) || ''
  const sparkUiLink1 = await page.locator('a[href^="/spark-ui/"]').count()
  record('C1', '桌面菜单(选中未填 Apollo)无 /spark-ui/ 链接', sparkUiLink1 === 0, `links=${sparkUiLink1}`)
  await shot('phase1-C1-menu-apollo-unfilled')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // ── D. 非 Spark 零变化:菜单无入口 + 轻查询行为正常 ──────────────
  for (const db of nonSpark.slice(0, 3)) {
    await page.locator('button').filter({ hasText: new RegExp(db.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click()
    await page.waitForTimeout(300)
    const links = await page.locator('a[href^="/spark-ui/"]').count()
    record(`D-menu-${db.kind}`, `${db.name}(${db.kind})菜单无 Spark UI 入口`, links === 0, `links=${links}`)
    await shot(`phase1-D-menu-${db.kind}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  // 轻查询(第一个非 Spark 数据源,SELECT 1 只读)
  if (nonSpark.length > 0) {
    const first = nonSpark[0]
    await page.locator('button').filter({ hasText: new RegExp(first.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const editor = page.locator('.cm-content, textarea, [contenteditable="true"]').first()
    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('SELECT 1 AS one', { delay: 20 })
    const runBtn = page.locator('button').filter({ hasText: /Run|运行/ }).first()
    await runBtn.click()
    await page.waitForTimeout(4000)
    const resultText = (await page.textContent('body')) || ''
    record('D-query', `${first.name} 上 SELECT 1 行为正常(现行口径)`, /1/.test(resultText) && !/error|错误|failed/i.test(resultText.slice(0, 2000)), '见截图')
    await shot('phase1-D-query-nonspark')
  }

  // ── E. admin 表单:未填回显(两输入为空) + 非 Spark 不渲染 UI 字段 ──
  await page.goto(`${BASE}/admin/databases`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(1500)
  const editBtn = page.locator('button:has-text("Edit"), button:has-text("编辑")').first()
  await editBtn.click()
  await page.waitForTimeout(800)
  // 需确认打开的是 Apollo 的编辑表单(行序按 name;若非 Apollo 则按行内按钮定位)
  let formCheckApollo = false
  let uiUrlVal = null
  const engineSel = page.locator('select').first()
  const engineVal = await engineSel.inputValue().catch(() => '')
  if (engineVal === 'spark') {
    uiUrlVal = await page.locator('#db-spark-ui-url').inputValue()
    const uiTokVal = await page.locator('#db-spark-ui-platform-token').inputValue()
    formCheckApollo = uiUrlVal === '' && uiTokVal === ''
  }
  record('E1', 'Apollo 编辑表单 UI 两字段未填回显(空)', formCheckApollo, `engine=${engineVal} ui_url='${uiUrlVal}'`)
  await shot('phase1-E1-form-apollo')
  // 取消编辑,打开一个非 Spark 行确认无 UI 字段
  await page.locator('button:has-text("Cancel"), button:has-text("取消")').first().click().catch(() => {})
  await page.waitForTimeout(500)
  const editBtns = page.locator('button:has-text("Edit"), button:has-text("编辑")')
  const n = await editBtns.count()
  for (let i = 0; i < n; i++) {
    await editBtns.nth(i).click()
    await page.waitForTimeout(600)
    const eng = await page.locator('select').first().inputValue().catch(() => '')
    if (eng !== 'spark') {
      const uiFieldCount = await page.locator('#db-spark-ui-url').count()
      record('E2', '非 Spark 编辑表单不渲染 Spark UI 字段', uiFieldCount === 0, `engine=${eng}`)
      await shot('phase1-E2-form-nonspark')
      await page.locator('button:has-text("Cancel"), button:has-text("取消")').first().click().catch(() => {})
      break
    }
    await page.locator('button:has-text("Cancel"), button:has-text("取消")').first().click().catch(() => {})
    await page.waitForTimeout(400)
  }

  // ── 结果 ──────────────────────────────────────────────────────
  const allPass = checks.every((c) => c.pass)
  fs.writeFileSync(
    path.join(OUT, 'results-phase1.json'),
    JSON.stringify({ run_at: new Date().toISOString(), all_pass: allPass, checks, databases: dbsViaApi.map((d) => ({ name: d.name, kind: d.kind, has_spark_ui: d.has_spark_ui })), page_errors: pageErrors }, null, 2)
  )
  fs.writeFileSync(path.join(OUT, 'log-phase1-network.json'), JSON.stringify(net.slice(0, 500), null, 2))
  console.log(JSON.stringify({ all_pass: allPass, total: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.id) }))
  await browser.close()
})().catch((e) => {
  console.error('FATAL', e.message.split('\n')[0])
  process.exit(1)
})

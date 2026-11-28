// QA018 第一段:Apollo UI 两字段「未填」状态验收(登录态;凭据经 QA018_REFRESH_TOKEN 环境变量注入)
// 断言组:A 登录态建立 / B API 口径 has_spark_ui=false / C 桌面+移动菜单无 Spark UI 入口(未填 Apollo)
//         D 非 Spark 数据源零变化(菜单无入口 + SELECT 1 行为正常) / E admin 表单未填回显为空 + 非 Spark 不渲染 UI 字段
// 输出:截图 + results-phase1.json + log-phase1-network.json(全部脱敏)。任一断言失败仍继续跑完,退出码非零。
// 选择器依据(生产部署对应代码):
//   桌面切换器 button[class*="w-[140px]"](Query.tsx 桌面头),桌面弹层 div[class*="top-full"],
//   移动弹层 div[class*="bottom-full"](同一 showDbMenu 状态),Spark UI 入口 = 文案含 "Spark UI" 的按钮(SparkUiMenuLink 未填时整体不渲染),
//   连接按钮 button[class*="sm:w-[100px]"] aria-pressed=false→true(ConnectButton),Run 按钮 button.btn-primary 文案 Run/运行,
//   编辑表单 div.card:has(h2:has-text(name)),kind 文本 SparkSQL,#db-spark-ui-url / #db-spark-ui-platform-token,取消 = 卡内 btn-secondary。
// 注意:hasText 一律用非锚定正则/子串(按钮 innerText 含图标与空白,锚定正则会失配);菜单开合需状态感知(切换器为 toggle)。
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
  checks.push({ id, name, pass: !!pass, detail: String(detail || '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' — ' + detail : ''}`)
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

  // ── 网络监听(全程,脱敏) ────────────────────────────────────────
  const net = []
  let dbsApiBody = null
  let refreshStatus = null
  let queryResult = null
  let probeStatus = null
  let sparkUiRequests = 0
  const redact = (u) => u.replace(/([?&](token|db)=)[^&]*/gi, '$1<redacted>')
  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('/spark-ui')) sparkUiRequests++
    if (url.includes('/api/auth/refresh')) refreshStatus = res.status()
    if (url.includes('/api/query/probe')) probeStatus = res.status()
    if (url.includes('/api/databases') && res.request().method() === 'GET' && dbsApiBody === null) {
      try {
        const j = await res.json()
        if (Array.isArray(j)) {
          // 只提取非敏感字段,不落原始响应(响应可能含连接串)
          dbsApiBody = j.map((d) => ({ name: d.name, kind: d.kind, has_spark_ui: d.has_spark_ui, id: d.id }))
        }
      } catch {}
    }
    if (url.includes('/api/query') && res.request().method() === 'POST' && !url.includes('/probe')) {
      try {
        const j = await res.json()
        queryResult = { status: res.status(), results: Array.isArray(j.results) ? j.results.length : null, error: j.error ? String(j.error).slice(0, 120) : null }
      } catch {
        queryResult = { status: res.status(), parse: 'no-json' }
      }
    }
    let size = null
    try {
      size = (await res.body()).length
    } catch {}
    net.push({ url: redact(url), status: res.status(), size })
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))

  const shot = (name) => page.screenshot({ path: path.join(OUT, 'shots', `${name}.png`), fullPage: false })
  const DESK = { width: 1440, height: 900 }
  const MOBILE = { width: 390, height: 844 }

  // 菜单状态感知工具(切换器是 toggle,不能盲点)
  const desktopSwitcher = page.locator('button[class*="w-[140px]"]').first()
  async function desktopMenuOpen() {
    return (await page.locator('div[class*="top-full"]').first().isVisible().catch(() => false)) === true
  }
  async function ensureDesktopMenuOpen() {
    if (!(await desktopMenuOpen())) await desktopSwitcher.click()
    await page.waitForTimeout(350)
  }
  async function selectDbByName(name) {
    await ensureDesktopMenuOpen()
    await page.locator('div[class*="top-full"] button').filter({ hasText: name }).first().click()
    await page.waitForTimeout(450)
  }
  async function sparkUiEntryCount(scopeSel) {
    const scope = scopeSel ? page.locator(scopeSel).first() : page
    const btn = await scope.locator('button').filter({ hasText: 'Spark UI' }).count()
    const link = await scope.locator('a[href^="/spark-ui/"]').count()
    return { btn, link, total: btn + link }
  }

  // ── A. 登录态建立 ──────────────────────────────────────────────
  await page.goto(`${BASE}/query`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  let switcherVisible = false
  try {
    await desktopSwitcher.waitFor({ state: 'visible', timeout: 30000 })
    switcherVisible = true
  } catch {}
  await page.waitForTimeout(1500)
  record(
    'A1',
    '登录态建立(refresh 200 + /api/databases 200 + 查询页切换器渲染)',
    switcherVisible && refreshStatus === 200 && Array.isArray(dbsApiBody),
    `refresh=${refreshStatus} dbs=${Array.isArray(dbsApiBody) ? dbsApiBody.length : 'n/a'} switcher=${switcherVisible}`
  )
  await shot('phase1-A1-query-desktop')

  if (!Array.isArray(dbsApiBody)) {
    fs.writeFileSync(
      path.join(OUT, 'results-phase1.json'),
      JSON.stringify({ run_at: new Date().toISOString(), fatal: 'no /api/databases body captured', refresh: refreshStatus, switcher_visible: switcherVisible, page_errors: pageErrors }, null, 2)
    )
    fs.writeFileSync(path.join(OUT, 'log-phase1-network.json'), JSON.stringify(net.slice(0, 500), null, 2))
    await shot('phase1-FATAL-no-dbs')
    await browser.close()
    process.exit(1)
  }

  const apollo = dbsApiBody.find((d) => d.id === APOLLO_ID)
  const sparkDbs = dbsApiBody.filter((d) => d.kind === 'spark')
  const nonSpark = dbsApiBody.filter((d) => d.kind !== 'spark')

  // ── B. API 口径 ───────────────────────────────────────────────
  record('B1', 'Apollo(spark) has_spark_ui=false(未填口径)', !!apollo && apollo.has_spark_ui === false, apollo ? JSON.stringify({ has_spark_ui: apollo.has_spark_ui }) : 'Apollo missing')
  record('B2', 'Spark 数据源恰好一个且为 Apollo', sparkDbs.length === 1 && !!apollo, sparkDbs.map((d) => d.name).join(','))
  record('B3', '非 Spark 数据源 has_spark_ui 均为假值', nonSpark.every((d) => !d.has_spark_ui), nonSpark.map((d) => `${d.name}(${d.kind})`).join(','))

  // ── C. 菜单无 Spark UI 入口(未填 Apollo;桌面 + 移动) ────────────
  if (apollo) {
    await selectDbByName('Apollo')
    const swText = (await desktopSwitcher.textContent()) || ''
    record('C0', '切换器显示 Apollo(选中成功)', swText.includes('Apollo'), `switcher="${swText.trim().slice(0, 40)}"`)
    // 桌面
    await ensureDesktopMenuOpen()
    const menuOpen = await desktopMenuOpen()
    const menuHasApollo = ((await page.locator('div[class*="top-full"]').first().textContent().catch(() => '')) || '').includes('Apollo')
    const deskEntry = await sparkUiEntryCount('div[class*="top-full"]')
    const pageWide = await sparkUiEntryCount(null)
    record('C1', '桌面菜单(未填 Apollo)无 Spark UI 入口', menuOpen && menuHasApollo && deskEntry.total === 0 && pageWide.total === 0, `menu_open=${menuOpen} contains_apollo=${menuHasApollo} scoped=${JSON.stringify(deskEntry)} page_wide=${JSON.stringify(pageWide)}`)
    await shot('phase1-C1-menu-apollo-unfilled')
    // 移动端(同一组件同条件;showDbMenu 状态共享,勿再点触发按钮)
    await page.setViewportSize(MOBILE)
    await page.waitForTimeout(600)
    let mOpen = (await page.locator('div[class*="bottom-full"]').first().isVisible().catch(() => false)) === true
    let mDiag = ''
    if (!mOpen) {
      try {
        await page.locator('button:visible').filter({ hasText: 'Apollo' }).first().click({ timeout: 8000 })
        await page.waitForTimeout(450)
        mOpen = (await page.locator('div[class*="bottom-full"]').first().isVisible().catch(() => false)) === true
      } catch (e) {
        mDiag = `trigger_click_error: ${String(e).split('\n')[0].slice(0, 120)}`
      }
    }
    const mEntry = mOpen ? await sparkUiEntryCount('div[class*="bottom-full"]') : { btn: -1, link: -1, total: -1 }
    const mPageWide = await sparkUiEntryCount(null)
    record('C2', '移动菜单(未填 Apollo)无 Spark UI 入口', mOpen && mEntry.total === 0 && mPageWide.total === 0, `menu_open=${mOpen} scoped=${JSON.stringify(mEntry)} page_wide=${JSON.stringify(mPageWide)} ${mDiag}`)
    await shot('phase1-C2-menu-apollo-mobile')
    await page.setViewportSize(DESK)
    await page.waitForTimeout(500)
  } else {
    record('C1', '桌面/移动菜单(未填 Apollo)无 Spark UI 入口', false, 'skipped: Apollo not in /api/databases')
  }

  // ── D. 非 Spark 零变化 ─────────────────────────────────────────
  for (const db of nonSpark) {
    try {
      await selectDbByName(db.name)
      await ensureDesktopMenuOpen()
      const menuOpen = await desktopMenuOpen()
      const entry = await sparkUiEntryCount('div[class*="top-full"]')
      record(`D-menu-${db.kind}`, `${db.name}(${db.kind})桌面菜单无 Spark UI 入口`, menuOpen && entry.total === 0, `menu_open=${menuOpen} entry=${JSON.stringify(entry)}`)
      await shot(`phase1-D-menu-${db.kind}`)
    } catch (e) {
      record(`D-menu-${db.kind}`, `${db.name}(${db.kind})桌面菜单无 Spark UI 入口`, false, `error: ${String(e).split('\n')[0].slice(0, 150)}`)
    }
  }
  // 轻查询:第一个非 Spark 数据源上 SELECT 1(只读;显式连接后运行)
  if (nonSpark.length > 0) {
    const first = nonSpark[0]
    try {
      await selectDbByName(first.name)
      await page.waitForTimeout(600)
      // 连接(ConnectButton:未连接 btn-primary aria-pressed=false → 已连接 true)
      const cbtn = page.locator('button[class*="sm:w-[100px]"]').first()
      const pressed0 = await cbtn.getAttribute('aria-pressed')
      if (pressed0 === 'false') {
        await cbtn.click()
        await cbtn.waitFor({ state: 'visible', timeout: 15000 })
        for (let i = 0; i < 60; i++) {
          const p = await cbtn.getAttribute('aria-pressed')
          if (p === 'true') break
          await page.waitForTimeout(500)
        }
      }
      const pressed1 = await cbtn.getAttribute('aria-pressed')
      const probeOk = probeStatus === 200
      if (pressed1 !== 'true') throw new Error(`connect failed: aria-pressed=${pressed1} probe=${probeStatus}`)
      // 编辑器输入单条语句并运行
      const editor = page.locator('.cm-content[contenteditable="true"]').first()
      await editor.click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type('SELECT 1 AS one', { delay: 25 })
      await page.waitForTimeout(300)
      const runBtn = page.locator('button.btn-primary').filter({ hasText: /Run|运行/ }).first()
      await runBtn.click({ timeout: 15000 })
      for (let i = 0; i < 40; i++) {
        if (queryResult) break
        await page.waitForTimeout(500)
      }
      const ok = queryResult && queryResult.status === 200 && queryResult.results !== null && queryResult.results >= 1 && !queryResult.error
      record('D-query', `${first.name} 上 SELECT 1 行为正常(连接+200+结果集)`, ok, `probe=${probeStatus} aria=${pressed1} result=${JSON.stringify(queryResult)}`)
      await shot('phase1-D-query-nonspark')
    } catch (e) {
      record('D-query', `${first.name} 上 SELECT 1 行为正常(连接+200+结果集)`, false, `error: ${String(e).split('\n')[0].slice(0, 150)}`)
      await shot('phase1-D-query-error')
    }
  }

  // ── E. admin 表单 ─────────────────────────────────────────────
  try {
    await page.goto(`${BASE}/admin/databases`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.locator('tr').filter({ hasText: 'Apollo' }).first().waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('tr').filter({ hasText: 'Apollo' }).first().locator('button').filter({ hasText: /Edit|编辑/ }).first().click({ timeout: 15000 })
    const formCard = page.locator('div.card:has(h2:has-text("Apollo"))').first()
    await formCard.waitFor({ state: 'visible', timeout: 15000 })
    const isSparkKind = (await formCard.locator('p').filter({ hasText: 'SparkSQL' }).count()) > 0
    const uiUrlVal = await formCard.locator('#db-spark-ui-url').inputValue()
    const uiTokVal = await formCard.locator('#db-spark-ui-platform-token').inputValue()
    record('E1', 'Apollo 编辑表单:kind=SparkSQL 且 UI 两字段未填回显(空)', isSparkKind && uiUrlVal === '' && uiTokVal === '', `kind_spark=${isSparkKind} ui_url_len=${uiUrlVal.length} token_len=${uiTokVal.length}`)
    await shot('phase1-E1-form-apollo')
    await formCard.locator('button.btn-secondary').filter({ hasText: /Cancel|取消/ }).first().click({ timeout: 10000 })
    await page.waitForTimeout(600)
  } catch (e) {
    record('E1', 'Apollo 编辑表单:kind=SparkSQL 且 UI 两字段未填回显(空)', false, `error: ${String(e).split('\n')[0].slice(0, 150)}`)
    await shot('phase1-E1-form-error')
  }
  for (const name of ['Bubble', 'Tree']) {
    try {
      const row = page.locator('tr').filter({ hasText: name }).first()
      await row.waitFor({ state: 'visible', timeout: 15000 })
      await row.locator('button').filter({ hasText: /Edit|编辑/ }).first().click({ timeout: 15000 })
      const formCard = page.locator(`div.card:has(h2:has-text("${name}"))`).first()
      await formCard.waitFor({ state: 'visible', timeout: 15000 })
      const uiField = await formCard.locator('#db-spark-ui-url').count()
      const uiText = ((await formCard.textContent().catch(() => '')) || '').includes('Spark UI')
      record(`E2-${name}`, `${name} 编辑表单不渲染 Spark UI 字段`, uiField === 0 && !uiText, `field_count=${uiField} text_present=${uiText}`)
      await shot(`phase1-E2-form-${name}`)
      await formCard.locator('button.btn-secondary').filter({ hasText: /Cancel|取消/ }).first().click({ timeout: 10000 })
      await page.waitForTimeout(600)
    } catch (e) {
      record(`E2-${name}`, `${name} 编辑表单不渲染 Spark UI 字段`, false, `error: ${String(e).split('\n')[0].slice(0, 150)}`)
    }
  }

  // ── 结果 ──────────────────────────────────────────────────────
  const allPass = checks.every((c) => c.pass)
  fs.writeFileSync(
    path.join(OUT, 'results-phase1.json'),
    JSON.stringify(
      {
        run_at: new Date().toISOString(),
        base: BASE,
        all_pass: allPass,
        checks,
        spark_ui_requests_during_session: sparkUiRequests,
        page_errors: pageErrors,
        databases: dbsApiBody,
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(OUT, 'log-phase1-network.json'), JSON.stringify(net.slice(0, 600), null, 2))
  console.log(JSON.stringify({ all_pass: allPass, total: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.id), spark_ui_requests: sparkUiRequests }))
  await browser.close()
  if (!allPass) process.exit(2)
})().catch((e) => {
  console.error('FATAL', e.message.split('\n')[0])
  process.exit(1)
})

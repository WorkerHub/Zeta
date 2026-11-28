// QA018 第二段:已填状态全链路(登录态;凭据经 QA018_REFRESH_TOKEN 环境变量注入,一次性,不落盘)
// #4 菜单点击整链路(POST /api/spark-ui/session → popup /spark-ui/)+ 首击 ?db= 302 契约 + cookie 口径
// #5 长查询实时进度 + job group 文本核对(Spark UI Jobs/SQL 页)
// #6 四页逐页渲染 + 静态资源硬性检查(CSS/JS 实际加载 + 带样式渲染 + href/src 原值清单 + 失败资源清单)
//    —— 用户控制台证据:样式表请求落到页面自身 URL 返回 text/html,MIME 不匹配被拒(阻断级取证对象)
// #7 泄露核对(请求主机白名单/accessToken 不进 URL/:4040 痕迹/API 响应无 UI 字段回显)
// 输出:截图 + results-phase2.json + log-phase2-network.json + 404-resources.json + spark-ui-html-links.json
//      + console-errors.json + 页面 HTML 存档(全部脱敏)。任一断言失败仍继续跑完,退出码非零。
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
const LONG_SQL = 'SELECT sum(id % 7) AS s FROM range(5000000000)'
const SQL_FRAGMENT = 'range(5000000000)'
const T0 = Date.now()
const DEADLINE_MS = 9.5 * 60 * 1000
const left = () => DEADLINE_MS - (Date.now() - T0)

if (!REFRESH) {
  console.error('FATAL: QA018_REFRESH_TOKEN not set')
  process.exit(1)
}

const checks = []
function record(id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail: String(detail || '').slice(0, 1600) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`)
}
const redact = (u) => u.replace(/([?&](token|db)=)[^&]*/gi, '$1<redacted>')
const cookieFlags = (sc) => {
  const parts = String(sc).split(';').map((s) => s.trim())
  const name = (parts[0] || '').split('=')[0]
  return { name, flags: parts.slice(1).join('; ') }
}

;(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true })
  const browser = await chromium.launch({ executablePath: EXEC })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([
    { name: 'refresh_token', value: REFRESH, domain: 'zeta.pama.workers.dev', path: '/api/auth', httpOnly: true, secure: true, sameSite: 'Strict' },
  ])

  // ── 网络与控制台监听( context 级,覆盖主 tab 与 popup ) ─────────────
  const net = []
  const consoleMsgs = []
  const apiBodies = [] // 仅内存,用于泄露扫描;不落原始响应
  let netSection = 'startup'
  let refreshStatus = null
  let accessToken = null // 内存持有,仅用于 URL 泄露扫描,绝不写入文件
  let dbsBody = null
  let dbsKeys = null
  let sessionPost = null // { status, setCookie }
  let firstHit = null // { status, location, setCookie, url }
  let queryResult = null
  let probeStatus = null
  const sec = (s) => { netSection = s }

  context.on('response', async (res) => {
    const url = res.url()
    const entry = { section: netSection, url: redact(url), status: res.status(), ctype: null, rtype: res.request().resourceType() }
    try { entry.ctype = (res.headers()['content-type'] || '').split(';')[0] } catch {}
    if (accessToken && url.includes(accessToken)) entry.token_in_url = true
    if (url.includes('4040')) entry.has_4040 = true
    net.push(entry)
    try {
      if (url.includes('/api/auth/refresh') && res.request().method() === 'POST') {
        refreshStatus = res.status()
        const j = await res.json().catch(() => null)
        if (j && j.accessToken) accessToken = j.accessToken
      } else if (url.includes('/api/databases') && res.request().method() === 'GET' && !dbsBody) {
        const j = await res.json().catch(() => null)
        if (Array.isArray(j)) {
          dbsKeys = Object.keys(j[0] || {})
          dbsBody = j.map((d) => ({ name: d.name, kind: d.kind, has_spark_ui: d.has_spark_ui, id: d.id }))
          apiBodies.push({ url: redact(url), status: res.status(), text: JSON.stringify(j.map((d) => ({ ...d }))).slice(0, 150000) })
        }
      } else if (url.includes('/api/spark-ui/session') && res.request().method() === 'POST') {
        const hs = await res.allHeaders().catch(() => ({}))
        const arr = await res.headersArray().catch(() => [])
        const sc = (arr.find((h) => h.name.toLowerCase() === 'set-cookie') || {}).value || hs['set-cookie'] || null
        sessionPost = { status: res.status(), setCookie: sc ? cookieFlags(sc) : null }
      } else if (url.includes('/spark-ui/?db=')) {
        const hs = await res.allHeaders().catch(() => ({}))
        const arr = await res.headersArray().catch(() => [])
        const sc = (arr.find((h) => h.name.toLowerCase() === 'set-cookie') || {}).value || hs['set-cookie'] || null
        firstHit = { status: res.status(), location: hs['location'] || null, setCookie: sc ? cookieFlags(sc) : null, url: redact(url) }
      } else if (url.includes('/api/query/probe')) {
        probeStatus = res.status()
      } else if (url.includes('/api/query') && res.request().method() === 'POST' && !url.includes('/probe')) {
        const j = await res.json().catch(() => null)
        queryResult = j
          ? { status: res.status(), results: Array.isArray(j.results) ? j.results.length : null, error: j.error ? String(j.error).slice(0, 160) : null, duration_ms: j.duration_ms ?? null, keys: Object.keys(j) }
          : { status: res.status(), parse: 'no-json' }
        apiBodies.push({ url: redact(url), status: res.status(), text: JSON.stringify(j || {}).slice(0, 150000) })
      } else if (/\/api\//.test(url) && !url.includes('/api/auth/refresh')) {
        const t = await res.text().catch(() => null)
        if (t) apiBodies.push({ url: redact(url), status: res.status(), text: t.slice(0, 150000) })
      }
    } catch {}
  })

  const attachPage = (pg, tag) => {
    pg.on('console', (m) => {
      const t = m.type() + ': ' + (m.text() || '')
      if (/refused to apply|MIME|error/i.test(t)) consoleMsgs.push({ page: tag, text: t.slice(0, 400) })
    })
    pg.on('pageerror', (e) => consoleMsgs.push({ page: tag, type: 'pageerror', text: String(e).slice(0, 300) }))
  }

  const page = await context.newPage()
  attachPage(page, 'main')
  const shotMain = (n) => page.screenshot({ path: path.join(OUT, 'shots', `${n}.png`) }).catch(() => {})

  const DESK = { width: 1440, height: 900 }
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

  let popup = null
  let resultsSaved = false
  const styleProbes = {}
  const linksByPage = {}
  const failedResources = [] // { section, url, status, ctype, rtype, kind: 'http-error'|'mime-html' }
  let popupLanded = false

  const saveAll = async () => {
    if (resultsSaved) return
    resultsSaved = true
    const allPass = checks.length > 0 && checks.every((c) => c.pass)
    fs.writeFileSync(
      path.join(OUT, 'results-phase2.json'),
      JSON.stringify({ run_at: new Date().toISOString(), base: BASE, all_pass: checks.length > 0 && allPass, checks, page_errors: [], databases: dbsBody, query_result: queryResult, session_post: sessionPost, first_hit: firstHit, style_probes: styleProbes, failed_resources_count: failedResources.length, console_flagged_count: consoleMsgs.length, elapsed_ms: Date.now() - T0 }, null, 2)
    )
    fs.writeFileSync(path.join(OUT, 'log-phase2-network.json'), JSON.stringify(net.slice(0, 1500), null, 2))
    fs.writeFileSync(path.join(OUT, '404-resources.json'), JSON.stringify({ note: '静态资源失败清单(4xx 或 MIME=text/html 的样式/脚本);URL 中 query 参数已脱敏', failed: failedResources }, null, 2))
    fs.writeFileSync(path.join(OUT, 'spark-ui-html-links.json'), JSON.stringify(linksByPage, null, 2))
    fs.writeFileSync(path.join(OUT, 'console-errors.json'), JSON.stringify(consoleMsgs.slice(0, 80), null, 2))
    console.log(JSON.stringify({ all_pass: allPass, total: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.id), failed_resources: failedResources.length }))
  }

  try {
    // ── S0 登录态建立 + 门槛(已填口径) ─────────────────────────────
    sec('login')
    await page.goto(`${BASE}/query`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    let switcherVisible = false
    try { await desktopSwitcher.waitFor({ state: 'visible', timeout: 30000 }); switcherVisible = true } catch {}
    await page.waitForTimeout(1500)
    const apollo = (dbsBody || []).find((d) => d.id === APOLLO_ID)
    const gateOk = refreshStatus === 200 && !!apollo && apollo.has_spark_ui === true
    record('P0', '登录态 + Apollo has_spark_ui=true(已填口径门槛)', gateOk, `refresh=${refreshStatus} apollo=${apollo ? JSON.stringify({ has_spark_ui: apollo.has_spark_ui }) : 'missing'} dbs=${Array.isArray(dbsBody) ? dbsBody.length : 'n/a'} switcher=${switcherVisible}`)
    await shotMain('phase2-P0-query-logged-in')
    if (!gateOk) {
      await shotMain('phase2-FATAL-gate')
      await saveAll()
      await browser.close()
      process.exit(1)
    }
    record('P0b', '/api/databases 响应无 ui_url/ui_platform_token 键(字段不回显)', dbsKeys ? !dbsKeys.includes('ui_url') && !dbsKeys.includes('ui_platform_token') : false, `keys=${JSON.stringify(dbsKeys)}`)

    // ── S1 选中 Apollo 并连接 ──────────────────────────────────────
    sec('connect')
    await selectDbByName('Apollo')
    const swText = ((await desktopSwitcher.textContent()) || '').trim()
    const cbtn = page.locator('button[class*="sm:w-[100px]"]').first()
    const pressed0 = await cbtn.getAttribute('aria-pressed')
    if (pressed0 === 'false') {
      await cbtn.click()
      for (let i = 0; i < 70 && left() > 60000; i++) {
        const p = await cbtn.getAttribute('aria-pressed')
        if (p === 'true') break
        await page.waitForTimeout(500)
      }
    }
    const pressed1 = await cbtn.getAttribute('aria-pressed')
    record('P1', 'Apollo 连接成功(ConnectButton aria-pressed=true,probe 200)', pressed1 === 'true' && probeStatus === 200, `aria=${pressed0}→${pressed1} probe=${probeStatus} switcher="${swText.slice(0, 30)}"`)

    // ── S2 长查询启动(不等待响应) ──────────────────────────────────
    sec('run')
    const editor = page.locator('.cm-content[contenteditable="true"]').first()
    await editor.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(LONG_SQL, { delay: 20 })
    await page.waitForTimeout(400)
    const runBtn = page.locator('button.btn-primary').filter({ hasText: /Run|运行/ }).first()
    await runBtn.click({ timeout: 15000 })
    await page.waitForTimeout(800)
    await shotMain('phase2-S2-run-clicked')
    console.log(`RUN clicked at ${Math.round((Date.now() - T0) / 1000)}s: ${LONG_SQL}`)

    // ── S3 菜单点击整链路(#4):入口可见 → POST session → popup ───────
    sec('menu-click')
    await ensureDesktopMenuOpen()
    const entryBtn = page.locator('div[class*="top-full"] button').filter({ hasText: 'Spark UI' }).first()
    const entryCount = await entryBtn.count()
    await shotMain('phase2-S3-menu-filled-entry')
    record('P4pre', '已填状态下桌面菜单出现 Spark UI 入口', entryCount >= 1, `entry_count=${entryCount}`)
    if (entryCount === 0) throw new Error('menu entry missing — cannot continue #4 chain')
    const popupPromise = context.waitForEvent('page', { timeout: 25000 })
    await entryBtn.click()
    popup = await popupPromise
    attachPage(popup, 'popup')
    sec('popup-landing')
    try { await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }) } catch {}
    await popup.waitForTimeout(1500)
    const popupUrl = popup.url()
    popupLanded = popupUrl.startsWith(BASE + '/spark-ui')
    const popupText = ((await popup.evaluate(() => document.body.innerText).catch(() => '')) || '').slice(0, 4000)
    record('P4b', '菜单点击 → 新标签页落在 /spark-ui/* 且渲染 Jobs 内容', popupLanded && /jobs/i.test(popupText), `popup_url=${popupUrl} jobs_text=${/jobs/i.test(popupText)}`)
    await popup.screenshot({ path: path.join(OUT, 'shots', 'phase2-P4b-popup-landing.png') }).catch(() => {})
    record('P4a', 'POST /api/spark-ui/session 建会话(204 + Set-Cookie spark_ui_session)', !!sessionPost && sessionPost.status === 204 && sessionPost.setCookie && sessionPost.setCookie.name === 'spark_ui_session', JSON.stringify(sessionPost))

    // cookie 口径(context.cookies 权威口径)
    const cookies = await context.cookies(BASE + '/spark-ui/')
    const sess = cookies.find((c) => c.name === 'spark_ui_session')
    const sessAttrs = sess ? { httpOnly: sess.httpOnly, path: sess.path, sameSite: sess.sameSite, secure: sess.secure, maxAgeApprox: Math.round(sess.expires - Date.now() / 1000) } : null
    record('P4c', 'spark_ui_session cookie 口径(HttpOnly/Path=/spark-ui/Max-Age≈86400/SameSite=Lax/Secure)', !!sess && sess.httpOnly === true && sess.path === '/spark-ui' && sess.sameSite === 'Lax' && sess.secure === true && sessAttrs.maxAgeApprox > 86000 && sessAttrs.maxAgeApprox < 86800, JSON.stringify(sessAttrs))

    // ── S4 落地页静态资源审计(#6 阻断级取证,Jobs 页) ────────────────
    const auditPage = async (pg, key, shotName) => {
      const inv = await pg.evaluate(() => {
        const pageUrl = location.href
        const items = []
        for (const l of document.querySelectorAll('link')) {
          const raw = l.getAttribute('href')
          items.push({ tag: 'link', rel: l.rel || null, raw: raw === null ? null : raw, resolved: raw ? l.href : null })
        }
        for (const s of document.querySelectorAll('script[src]')) {
          const raw = s.getAttribute('src')
          items.push({ tag: 'script', raw, resolved: raw ? s.src : null })
        }
        return { pageUrl, items }
      }).catch(() => null)
      if (inv) {
        for (const it of inv.items) {
          if (it.tag === 'link' && it.rel && !/stylesheet|icon|alternate/i.test(it.rel)) continue
          const pageUrlClean = inv.pageUrl.split('#')[0]
          const resolvedClean = it.resolved ? it.resolved.split('#')[0] : null
          const selfPointing = !it.raw || it.raw === '.' || it.raw === './' || it.raw === '#' || (resolvedClean === pageUrlClean)
          const outsidePrefix = resolvedClean ? resolvedClean.startsWith(BASE + '/spark-ui') === false : false
          it.classification = selfPointing ? 'self-pointing(指回页面)' : outsidePrefix ? 'outside-prefix(逃出 /spark-ui 前缀)' : 'in-prefix'
        }
        linksByPage[key] = inv
      }
      const probe = await pg.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel*="style"]')).map((l) => ({ href: l.getAttribute('href'), loaded: !!(l.sheet && l.sheet.cssRules) }))
        const el = document.querySelector('h1,h2,th,td')
        return { styleSheets: document.styleSheets.length, styleLinks: links, bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 60), sampleBg: el ? getComputedStyle(el).backgroundColor : null, sampleBorderTop: el ? getComputedStyle(el).borderTopWidth : null }
      }).catch(() => null)
      styleProbes[key] = probe
      await pg.screenshot({ path: path.join(OUT, 'shots', `${shotName}.png`) }).catch(() => {})
      return { inv, probe }
    }
    const auditFromNet = (section) => {
      for (const e of net) {
        if (e.section !== section) continue
        const isAsset = ['stylesheet', 'script', 'image', 'font'].includes(e.rtype)
        if (!isAsset) continue
        if (e.status >= 400) failedResources.push({ section, kind: 'http-error', url: e.url, status: e.status, ctype: e.ctype, rtype: e.rtype })
        else if ((e.rtype === 'stylesheet' || e.rtype === 'script') && e.ctype && e.ctype.includes('text/html')) failedResources.push({ section, kind: 'mime-html', url: e.url, status: e.status, ctype: e.ctype, rtype: e.rtype })
      }
    }
    auditFromNet('popup-landing')
    const landingAudit = await auditPage(popup, 'landing-jobs', 'phase2-S4-landing-jobs-unstyled')
    const landingLinks = (landingAudit.inv ? landingAudit.inv.items : []).filter((i) => i.tag === 'link' && /stylesheet/i.test(i.rel || '') || (i.tag === 'script'))
    const selfStyles = landingLinks.filter((i) => i.classification === 'self-pointing(指回页面)')
    const outStyles = landingLinks.filter((i) => i.classification === 'outside-prefix(逃出 /spark-ui 前缀)')
    const landingStyledOk = landingAudit.probe && landingAudit.probe.styleSheets > 0 && landingAudit.probe.styleLinks.length > 0 && landingAudit.probe.styleLinks.every((l) => l.loaded)
    record('P6-landing-style', '落地页(Jobs)带样式渲染(styleSheets>0 且样式表全部加载成功)', !!landingStyledOk, JSON.stringify(landingAudit.probe))
    record('P6-landing-assets', '落地页静态资源加载失败清单(4xx 或 MIME=text/html)', failedResources.length === 0, `failed=${failedResources.length} sample=${JSON.stringify(failedResources.slice(0, 5))}`)
    console.log('LANDING-HREF-SUMMARY stylescripts=' + JSON.stringify({ total: landingLinks.length, selfPointing: selfStyles.length, outsidePrefix: outStyles.length, samples: landingLinks.slice(0, 8).map((i) => ({ raw: i.raw, cls: i.classification })) }))

    // ── S5 实时进度观测(#5):Jobs 轮询 → SQL 页 → 回 Jobs ────────────
    sec('jobs-running')
    const jobsSnapshots = []
    const snapJobs = async (tag) => {
      const s = await popup.evaluate(() => {
        const lines = (document.body.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean)
        const idx = (re) => lines.findIndex((l) => re.test(l))
        const a = idx(/active jobs/i)
        const c = idx(/completed jobs/i)
        return { rows: document.querySelectorAll('tbody tr').length, active: a >= 0 ? lines.slice(a, a + 2).join(' | ').slice(0, 160) : null, completed: c >= 0 ? lines.slice(c, c + 2).join(' | ').slice(0, 160) : null, zeta: lines.filter((l) => /zeta/i.test(l)).slice(0, 8).map((l) => l.slice(0, 200)), hasProgress: document.querySelectorAll('[class*="progress"], .bar').length }
      }).catch(() => null)
      if (s) { s.at_ms = Date.now() - T0; s.tag = tag; jobsSnapshots.push(s) }
      return s
    }
    let sawActive = false
    let sawSqlFragmentInSqlPage = false
    let sqlPageZeta = null
    let sqlPageText = null
    for (let i = 0; i < 11 && left() > 120000; i++) {
      if (queryResult) break
      const s = await snapJobs(`running-${i}`)
      if (s && (/(active jobs\|? ?\d|[1-9]\d* (running|active))/i.test(JSON.stringify(s)) || (s.active && /\d/.test(s.active)))) sawActive = sawActive || s.rows > 0
      if (i === 1) await popup.screenshot({ path: path.join(OUT, 'shots', 'phase2-S5-jobs-running-1.png') }).catch(() => {})
      if (i === 4) await popup.screenshot({ path: path.join(OUT, 'shots', 'phase2-S5-jobs-running-2.png') }).catch(() => {})
      if (i === 3 && !queryResult) {
        sec('sql-running')
        await popup.goto(`${BASE}/spark-ui/sql/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        await popup.waitForTimeout(1200)
        sqlPageText = ((await popup.evaluate(() => document.body.innerText).catch(() => '')) || '').slice(0, 6000)
        sqlPageZeta = sqlPageText.split('\n').map((x) => x.trim()).filter((l) => /zeta/i.test(l)).slice(0, 6).map((l) => l.slice(0, 200))
        sawSqlFragmentInSqlPage = sqlPageText.includes(SQL_FRAGMENT) || sqlPageText.includes('sum(id')
        await popup.screenshot({ path: path.join(OUT, 'shots', 'phase2-S5-sql-running.png') }).catch(() => {})
        sec('jobs-completion-wait')
        await popup.goto(`${BASE}/spark-ui/jobs/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        await popup.waitForTimeout(800)
      }
      await popup.waitForTimeout(8000)
    }
    // 等查询响应(查询页 POST /api/query)
    for (let i = 0; i < 60 && !queryResult && left() > 60000; i++) await page.waitForTimeout(2000)
    sec('jobs-completed')
    await popup.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await popup.waitForTimeout(1200)
    const completedSnap = await snapJobs('completed')
    await popup.screenshot({ path: path.join(OUT, 'shots', 'phase2-S5-jobs-completed.png') }).catch(() => {})
    const zetaSeen = jobsSnapshots.flatMap((s) => s.zeta || [])
    record('P5a', '长查询运行期间 Jobs 页可观测(轮询快照≥1 且作业行出现)', jobsSnapshots.length > 0 && jobsSnapshots.some((s) => (s.rows || 0) > 0), `snapshots=${jobsSnapshots.length} rows_seen=${jobsSnapshots.map((s) => s.rows).join(',')} query=${JSON.stringify(queryResult)}`)
    record('P5b', 'job group 文本可见且含 zeta 标识(会话/执行口径,文本留档比对)', zetaSeen.length > 0, `zeta_lines=${JSON.stringify(zetaSeen.slice(0, 4))}`)
    record('P5c', 'SQL 页可见执行记录(描述含本查询 SQL 片段或 zeta 标识)', !!sqlPageText && (sawSqlFragmentInSqlPage || (sqlPageZeta && sqlPageZeta.length > 0)), `fragment=${sawSqlFragmentInSqlPage} zeta=${JSON.stringify((sqlPageZeta || []).slice(0, 2))}`)
    record('P5d', '查询完成(200 且无错误;失败/取消如实记录)', !!queryResult && queryResult.status === 200 && !queryResult.error, JSON.stringify(queryResult))

    // ── S6 四页逐页审计(#6) ────────────────────────────────────────
    sec('four-pages')
    const pageResults = {}
    const navViolations = []
    for (const name of ['jobs', 'stages', 'sql', 'environment']) {
      sec(`page-${name}`)
      await popup.goto(`${BASE}/spark-ui/${name}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await popup.waitForTimeout(1500)
      auditFromNet(`page-${name}`)
      const finalUrl = popup.url()
      const marker = { jobs: /spark jobs|jobs/i, stages: /stages/i, sql: /sql/i, environment: /environment|runtime/i }[name]
      const text = ((await popup.evaluate(() => document.body.innerText).catch(() => '')) || '').slice(0, 5000)
      await auditPage(popup, `page-${name}`, `phase2-S6-page-${name}`)
      const navLinks = await popup.$$eval('a[href]', (as) => as.map((a) => ({ raw: a.getAttribute('href'), resolved: a.href, text: (a.textContent || '').trim().slice(0, 24) }))).catch(() => [])
      for (const nl of navLinks) {
        if (!nl.resolved || nl.raw === '#') continue
        if (nl.resolved.startsWith(BASE) && !nl.resolved.startsWith(BASE + '/spark-ui')) navViolations.push({ page: name, raw: nl.raw, resolved: nl.resolved, text: nl.text })
      }
      pageResults[name] = { finalUrl, inPrefix: finalUrl.startsWith(BASE + '/spark-ui'), markerOk: marker.test(text), navLinksCount: navLinks.length }
      await popup.screenshot({ path: path.join(OUT, 'shots', `phase2-S6-${name}.png`) }).catch(() => {})
    }
    const fourOk = Object.values(pageResults).every((r) => r.inPrefix && r.markerOk)
    record('P6a', '四页逐页打开:HTML 200、最终 URL 保持在 /spark-ui/ 前缀、页内链接不逃出前缀', fourOk && navViolations.length === 0, `pages=${JSON.stringify(pageResults)} nav_violations=${JSON.stringify(navViolations.slice(0, 5))}`)
    const allStyled = Object.entries(styleProbes).filter(([k]) => k.startsWith('page-')).every(([, p]) => p && p.styleSheets > 0 && p.styleLinks.length > 0 && p.styleLinks.every((l) => l.loaded))
    record('P6b', '四页带样式渲染(样式表实际加载;非裸 HTML)', allStyled, `probes=${JSON.stringify(Object.fromEntries(Object.entries(styleProbes).filter(([k]) => k.startsWith('page-')).map(([k, p]) => [k, p ? { sheets: p.styleSheets, styleLinks: p.styleLinks.length, loaded: p.styleLinks.filter((l) => l.loaded).length } : null])))}`)
    record('P6c', '静态资源失败清单(全部页面合计;4xx 或 MIME=text/html)', failedResources.length === 0, `total_failed=${failedResources.length} kinds=${JSON.stringify(failedResources.reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] || 0) + 1 }), {}))}`)

    // 页面 HTML 存档(证据;截断;在泄露扫描前落盘供 Q7e 读取)
    try {
      const jobsHtml = await popup.content()
      fs.writeFileSync(path.join(OUT, 'spark-ui-html-page-jobs.html'), jobsHtml.slice(0, 300000))
      await popup.goto(`${BASE}/spark-ui/environment/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await popup.waitForTimeout(1000)
      const envHtml = await popup.content()
      fs.writeFileSync(path.join(OUT, 'spark-ui-html-page-environment.html'), envHtml.slice(0, 300000))
    } catch {}

    // ── S7 首击 ?db= 302 契约(#4;会话 cookie 已由菜单路径建立) ───────
    sec('first-hit')
    await page.goto(`${BASE}/spark-ui/?db=${APOLLO_ID}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const fhUrl = page.url()
    record('P4d', '首击 /spark-ui/?db=<id> → 302 + Set-Cookie + 落地 /spark-ui/*', !!firstHit && firstHit.status === 302 && (firstHit.location || '').startsWith('/spark-ui') && fhUrl.startsWith(BASE + '/spark-ui'), `status=${firstHit && firstHit.status} location=${firstHit && firstHit.location} set_cookie=${firstHit && firstHit.setCookie ? JSON.stringify(firstHit.setCookie) : 'n/a'} final_url=${fhUrl}`)
    await shotMain('phase2-S7-first-hit-landing')

    // ── S8 泄露核对(#7) ────────────────────────────────────────────
    sec('leak-scan')
    const origins = {}
    for (const e of net) {
      try { const o = new URL(e.url).origin; origins[o] = (origins[o] || 0) + 1 } catch {}
    }
    const foreign = Object.keys(origins).filter((o) => o !== BASE)
    record('Q7a', '全部请求主机 = 生产 origin(无第三方/上游主机)', foreign.length === 0, `origins=${JSON.stringify(origins)} foreign=${JSON.stringify(foreign)}`)
    const tokInUrl = net.filter((e) => e.token_in_url)
    record('Q7b', 'accessToken 不出现在任何请求 URL', tokInUrl.length === 0, `hits=${tokInUrl.length}`)
    const u4040url = net.filter((e) => e.has_4040)
    const api4040 = apiBodies.filter((b) => b.text.includes('4040'))
    const apiUiKeys = apiBodies.filter((b) => /"ui_platform_token"|"ui_url"/.test(b.text))
    record('Q7c', 'UI 发布地址痕迹(:4040)不出现在请求 URL 与 /api/* 响应体', u4040url.length === 0 && api4040.length === 0, `url_hits=${u4040url.length} api_body_hits=${api4040.map((b) => b.url)} ui_key_hits=${apiUiKeys.map((b) => b.url)}`)
    record('Q7d', '/api/databases 响应无 UI 字段回显(仅 has_spark_ui)', !apiUiKeys.some((b) => b.url.includes('/api/databases')) && !!dbsKeys && !dbsKeys.includes('ui_url') && !dbsKeys.includes('ui_platform_token'), `keys=${JSON.stringify(dbsKeys)}`)
    // 观察项(不定性为泄露):反代页面内容中的 :4040(存档已在 S6 后落盘)
    let html4040Note = null
    try {
      const html = fs.existsSync(path.join(OUT, 'spark-ui-html-page-environment.html')) ? fs.readFileSync(path.join(OUT, 'spark-ui-html-page-environment.html'), 'utf8') : null
      if (html && html.includes('4040')) html4040Note = 'environment 页面内容含 4040 字样(见 HTML 存档,待定性)'
    } catch {}
    record('Q7e', '观察项:反代页面内容 4040 字样(不定性,留报告判断)', true, html4040Note || '页面内容未见 4040')

    await saveAll()
    await browser.close()
  } catch (e) {
    console.error('SECTION-ERROR', String(e).split('\n')[0].slice(0, 200))
    try { await shotMain('phase2-ERROR-state') } catch {}
    record('FATAL', '脚本中断(已保存此前全部结果)', false, String(e).split('\n')[0].slice(0, 300))
    try { await popup?.screenshot({ path: path.join(OUT, 'shots', 'phase2-ERROR-popup.png') }).catch(() => {}) } catch {}
    await saveAll()
    await browser.close()
    process.exit(1)
  }
  const anyFail = checks.some((c) => !c.pass)
  process.exit(anyFail ? 2 : 0)
})().catch((e) => {
  console.error('FATAL', e.message && e.message.split('\n')[0])
  process.exit(1)
})

/* Zeta #7 拆页 QA —— 阶段 C：生产构建复核（web/dist 由 wrangler dev :8787 直供，模拟线上产物）
 * 目的：① 复核页面/路由/吸底栏在生产 bundle 下表现一致；② 观察 dev 模式的 StrictMode 双 refresh 竞态是否仅限开发模式。
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const REPO = process.env.ZETA_REPO || process.cwd()
const BASE = 'http://localhost:8787'
const EMAIL = 'qa-split@example.com'
const D1_DIR = path.join(REPO, 'worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const OUT = path.join(REPO, '.github/assets/qa')

fs.mkdirSync(OUT, { recursive: true })
const results = []
function check(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail) })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}\n      :: ${detail}`)
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name) })
  console.log(`      [截图] .github/assets/qa/${name}`)
}
function d1(sql) {
  for (const f of fs.readdirSync(D1_DIR)) {
    if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue
    try {
      const db = new DatabaseSync(path.join(D1_DIR, f), { readOnly: true })
      const rows = db.prepare(sql).all()
      db.close()
      return rows
    } catch {}
  }
  return null
}
/* 夹具：清掉本轮 QA 账号的 TOTP 凭据，便于纯密码登录（仅本地 D1） */
function resetTotp() {
  for (const f of fs.readdirSync(D1_DIR)) {
    if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue
    const p = path.join(D1_DIR, f)
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      const ok = db.prepare("SELECT name FROM sqlite_master WHERE name='zeta_users'").get()
      db.close()
      if (!ok) continue
      const w = new DatabaseSync(p)
      w.exec('PRAGMA busy_timeout=5000')
      const u = w.prepare('SELECT id FROM zeta_users WHERE email = ?').get(EMAIL)
      if (u) w.prepare('DELETE FROM zeta_totp_credentials WHERE user_id = ?').run(u.id)
      w.close()
      return 'ok'
    } catch {}
  }
  return 'skip'
}
const PW_CANDIDATES = ['qa-pass-123456', 'qa-pass-654321', 'qa-pass-777777', 'qa-pass-888888', 'qa-pass-999999']

let SESSION_DROPS = 0
async function login(page, pwd) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 20000 })
  await page.fill('#login-email', EMAIL)
  await page.fill('#login-password', pwd)
  await page.click('button[type=submit]')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25000 })
  await page.waitForTimeout(800)
}
async function gotoAuthed(page, p, waitSel, pwd) {
  let lastUrl = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    lastUrl = page.url()
    if (page.url().includes('/login')) {
      SESSION_DROPS++
      await login(page, pwd)
      if (page.url().includes('/query')) {
        await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(1500)
      }
    }
    if (!waitSel) return
    try {
      await page.waitForSelector(waitSel, { timeout: 15000 })
      return
    } catch (e) {
      lastUrl = page.url()
      if (page.url().includes('/login')) continue
      throw new Error(`${e.message}（URL=${lastUrl}）`)
    }
  }
  await page.waitForSelector(waitSel, { timeout: 15000 }).catch((e) => {
    throw new Error(`${e.message}（最后一次 URL=${lastUrl}）`)
  })
}

;(async () => {
  console.log('夹具复位:', resetTotp())
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('locale', 'zh')
    } catch {}
  })
  const page = await ctx.newPage()
  const chunkReqs = []
  page.on('request', (r) => {
    const u = r.url()
    if (/\/assets\/.*\.js$/.test(u)) chunkReqs.push(u.split('/assets/')[1])
  })

  let PASSWORD = null
  for (const pwd of PW_CANDIDATES) {
    try {
      await login(page, pwd)
      PASSWORD = pwd
      break
    } catch {}
  }
  if (!PASSWORD) {
    console.error('生产构建下无法登录，终止')
    process.exit(1)
  }
  console.log('生产构建登录成功，密码候选命中')

  /* C1 路由与 Tab 激活态 */
  await gotoAuthed(page, '/profile', '#profile-run-limit', PASSWORD)
  const tabState = () =>
    page.evaluate(() => {
      const pick = (label) => {
        const t = [...document.querySelectorAll('a,button')].find((e) => e.textContent.trim() === label)
        if (!t) return null
        const s = getComputedStyle(t)
        return {
          label,
          href: t.getAttribute('href'),
          w: s.borderBottomWidth,
          color: s.borderBottomColor,
          ariaCurrent: t.getAttribute('aria-current'),
        }
      }
      return { profile: pick('个人资料'), security: pick('安全设置') }
    })
  const profTab = await tabState()
  const profText = await page.locator('body').textContent()
  await gotoAuthed(page, '/security', 'text=修改密码', PASSWORD)
  const secTab = await tabState()
  const secText = await page.locator('body').textContent()
  check(
    'C1.1',
    '生产构建：/profile 与 /security 各自渲染各自内容（不互相串页）',
    profText.includes('账户') &&
      profText.includes('主题色') &&
      profText.includes('查询结果保留') &&
      !profText.includes('通行密钥') &&
      secText.includes('修改密码') &&
      secText.includes('验证器应用') &&
      secText.includes('通行密钥') &&
      !secText.includes('主题色'),
    `profile 含 账户=${profText.includes('账户')} 主题色=${profText.includes('主题色')} 查询结果保留=${profText.includes('查询结果保留')} 通行密钥=${profText.includes('通行密钥')}；security 含 修改密码=${secText.includes('修改密码')} 验证器应用=${secText.includes('验证器应用')} 通行密钥=${secText.includes('通行密钥')} 主题色=${secText.includes('主题色')}`
  )
  const activeW = (t) => (t.w === '2px' ? t.color : null)
  check(
    'C1.2',
    '生产构建：Tab 激活态随路由切换（当前页 Tab 2px 品牌色下边框，未激活页无品牌下边框）',
    activeW(profTab.profile) && !activeW(profTab.security) && activeW(secTab.security) && !activeW(secTab.profile),
    `/profile 页 Tab=${JSON.stringify(profTab)}；/security 页 Tab=${JSON.stringify(secTab)}`
  )

  /* C2 懒加载分包 */
  const lazy = ['AccountLayout', 'Profile', 'Security'].map((n) => chunkReqs.filter((c) => c.startsWith(n)).length)
  check(
    'C2.1',
    '生产构建：Profile/Security 按路由分包懒加载（命中独立 chunk 请求）',
    lazy[1] > 0 && lazy[2] > 0,
    `chunk 请求计数 AccountLayout/Profile/Security=${JSON.stringify(lazy)}；命中样例=${JSON.stringify(chunkReqs.filter((c) => /^(AccountLayout|Profile|Security)/.test(c)))}`
  )

  /* C3 吸底栏四态（生产构建） */
  await gotoAuthed(page, '/profile', '#profile-run-limit', PASSWORD)
  const readBar = () =>
    page.evaluate(() => {
      const bar = document.querySelector('section[aria-label="保存设置"]')
      if (!bar) return null
      const b = bar.querySelector('button')
      const s = getComputedStyle(bar)
      return {
        text: bar.textContent.replace(/\s+/g, ' ').trim(),
        disabled: b.disabled,
        position: s.position,
        bottom: s.bottom,
      }
    })
  const s1 = await readBar()
  const curVal = (await page.inputValue('#profile-run-limit')).trim()
  const TARGET = curVal === '42' ? '43' : '42'
  await page.fill('#profile-run-limit', TARGET)
  await page.waitForTimeout(350)
  const s2 = await readBar()
  await page.route('**/api/profile/run-settings', async (route) => {
    if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 1500))
    return route.continue()
  })
  await page.getByRole('button', { name: '保存更改' }).click()
  await page.waitForTimeout(500)
  const s3 = await readBar()
  await page.waitForTimeout(2500)
  const s4 = await readBar()
  await page.unroute('**/api/profile/run-settings')
  const db42 = d1(`SELECT notebook_run_limit AS run_limit FROM zeta_users WHERE email='${EMAIL}'`)
  const expectVal = Number(TARGET)
  check(
    'C3.1',
    '生产构建：吸底栏四态（已保存 → 有未保存更改 → 保存中… → 已保存！）+ 落库 42',
    s1.text.includes('已保存') &&
      s1.disabled === true &&
      s2.text.includes('有未保存更改') &&
      s2.disabled === false &&
      s3.text.includes('保存中') &&
      s3.disabled === true &&
      s4.text.includes('已保存！') &&
      s4.disabled === true &&
      db42 &&
      db42[0].run_limit === expectVal,
    `态1=${JSON.stringify(s1)}；态2=${JSON.stringify(s2)}；态3=${JSON.stringify(s3)}；态4=${JSON.stringify(s4)}；D1=${JSON.stringify(db42)}`
  )
  await shot(page, 'profile-production-build-sticky-bar.png')

  /* C4 Security 无统一保存栏 */
  await gotoAuthed(page, '/security', 'text=修改密码', PASSWORD)
  const secBar = await page.evaluate(() => ({
    stickyBars: document.querySelectorAll('section[aria-label="保存设置"]').length,
    saveBtns: [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '保存更改').length,
    actions: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()),
  }))
  check(
    'C4.1',
    '生产构建：Security 无吸底栏、无「保存更改」，只有各自动作按钮',
    secBar.stickyBars === 0 &&
      secBar.saveBtns === 0 &&
      secBar.actions.includes('更新密码') &&
      secBar.actions.includes('添加验证器应用') &&
      secBar.actions.includes('添加通行密钥'),
    JSON.stringify(secBar)
  )

  /* C5 /profile/security 与 /account* */
  await gotoAuthed(page, '/profile/security', 'text=修改密码', PASSWORD)
  const redirectUrl = page.url()
  const acc = []
  for (const p of ['/account', '/account/profile', '/account/security']) {
    await gotoAuthed(page, p, null, PASSWORD)
    await page.waitForTimeout(800)
    const t = await page.locator('body').textContent()
    acc.push({ p, url: page.url(), isProfile: t.includes('运行设置'), isSecurity: t.includes('验证器应用') })
  }
  check(
    'C5.1',
    '生产构建：/profile/security → /security；/account* 旧别名不渲染账号页',
    redirectUrl.endsWith('/security') && acc.every((a) => !a.isProfile && !a.isSecurity),
    `跳转=${redirectUrl}；别名=${JSON.stringify(acc)}`
  )

  /* C6 移动端 safe-area（生产构建） */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  await mctx.addInitScript(() => {
    try {
      localStorage.setItem('locale', 'zh')
    } catch {}
  })
  const mp = await mctx.newPage()
  const cdp = await mctx.newCDPSession(mp)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 34 } })
  await gotoAuthed(mp, '/profile', '#profile-run-limit', PASSWORD)
  await mp.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await mp.waitForTimeout(700)
  const m = await mp.evaluate(() => {
    const bar = document.querySelector('section[aria-label="保存设置"]')
    const b = bar.querySelector('button')
    const r = bar.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    return {
      pad: getComputedStyle(bar).paddingBottom,
      barBottom: Math.round(r.bottom),
      barWidth: Math.round(r.width),
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      btnBottom: Math.round(br.bottom),
    }
  })
  check(
    'C6.1',
    '生产构建（移动端 390×844，safe-area 34px）：吸底栏 padding-bottom=34px 且贴底铺满',
    m.pad === '34px' && m.barBottom === m.innerH && m.barWidth === m.innerW && m.btnBottom <= m.innerH - 34 + 1,
    JSON.stringify(m)
  )
  await shot(mp, 'profile-production-build-mobile-safe-area.png')

  /* 刷新竞态对比：同一套导航序列分别在生产构建(:8787)与 Vite dev(:5173) 跑一遍，统计 refresh 401 与掉登录态 */
  async function measure(base, label) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await c.addInitScript(() => {
      try {
        localStorage.setItem('locale', 'zh')
      } catch {}
    })
    const p = await c.newPage()
    await login(p, PASSWORD)
    let refresh = 0
    let refresh401 = 0
    const h = (resp) => {
      if (/\/api\/auth\/refresh/.test(resp.url())) {
        refresh++
        if (resp.status() >= 400) refresh401++
      }
    }
    p.on('response', h)
    let landed = 0
    for (const route of ['/query', '/profile', '/security', '/profile', '/query']) {
      await p.goto(base + route, { waitUntil: 'domcontentloaded' })
      await p.waitForTimeout(1800)
      if (p.url().includes('/login')) {
        landed++
        await login(p, PASSWORD)
      }
    }
    p.off('response', h)
    await c.close()
    return { label, base, refresh, refresh401, landed }
  }
  const prod = await measure('http://localhost:8787', '生产构建(worker 直供 web/dist)')
  const dev = await measure('http://localhost:5173', 'Vite dev(5173)')
  console.log(`  [竞态对比] 生产=${JSON.stringify(prod)}`)
  console.log(`  [竞态对比] dev=${JSON.stringify(dev)}`)
  check(
    'C6.2',
    '竞态对比：生产构建导航全程无掉登录态，且 refresh 401 次数不高于 dev',
    prod.landed === 0 && prod.refresh401 <= dev.refresh401,
    `生产构建=${JSON.stringify(prod)}；Vite dev=${JSON.stringify(dev)}`
  )

  fs.writeFileSync('/tmp/zeta-qa/ps-results-c.json', JSON.stringify({ results }, null, 2))
  console.log('\n=== 阶段 C 汇总（生产构建）===')
  const fail = results.filter((r) => !r.pass)
  console.log(`共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`)
  console.log(`会话自愈（检测到 /login 自动重登）次数=${SESSION_DROPS}`)
  fail.forEach((f) => {
    console.log(`  FAIL ${f.id} ${f.name} :: ${f.detail}`)
  })
  await browser.close()
})().catch((e) => {
  console.error('脚本异常', e)
  process.exit(1)
})

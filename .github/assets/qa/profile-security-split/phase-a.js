/* Zeta #7「个人资料 / 安全设置」拆页 QA —— 阶段 A：路由与 Tab、Profile 内容与吸底栏、Security 内容、路由防御
 * 真浏览器（系统 Chrome 无头）+ 真后端（wrangler dev 本地 D1 + Vite dev）
 * 只读实测：不改产品代码。
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const REPO = process.env.ZETA_REPO || process.cwd()
const BASE = 'http://localhost:5173'
const WORKER_DIR = path.join(REPO, 'worker')
const OUT = path.join(REPO, '.github/assets/qa')
const SHOTS = '/tmp/zeta-qa/shots-ps'
const EMAIL = 'qa-split@example.com'
const PASSWORD = 'qa-pass-123456'

fs.mkdirSync(SHOTS, { recursive: true })
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

/* ── 本地 D1 只读取证（node:sqlite 只读打开，避免 wrangler CLI 与 dev server 抢同一个本地库） ── */
const { DatabaseSync } = require('node:sqlite')
const D1_DIR = path.join(WORKER_DIR, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
function d1File() {
  for (const f of fs.readdirSync(D1_DIR)) {
    if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue
    const p = path.join(D1_DIR, f)
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='zeta_users'").get()
      db.close()
      if (t) return p
    } catch {
      /* 跳过 */
    }
  }
  return null
}
function d1(sql) {
  const f = d1File()
  if (!f) return null
  try {
    const db = new DatabaseSync(f, { readOnly: true })
    const rows = db.prepare(sql).all()
    db.close()
    return rows
  } catch (e) {
    console.error(`[d1 SQL 错误] ${sql} :: ${e.message}`)
    return null
  }
}

/* ── 页面工具 ───────────────────────────────────────────────── */
const NAV = 'nav[aria-label="Account navigation"]'
async function newCtx(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('locale', 'zh')
    } catch {
      /* ignore */
    }
  })
  return ctx
}

/* 已知密码候选：阶段 B 会轮换密码，这里逐个探测，保证脚本可重复执行 */
const PW_CANDIDATES = [PASSWORD, 'qa-pass-654321', 'qa-pass-777777', 'qa-pass-888888', 'qa-pass-999999']
let CURRENT_PASSWORD = PASSWORD

async function loginOnce(page, pwd) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 20000 })
  await page.fill('#login-email', EMAIL)
  await page.fill('#login-password', pwd)
  await page.click('button[type=submit]')
  try {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 12000 })
    await page.waitForTimeout(800)
    return true
  } catch {
    return false
  }
}

async function login(page, pwd = CURRENT_PASSWORD) {
  if (pwd && (await loginOnce(page, pwd))) return
  for (const c of PW_CANDIDATES) {
    if (c === pwd) continue
    if (await loginOnce(page, c)) {
      CURRENT_PASSWORD = c
      console.log(`  [登录] 密码探测命中: ${c}`)
      return
    }
  }
  throw new Error('登录失败：候选密码均无效（账号可能已被二次验证保护）')
}

/* 夹具复位：清掉本轮 QA 账号的 TOTP 凭据（仅本地一次性 D1），保证纯密码可登录 */
function resetTotpFixture() {
  try {
    const f = d1File()
    if (!f) return 'no-db'
    const db = new DatabaseSync(f)
    db.exec('PRAGMA busy_timeout=5000')
    const u = db.prepare('SELECT id FROM zeta_users WHERE email = ?').get(EMAIL)
    if (!u) {
      db.close()
      return 'no-user'
    }
    db.prepare('DELETE FROM zeta_totp_credentials WHERE user_id = ?').run(u.id)
    db.close()
    return `reset(user=${u.id})`
  } catch (e) {
    return `error:${e.message}`
  }
}

async function register(page) {
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#register-name', { timeout: 20000 })
  await page.fill('#register-name', 'QA 拆页验收')
  await page.fill('#register-email', EMAIL)
  await page.fill('#register-password', PASSWORD)
  await page.click('button[type=submit]')
  await page.getByText('账号已创建').waitFor({ timeout: 20000 })
}

/* 开发模式下 React StrictMode 会并发发两次 /api/auth/refresh（同一 refresh cookie），
   其中一次因令牌轮换被拒 → 前端清会话跳回 /login。生产构建无此双调用。
   因此 QA 脚本每次导航后校验登录态，必要时重新登录（属测试环境处置，非产品缺陷）。*/
let RELOGIN_COUNT = 0
async function ensureAuthed(page) {
  await page.waitForTimeout(1300)
  if (page.url().includes('/login')) {
    RELOGIN_COUNT++
    await login(page)
    return true
  }
  return false
}
async function gotoAuthed(page, p, waitSel) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    if (page.url().includes('/login')) {
      await ensureAuthed(page) // 重新登录（开发模式 StrictMode 双 refresh 竞态导致掉登录态）
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
      if (page.url().includes('/login')) continue // 登录态又被竞态清掉 → 重试
      throw e
    }
  }
  if (waitSel) await page.waitForSelector(waitSel, { timeout: 15000 })
}

/* Tab 激活态：激活=下边框 2px 品牌色；未激活=0px */
async function tabState(page) {
  return page.evaluate((navSel) => {
    const nav = document.querySelector(navSel)
    const links = [...nav.querySelectorAll('a')]
    const pick = (name) => {
      const el = links.find((a) => a.textContent.trim() === name)
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        borderBottomWidth: cs.borderBottomWidth,
        borderBottomColor: cs.borderBottomColor,
        color: cs.color,
        cls: el.className,
      }
    }
    return { profile: pick('个人资料'), security: pick('安全设置') }
  }, NAV)
}

async function stickyBarState(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('section[aria-label="保存设置"]')
    if (!bar) return null
    const btn = bar.querySelector('button')
    const cs = getComputedStyle(bar)
    const r = bar.getBoundingClientRect()
    return {
      text: bar.textContent.replace(/\s+/g, ' ').trim(),
      btnText: btn?.textContent.trim(),
      btnDisabled: btn?.disabled,
      position: cs.position,
      bottom: cs.bottom,
      paddingBottom: cs.paddingBottom,
      classes: bar.className,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) },
      viewportH: window.innerHeight,
    }
  })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  console.log('browser:', browser.version())
  const ctx = await newCtx(browser)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

  /* ══ 阶段 0：账号准备 ═══════════════════════════════════════ */
  console.log('夹具复位:', resetTotpFixture())
  try {
    let regState = 'created'
    try {
      await register(page)
    } catch (e) {
      const t = await page.locator('body').textContent()
      if (!/already registered|Registration is disabled|已被注册|已注册|已存在/i.test(t)) throw e
      regState = /Registration is disabled/.test(t) ? 'closed' : 'existed'
    }
    check(
      '0.1',
      '注册流程：首个用户自助注册成功并成为管理员（之后注册按产品设计自动关闭）',
      regState === 'created' || regState === 'existed' || regState === 'closed',
      regState === 'created'
        ? `注册邮箱 ${EMAIL}`
        : `复用上一轮已注册的账号 ${EMAIL}（本轮 ${regState === 'closed' ? '注册接口返回 Registration is disabled（首个账号后自动关闭，产品既定行为）' : '邮箱已存在'}）`
    )
    await login(page)
    check(
      '0.2',
      '密码登录：注册后可用邮箱+密码登录并进入应用',
      page.url().includes('/query'),
      `登录后 URL=${page.url()}`
    )
    const users = d1('SELECT email, role, email_verified FROM zeta_users')
    check(
      '0.3',
      '落库证据：本地 D1 zeta_users 存在该账号且为首个管理员',
      Array.isArray(users) && users.length === 1 && users[0].role === 'admin',
      `zeta_users=${JSON.stringify(users)}`
    )
  } catch (e) {
    check('0.x', '阶段 0 账号准备', false, `异常：${e.message}`)
  }

  /* ══ 阶段 1：路由可达 + Tab 切换与激活态 ══════════════════════ */
  const jsRequests = []
  page.on('request', (r) => jsRequests.push(r.url()))
  try {
    await gotoAuthed(page, '/profile', 'text=账户')
    check(
      '1.1',
      '/profile 独立路由可达（直接输入 URL 进入个人资料页）',
      page.url().endsWith('/profile'),
      `URL=${page.url()}`
    )

    let ts = await tabState(page)
    const pActive = ts.profile?.borderBottomWidth === '2px'
    const sInactive = ts.security?.borderBottomWidth === '0px'
    check(
      '1.2',
      '/profile 激活态正确：个人资料 Tab 有 2px 品牌色下边框，安全设置 Tab 无下边框',
      pActive && sInactive,
      `个人资料=${JSON.stringify(ts.profile)}；安全设置=${JSON.stringify(ts.security)}`
    )

    const profileChunkBefore = jsRequests.filter((u) => /\/src\/pages\/Profile\.tsx/.test(u)).length
    const securityChunkBefore = jsRequests.filter((u) => /\/src\/pages\/Security\.tsx/.test(u)).length
    check(
      '1.3',
      '懒加载：进入 /profile 只加载 Profile 页面模块，未加载 Security 模块',
      profileChunkBefore > 0 && securityChunkBefore === 0,
      `Profile.tsx 请求 ${profileChunkBefore} 次，Security.tsx 请求 ${securityChunkBefore} 次`
    )

    await gotoAuthed(page, '/security', 'text=修改密码')
    check(
      '1.4',
      '/security 独立路由可达（直接输入 URL 进入安全设置页）',
      page.url().endsWith('/security'),
      `URL=${page.url()}`
    )
    ts = await tabState(page)
    check(
      '1.5',
      '/security 激活态正确：安全设置 Tab 有 2px 品牌色下边框，个人资料 Tab 无下边框',
      ts.security?.borderBottomWidth === '2px' && ts.profile?.borderBottomWidth === '0px',
      `个人资料=${JSON.stringify(ts.profile)}；安全设置=${JSON.stringify(ts.security)}`
    )
    const securityChunkAfter = jsRequests.filter((u) => /\/src\/pages\/Security\.tsx/.test(u)).length
    check(
      '1.6',
      '懒加载：进入 /security 才加载 Security 页面模块（按需加载）',
      securityChunkAfter > securityChunkBefore,
      `Security.tsx 请求数 ${securityChunkBefore} → ${securityChunkAfter}`
    )
    await shot(page, 'profile-security-tabs-security.png')

    /* Tab 点击切换 */
    await page.locator(`${NAV} a`, { hasText: '个人资料' }).click()
    await page.waitForURL(/\/profile$/, { timeout: 15000 })
    await page.getByRole('heading', { name: '账户' }).waitFor({ timeout: 15000 })
    ts = await tabState(page)
    check(
      '1.7',
      'Tab 点击切换：从 /security 点「个人资料」跳到 /profile 且激活态翻转',
      page.url().endsWith('/profile') &&
        ts.profile?.borderBottomWidth === '2px' &&
        ts.security?.borderBottomWidth === '0px',
      `URL=${page.url()}；${JSON.stringify(ts)}`
    )
    await shot(page, 'profile-security-tabs-profile.png')

    await page.locator(`${NAV} a`, { hasText: '安全设置' }).click()
    await page.waitForURL(/\/security$/, { timeout: 15000 })
    await page.getByRole('heading', { name: '修改密码' }).waitFor({ timeout: 15000 })
    ts = await tabState(page)
    check(
      '1.8',
      'Tab 点击切换：从 /profile 点「安全设置」跳到 /security 且激活态翻转',
      page.url().endsWith('/security') &&
        ts.security?.borderBottomWidth === '2px' &&
        ts.profile?.borderBottomWidth === '0px',
      `URL=${page.url()}；${JSON.stringify(ts)}`
    )
  } catch (e) {
    check('1.x', '阶段 1 路由与 Tab', false, `异常：${e.message}`)
  }

  /* ══ 阶段 2：Profile 内容 + run_limit 吸底栏四态 ══════════════ */
  try {
    await gotoAuthed(page, '/profile', '#profile-run-limit')
    await page.waitForTimeout(400)

    const bodyText = await page.locator('body').textContent()
    const has = (s) => bodyText.includes(s)
    check(
      '2.1',
      'Profile 仅含三块：账户（只读）/ 主题色 / 查询结果保留（运行设置）',
      has('账户') && has('主题色') && has('查询结果保留'),
      `命中：账户=${has('账户')} 主题色=${has('主题色')} 查询结果保留=${has('查询结果保留')}`
    )
    check(
      '2.2',
      'Profile 不含安全项（修改密码 / TOTP / 通行密钥）',
      !has('修改密码') && !has('验证器应用') && !has('通行密钥'),
      `修改密码=${has('修改密码')} 验证器应用=${has('验证器应用')} 通行密钥=${has('通行密钥')}`
    )
    const accountCard = page.locator('.card', { has: page.getByRole('heading', { name: '账户' }) }).first()
    const editableInAccount = await accountCard.locator('input,select,textarea,button').count()
    check(
      '2.3',
      '账户卡片为只读信息（无输入框/按钮）',
      editableInAccount === 0,
      `账户卡片内可交互元素数=${editableInAccount}`
    )
    const themeInputs = await page.locator('input[name="theme-color"]').count()
    check('2.4', '主题色选择器存在（12 个预设色板）', themeInputs === 12, `色板数=${themeInputs}`)

    /* 吸底栏存在性 */
    let bar = await stickyBarState(page)
    check(
      '2.5',
      'run_limit 吸底栏存在且为 sticky 吸底（position:sticky; bottom:0）',
      !!bar && bar.position === 'sticky' && bar.classes.includes('bottom-0'),
      `bar=${JSON.stringify(bar)}`
    )
    const saveBtns = await page.getByRole('button', { name: '保存更改' }).count()
    const otherSave = await page.evaluate(() => {
      const barEl = document.querySelector('section[aria-label="保存设置"]')
      const all = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('保存'))
      return { total: all.length, inBar: all.filter((b) => barEl?.contains(b)).length }
    })
    check(
      '2.6',
      '页面内「保存」类按钮只有吸底栏这 1 个（无重复保存入口）',
      saveBtns === 1 && otherSave.total === 1 && otherSave.inBar === 1,
      `「保存更改」按钮数=${saveBtns}；全页含「保存」按钮=${otherSave.total}，其中在吸底栏内=${otherSave.inBar}`
    )

    /* 吸底栏四态 */
    bar = await stickyBarState(page)
    check(
      '2.7',
      '吸底栏态①初始 clean：文案「已保存」+ 保存按钮禁用',
      bar?.text.includes('已保存') && !bar.text.includes('已保存！') && bar.btnDisabled === true,
      `bar=${JSON.stringify(bar)}`
    )

    const input = page.locator('#profile-run-limit')
    await input.fill('25')
    await page.waitForTimeout(200)
    bar = await stickyBarState(page)
    check(
      '2.8',
      '吸底栏态②dirty：文案「有未保存更改」+ 保存按钮可用',
      bar?.text.includes('有未保存更改') && bar.btnDisabled === false,
      `bar=${JSON.stringify(bar)}`
    )
    await shot(page, 'profile-sticky-bar-dirty.png')

    /* 保存中：用路由拦截延迟 PUT，制造可见的 saving 态 */
    const putCalls = []
    await page.route('**/api/profile/run-settings', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      putCalls.push(route.request().postData())
      await new Promise((r) => setTimeout(r, 1500))
      return route.continue()
    })
    await page.getByRole('button', { name: '保存更改' }).click()
    await page.waitForTimeout(500)
    bar = await stickyBarState(page)
    check(
      '2.9',
      '吸底栏态③saving：文案「保存中…」+ 按钮禁用',
      bar?.text.includes('保存中') && bar.btnDisabled === true,
      `bar=${JSON.stringify(bar)}`
    )
    await shot(page, 'profile-sticky-bar-saving.png')
    await page.waitForTimeout(1800)
    bar = await stickyBarState(page)
    check(
      '2.10',
      '吸底栏态④saved：保存成功后文案「已保存！」+ 按钮回到禁用',
      bar?.text.includes('已保存！') && bar.btnDisabled === true,
      `bar=${JSON.stringify(bar)}`
    )
    check(
      '2.11',
      '保存请求体正确（PUT /api/profile/run-settings {"run_limit":25}）',
      putCalls.length === 1 && /"run_limit":25/.test(putCalls[0] || ''),
      `PUT 次数=${putCalls.length}，body=${JSON.stringify(putCalls)}`
    )
    await page.unroute('**/api/profile/run-settings')

    /* 落库证据 */
    const rows = d1(`SELECT notebook_run_limit AS run_limit FROM zeta_users WHERE email = '${EMAIL}'`)
    check(
      '2.12',
      '落库证据：run_limit=25 已写入本地 D1',
      Array.isArray(rows) && rows.length === 1 && rows[0].run_limit === 25,
      `zeta_users.run_limit=${JSON.stringify(rows)}`
    )

    /* 非法输入拦截 */
    const illegal = [
      { v: '0', why: '小于下限 1' },
      { v: '-1', why: '负数' },
      { v: '1.5', why: '非整数' },
      { v: '101', why: '超过管理员上限 100' },
    ]
    for (const it of illegal) {
      let putCount = 0
      const h = async (route) => {
        if (route.request().method() === 'PUT') putCount++
        return route.continue()
      }
      await page.route('**/api/profile/run-settings', h)
      await input.fill(it.v)
      await page.getByRole('button', { name: '保存更改' }).click()
      await page.waitForTimeout(500)
      const errText = await page.locator('body').textContent()
      const errShown = errText.includes('请输入 1 到 100 之间的整数，或留空')
      const alertShown = await page.locator('[role=alert]').count()
      await page.unroute('**/api/profile/run-settings', h)
      check(
        `2.13[${it.v}]`,
        `非法输入「${it.v}」（${it.why}）被拦截：提示错误且不发保存请求`,
        errShown && putCount === 0,
        `错误提示可见=${errShown}（role=alert 元素 ${alertShown} 个），PUT 次数=${putCount}`
      )
      await shot(page, `profile-invalid-run-limit-${it.v.replace('-', 'neg')}.png`)
    }

    /* 合法输入 + 空值 */
    await input.fill('30')
    await page.getByRole('button', { name: '保存更改' }).click()
    await page.waitForTimeout(900)
    const rows30 = d1(`SELECT notebook_run_limit AS run_limit FROM zeta_users WHERE email = '${EMAIL}'`)
    check(
      '2.14',
      '合法输入 30 可保存并落库',
      Array.isArray(rows30) && rows30[0].run_limit === 30,
      `run_limit=${JSON.stringify(rows30)}`
    )

    await input.fill('')
    await page.getByRole('button', { name: '保存更改' }).click()
    await page.waitForTimeout(900)
    const rowsNull = d1(`SELECT notebook_run_limit AS run_limit FROM zeta_users WHERE email = '${EMAIL}'`)
    const effText = await page.locator('body').textContent()
    check(
      '2.15',
      '留空可保存（按产品定义=跟随管理员上限，落库 NULL），页面显示当前生效值=管理员上限 100',
      Array.isArray(rowsNull) && rowsNull[0].run_limit === null && effText.includes('当前生效：100 次'),
      `run_limit=${JSON.stringify(rowsNull)}；生效文案命中=${effText.includes('当前生效：100 次')}`
    )

    /* 主题色即时生效 */
    const themePuts = []
    await page.route('**/api/profile/theme-color', async (route) => {
      if (route.request().method() === 'PUT') themePuts.push(route.request().postData())
      return route.continue()
    })
    const effNow = (a) => (a === null ? 'terracotta' : a)
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme-color'))
    const values = await page.evaluate(() =>
      [...document.querySelectorAll('input[name="theme-color"]')].map((i) => i.value)
    )
    const targetIdx = values.findIndex((v) => v !== effNow(before))
    await page.locator('input[name="theme-color"]').nth(targetIdx).check({ force: true })
    await page.waitForTimeout(120)
    // 默认色 terracotta 的语义是「移除 data-theme-color 属性」（见 web/src/lib/theme-color.ts applyThemeColor）
    const eff = (a) => (a === null ? 'terracotta' : a)
    const immediately = eff(await page.evaluate(() => document.documentElement.getAttribute('data-theme-color')))
    await page.waitForTimeout(900)
    const after = eff(await page.evaluate(() => document.documentElement.getAttribute('data-theme-color')))
    const dbColor = d1(`SELECT theme_color FROM zeta_users WHERE email = '${EMAIL}'`)
    const savedBtnDisabled = (await stickyBarState(page))?.btnDisabled
    check(
      '2.16',
      '主题色即时生效（无需点保存：点色板后立刻上色并落库，且不产生「未保存更改」脏状态）',
      immediately === values[targetIdx] &&
        after === values[targetIdx] &&
        themePuts.length === 1 &&
        dbColor &&
        dbColor[0].theme_color === values[targetIdx] &&
        savedBtnDisabled === true,
      `生效主题 ${eff(before)} → 点击后立即 ${immediately} → ${after}（目标色板 ${values[targetIdx]}）；PUT 次数=${themePuts.length} body=${JSON.stringify(themePuts)}；D1 theme_color=${JSON.stringify(dbColor)}；吸底栏按钮仍禁用=${savedBtnDisabled}`
    )
    await page.unroute('**/api/profile/theme-color')

    /* 离开 Profile 后 dirty 复位（评审后修复项） */
    await input.fill('42')
    await page.waitForTimeout(200)
    const dialogs = []
    const onDialog = async (d) => {
      dialogs.push(d.message())
      await d.accept().catch(() => {})
    }
    page.on('dialog', onDialog)
    await page.locator(`${NAV} a`, { hasText: '安全设置' }).click()
    await page.waitForURL(/\/security$/, { timeout: 15000 })
    const dialogsAfterTab = dialogs.length
    await page.getByRole('link', { name: '返回查询' }).click()
    await page.waitForTimeout(1200)
    const dialogMsg = dialogs[0] ?? null
    const dialog2 = dialogs.length > dialogsAfterTab ? dialogs[dialogsAfterTab] : null
    page.off('dialog', onDialog)
    check(
      '2.17',
      'stale-dirty 复位：在 /security 点「返回查询」不再弹未保存确认（离开 Profile 已清 dirty）',
      dialogMsg !== null && dialog2 === null,
      `切 Tab 时确认框文案=${JSON.stringify(dialogMsg)}；离开 Profile 后再次确认框=${JSON.stringify(dialog2)}`
    )
    await gotoAuthed(page, '/profile', '#profile-run-limit')
    await page.waitForTimeout(500)
    bar = await stickyBarState(page)
    const valNow = await page.locator('#profile-run-limit').inputValue()
    check(
      '2.18',
      '重新进入 /profile：吸底栏回到 clean 态「已保存」+ 按钮禁用（无残留 dirty）',
      bar?.text.includes('已保存') && !bar.text.includes('已保存！') && bar.btnDisabled === true && valNow === '',
      `bar=${JSON.stringify(bar)}；输入框值=${JSON.stringify(valNow)}`
    )
  } catch (e) {
    check('2.x', '阶段 2 Profile 内容与吸底栏', false, `异常：${e.message}`)
  }

  /* ══ 阶段 3：Security 内容 ═══════════════════════════════════ */
  try {
    await gotoAuthed(page, '/security', 'text=修改密码')
    await page.waitForTimeout(500)
    const txt = await page.locator('body').textContent()
    check(
      '3.1',
      'Security 含三块：修改密码 / 验证器应用(TOTP) / 通行密钥(Passkey)',
      txt.includes('修改密码') && txt.includes('验证器应用') && txt.includes('通行密钥'),
      `修改密码=${txt.includes('修改密码')} 验证器应用=${txt.includes('验证器应用')} 通行密钥=${txt.includes('通行密钥')}`
    )
    const bars = await page.locator('section[aria-label="保存设置"]').count()
    const saveBtns = await page.getByRole('button', { name: '保存更改' }).count()
    check(
      '3.2',
      'Security 无统一保存栏（无吸底栏 / 无「保存更改」按钮）',
      bars === 0 && saveBtns === 0,
      `吸底栏数=${bars}，「保存更改」按钮数=${saveBtns}`
    )
    const profileOnly = txt.includes('主题色') || txt.includes('查询结果保留')
    const runInput = await page.locator('#profile-run-limit').count()
    check(
      '3.3',
      'Security 不含 Profile 专属内容（主题色 / 查询结果保留 / run_limit 输入）',
      !profileOnly && runInput === 0,
      `主题色=${txt.includes('主题色')} 查询结果保留=${txt.includes('查询结果保留')} run_limit 输入框=${runInput}`
    )
    const ownActions = await page.evaluate(() => {
      const txts = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
      return txts
    })
    check(
      '3.4',
      'Security 各项自带动作按钮（更新密码 / 添加验证器应用 / 添加通行密钥）',
      ownActions.includes('更新密码') && ownActions.includes('添加验证器应用') && ownActions.includes('添加通行密钥'),
      `页面按钮文案=${JSON.stringify(ownActions)}`
    )
    const pwFields = await page.evaluate(() => ({
      current: !!document.querySelector('#security-current-password'),
      next: !!document.querySelector('#security-new-password'),
      confirm: !!document.querySelector('#security-confirm-password'),
    }))
    check(
      '3.5',
      '改密码表单三字段齐全（当前/新/确认密码）',
      pwFields.current && pwFields.next && pwFields.confirm,
      JSON.stringify(pwFields)
    )
    await shot(page, 'security-page-desktop.png')
  } catch (e) {
    check('3.x', '阶段 3 Security 内容', false, `异常：${e.message}`)
  }

  /* ══ 阶段 4：路由防御 ═══════════════════════════════════════ */
  try {
    await gotoAuthed(page, '/profile/security', 'text=修改密码')
    check(
      '4.1',
      '/profile/security → /security 防御跳转（不 404、不死链）',
      page.url().endsWith('/security'),
      `跳转后 URL=${page.url()}`
    )

    const aliasResults = []
    for (const p of ['/account', '/account/profile', '/account/security']) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
      await ensureAuthed(page)
      const t = await page.locator('body').textContent()
      const isProfile = t.includes('查询结果保留') && t.includes('主题色')
      const isSecurity = t.includes('修改密码') && t.includes('验证器应用')
      aliasResults.push({ p, url: page.url(), isProfile, isSecurity })
    }
    check(
      '4.2',
      '/account* 别名已不存在（三条旧路径都不再渲染个人资料/安全设置页）',
      aliasResults.every((r) => !r.isProfile && !r.isSecurity),
      `逐条结果=${JSON.stringify(aliasResults)}`
    )
    let srcHits = ''
    try {
      srcHits = execFileSync(
        'grep',
        ['-rn', '/account', path.join(REPO, 'web/src'), '--include=*.tsx', '--include=*.ts'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim()
    } catch (e) {
      srcHits = (e.stdout || '').toString().trim()
    }
    check(
      '4.3',
      '源码核对：web/src 内无 /account 路由或链接残留',
      srcHits === '',
      `grep -rn /account web/src 命中=${srcHits === '' ? '无' : srcHits}`
    )
  } catch (e) {
    check('4.x', '阶段 4 路由防御', false, `异常：${e.message}`)
  }

  fs.writeFileSync('/tmp/zeta-qa/ps-results-a.json', JSON.stringify({ results }, null, 2))
  console.log('\n=== 阶段 A 汇总 ===')
  const fail = results.filter((r) => !r.pass)
  console.log(`共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`)
  console.log(`开发模式会话自愈次数（StrictMode 双 refresh 竞态）= ${RELOGIN_COUNT}`)
  fail.forEach((f) => {
    console.log(`  FAIL ${f.id} ${f.name} :: ${f.detail}`)
  })
  await browser.close()
})().catch((e) => {
  console.error('脚本异常', e)
  process.exit(1)
})

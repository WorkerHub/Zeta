/* Zeta #7 拆页 QA —— 阶段 B：用户菜单入口、改密码、TOTP、Passkey、移除二次验证弹窗、登录回归、移动端 safe-area
 * 真浏览器（系统 Chrome 无头）+ 真后端（wrangler dev 本地 D1 + Vite dev）
 * 脚本可重复执行：启动时先重置本地测试夹具（二次验证凭据），再跑完整流程。
 */
const { chromium } = require('playwright')
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const REPO = process.env.ZETA_REPO || process.cwd()
const BASE = 'http://localhost:5173'
const WORKER_DIR = path.join(REPO, 'worker')
const OUT = path.join(REPO, '.github/assets/qa')
const EMAIL = 'qa-split@example.com'
const CANDIDATE_PW = ['qa-pass-123456', 'qa-pass-654321', 'qa-pass-777777', 'qa-pass-888888', 'qa-pass-999999']
let NEW_PASSWORD = 'qa-pass-888888'

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

/* ── 本地 D1（只读取证；夹具重置时写） ─────────────────────────── */
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
    } catch {}
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
/* 夹具重置：清掉本轮 QA 账号的二次验证凭据（仅本地一次性 QA 库） */
function resetFixture() {
  const f = d1File()
  if (!f) return 'no-db'
  try {
    const db = new DatabaseSync(f)
    db.exec('PRAGMA busy_timeout=5000')
    const u = db.prepare('SELECT id FROM zeta_users WHERE email = ?').get(EMAIL)
    if (!u) return 'no-user'
    db.prepare('DELETE FROM zeta_totp_credentials WHERE user_id = ?').run(u.id)
    db.prepare('DELETE FROM zeta_passkey_credentials WHERE user_id = ?').run(u.id)
    db.close()
    return `reset(user=${u.id})`
  } catch (e) {
    return `error:${e.message}`
  }
}

/* ── TOTP ─────────────────────────────────────────────────────── */
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
function totpCode(secret, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  const num = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff)
  return String(num % 1000000).padStart(6, '0')
}

/* ── 页面工具 ─────────────────────────────────────────────────── */
async function login(page, pwd, opts = {}) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#login-email', { timeout: 20000 })
  await page.fill('#login-email', EMAIL)
  await page.fill('#login-password', pwd)
  await page.click('button[type=submit]')
  const twofa = page.locator('#twofa-totp-code')
  const appeared = await twofa
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    if (!opts.totpSecret) throw new Error('账号已启用 TOTP，但脚本没有密钥')
    for (let i = 0; i < 3; i++) {
      await twofa.fill(totpCode(opts.totpSecret))
      const verifyBtn = page.getByRole('button', { name: /^(验证|Verify)$/ }).last()
      await verifyBtn.click()
      await page.waitForTimeout(2200)
      if (!page.url().includes('/login')) break
      const err = await page
        .locator('.text-danger-600')
        .first()
        .textContent()
        .catch(() => '')
      console.log(`  [2FA] 第 ${i + 1} 次校验失败：${err}`)
      if (/already used/i.test(err)) {
        // 同一 30 秒窗口的验证码不可重放（后端 90s 防重放），等下一个窗口再试
        const wait = 30 - (Math.floor(Date.now() / 1000) % 30) + 1
        console.log(`  [2FA] 等待 ${wait}s 进入下一个 30 秒窗口`)
        await page.waitForTimeout(wait * 1000)
      }
    }
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  await page.waitForTimeout(900)
  if (page.url().includes('/login')) throw new Error('登录失败：仍停留在 /login')
}

let RELOGIN_COUNT = 0
async function ensureAuthed(page, pwd, secret) {
  await page.waitForTimeout(1300)
  if (page.url().includes('/login')) {
    RELOGIN_COUNT++
    await login(page, pwd, { totpSecret: secret })
    return true
  }
  return false
}
async function gotoAuthed(page, p, waitSel, pwd, secret) {
  let lastUrl = ''
  // 开发模式下 React.StrictMode 会并发发两次 refresh（令牌轮换），偶发把会话清掉 → 跳回 /login。
  // 这里允许更多次「重新登录后再导航」，直到目标元素出现为止。
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1800)
    lastUrl = page.url()
    if (page.url().includes('/login')) {
      await ensureAuthed(page, pwd, secret)
      if (page.url().includes('/query')) {
        await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(1800)
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

/* 读取 TOTP 手动密钥（必要时点眼睛按钮展开） */
async function revealSecret(page) {
  const codeEl = page.locator('code').first()
  for (let i = 0; i < 4; i++) {
    const v = (await codeEl.textContent()).trim()
    if (/^[A-Z2-7]{16,}$/.test(v)) return v
    await codeEl.locator('xpath=..').locator('button').first().click()
    await page.waitForTimeout(350)
  }
  return (await codeEl.textContent()).trim()
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  console.log('browser:', browser.version())
  console.log('夹具重置:', resetFixture())

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('locale', 'zh')
    } catch {}
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 160)))

  /* 探测当前密码 */
  let CURRENT_PASSWORD = null
  for (const pwd of CANDIDATE_PW) {
    try {
      await login(page, pwd)
      CURRENT_PASSWORD = pwd
      break
    } catch {
      /* 试下一个 */
    }
  }
  if (!CURRENT_PASSWORD) {
    console.error('无法用已知密码登录，终止')
    process.exit(1)
  }
  console.log('当前密码探测成功:', CURRENT_PASSWORD)
  if (CURRENT_PASSWORD === NEW_PASSWORD) NEW_PASSWORD = 'qa-pass-999999'

  /* ══ B1 用户菜单入口 ════════════════════════════════════════ */
  try {
    await gotoAuthed(page, '/query', 'button.rounded-full', CURRENT_PASSWORD)
    const avatar = page.locator('button.rounded-full').first()
    await avatar.click()
    await page.waitForTimeout(400)
    const menu = page.locator('div.absolute.right-0').first()
    const menuText = await menu.textContent()
    check(
      'B1.1',
      '用户菜单保留「个人资料」「安全设置」入口',
      menuText.includes('个人资料') && menuText.includes('安全设置'),
      `菜单文案=${JSON.stringify(menuText.replace(/\n/g, ' | '))}`
    )
    await shot(page, 'user-menu-entries.png')
    await menu.getByText('个人资料', { exact: true }).click()
    await page.waitForURL(/\/profile$/, { timeout: 15000 })
    check('B1.2', '用户菜单「个人资料」→ 跳到 /profile', page.url().endsWith('/profile'), `URL=${page.url()}`)

    await gotoAuthed(page, '/query', 'button.rounded-full', CURRENT_PASSWORD)
    await page.locator('button.rounded-full').first().click()
    await page.waitForTimeout(400)
    await page.locator('div.absolute.right-0').first().getByText('安全设置', { exact: true }).click()
    await page.waitForURL(/\/security$/, { timeout: 15000 })
    check('B1.3', '用户菜单「安全设置」→ 跳到 /security', page.url().endsWith('/security'), `URL=${page.url()}`)
  } catch (e) {
    check('B1.x', 'B1 用户菜单入口', false, `异常：${e.message}`)
  }

  /* ══ B2 改密码 + 登录回归 ════════════════════════════════════ */
  try {
    await gotoAuthed(page, '/security', '#security-current-password', CURRENT_PASSWORD)
    await page.fill('#security-current-password', CURRENT_PASSWORD)
    await page.fill('#security-new-password', NEW_PASSWORD)
    await page.fill('#security-confirm-password', NEW_PASSWORD)
    await page.getByRole('button', { name: '更新密码' }).click()
    await page.getByText('密码已修改').waitFor({ timeout: 20000 })
    check('B2.1', '改密码：当前+新+确认三段填写后提交，页面提示「密码已修改」', true, 'Security 页提示 密码已修改')

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#login-email')
    await page.fill('#login-email', EMAIL)
    await page.fill('#login-password', CURRENT_PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForTimeout(2500)
    const oldErr = await page.locator('body').textContent()
    check(
      'B2.2',
      '改密码后旧密码登录被拒（仍停在登录页并给出错误提示）',
      page.url().includes('/login') && /Invalid email or password|密码/.test(oldErr),
      `URL=${page.url()}；错误文案=${JSON.stringify(oldErr.match(/[^\n]*(Invalid|密码)[^\n]*/g)?.slice(0, 2))}`
    )
    await shot(page, 'login-old-password-rejected.png')

    await login(page, NEW_PASSWORD)
    check('B2.3', '改密码后新密码可正常登录', !page.url().includes('/login'), `登录后 URL=${page.url()}`)
    CURRENT_PASSWORD = NEW_PASSWORD
  } catch (e) {
    check('B2.x', 'B2 改密码', false, `异常：${e.message}`)
  }

  /* ══ B3 TOTP 添加 ════════════════════════════════════════════ */
  let totpSecret = null
  try {
    await gotoAuthed(page, '/security', 'text=添加验证器应用', CURRENT_PASSWORD)
    await page.getByRole('button', { name: '添加验证器应用' }).click()
    await page.waitForSelector('#security-totp-code', { timeout: 20000 })
    const qr = await page.locator('img[alt]').first().getAttribute('src')
    totpSecret = await revealSecret(page)
    check(
      'B3.1',
      'TOTP 添加流程：点「添加验证器应用」出现二维码 + 手动密钥输入框',
      /^[A-Z2-7]{16,}$/.test(totpSecret) && !!qr && qr.startsWith('data:image'),
      `密钥长度=${totpSecret.length}，密钥=${totpSecret.slice(0, 6)}…，二维码=${qr ? `${qr.slice(0, 30)}…` : '无'}`
    )
    await shot(page, 'security-totp-setup.png')
    await page.fill('#security-totp-code', totpCode(totpSecret))
    await page.getByRole('button', { name: '确认并保存' }).click()
    await page.waitForTimeout(2500)
    const afterAdd = await page.locator('body').textContent()
    const totpRows = d1('SELECT name, user_id FROM zeta_totp_credentials')
    check(
      'B3.2',
      'TOTP 启用成功：凭据出现在列表 + 落库 zeta_totp_credentials',
      afterAdd.includes('添加于') && Array.isArray(totpRows) && totpRows.length === 1,
      `页面出现凭据条目=${afterAdd.includes('添加于')}；D1 zeta_totp_credentials=${JSON.stringify(totpRows)}`
    )
    await shot(page, 'security-totp-enabled.png')
  } catch (e) {
    check('B3.x', 'B3 TOTP 添加', false, `异常：${e.message}`)
  }

  /* ══ B4 移除二次验证弹窗（TOTP） ═══════════════════════════════ */
  try {
    await page.locator('li', { hasText: '添加于' }).first().locator('button').first().click()
    await page.waitForSelector('#removal-password', { timeout: 15000 })
    const modalText = await page.locator('form', { has: page.locator('#removal-password') }).textContent()
    check(
      'B4.1',
      '移除二次验证弹窗：标题 + 当前密码输入 + 取消/移除按钮齐全',
      modalText.includes('确定要移除此验证器吗？') &&
        modalText.includes('当前密码') &&
        modalText.includes('取消') &&
        modalText.includes('移除'),
      `弹窗文案=${JSON.stringify(modalText.replace(/\n/g, ' | '))}`
    )
    await shot(page, 'security-remove-totp-modal.png')
    await page.getByRole('button', { name: '取消' }).click()
    await page.waitForTimeout(600)
    const stillThere = await page.locator('#removal-password').count()
    const rowStill = await page.locator('li', { hasText: '添加于' }).count()
    check(
      'B4.2',
      '弹窗「取消」：弹窗关闭且凭据未被删除',
      stillThere === 0 && rowStill === 1,
      `弹窗残留=${stillThere}，凭据行数=${rowStill}`
    )

    await page.locator('li', { hasText: '添加于' }).first().locator('button').first().click()
    await page.waitForSelector('#removal-password', { timeout: 15000 })
    await page.fill('#removal-password', CURRENT_PASSWORD)
    await page.getByRole('button', { name: '移除' }).click()
    await page.waitForTimeout(2500)
    const rowAfter = await page.locator('li', { hasText: '添加于' }).count()
    const totpRows = d1('SELECT COUNT(*) AS n FROM zeta_totp_credentials')
    check(
      'B4.3',
      '弹窗「移除」+ 密码确认：凭据被删除并落库清零',
      rowAfter === 0 && totpRows && totpRows[0].n === 0,
      `页面剩余凭据行=${rowAfter}；D1 zeta_totp_credentials 计数=${totpRows?.[0].n}`
    )
  } catch (e) {
    check('B4.x', 'B4 移除弹窗（TOTP）', false, `异常：${e.message}`)
  }

  /* ══ B5 Passkey 添加（CDP 虚拟认证器） ═════════════════════════ */
  try {
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const va = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    console.log('  [虚拟认证器]', JSON.stringify(va.authenticatorId))
    await gotoAuthed(page, '/security', 'text=添加通行密钥', CURRENT_PASSWORD)
    await page.getByRole('button', { name: '添加通行密钥' }).click()
    await page.waitForTimeout(4500)
    const pkRows = d1('SELECT name, credential_id FROM zeta_passkey_credentials')
    check(
      'B5.1',
      'Passkey 添加：真实 WebAuthn 流程（Chrome 虚拟认证器）注册成功并落库',
      Array.isArray(pkRows) && pkRows.length === 1,
      `D1 zeta_passkey_credentials=${JSON.stringify(pkRows)}`
    )
    await shot(page, 'security-passkey-added.png')
  } catch (e) {
    check('B5.x', 'B5 Passkey 添加', false, `异常：${e.message}`)
  }

  /* ══ B6 Passkey 移除弹窗 ══════════════════════════════════════ */
  try {
    const target =
      (await page.locator('li', { hasText: '通行密钥' }).count()) > 0
        ? page.locator('li', { hasText: '通行密钥' }).first()
        : page.locator('li').last()
    await target.locator('button').first().click()
    await page.waitForSelector('#removal-password', { timeout: 15000 })
    const modalText = await page.locator('form', { has: page.locator('#removal-password') }).textContent()
    check(
      'B6.1',
      '移除通行密钥弹窗：标题为「确定要移除此通行密钥吗？」+ 当前密码 + 移除按钮',
      modalText.includes('确定要移除此通行密钥吗？') && modalText.includes('当前密码') && modalText.includes('移除'),
      `弹窗文案=${JSON.stringify(modalText.replace(/\n/g, ' | '))}`
    )
    await shot(page, 'security-remove-passkey-modal.png')
    await page.fill('#removal-password', CURRENT_PASSWORD)
    await page.getByRole('button', { name: '移除' }).click()
    await page.waitForTimeout(2500)
    const pkRows = d1('SELECT COUNT(*) AS n FROM zeta_passkey_credentials')
    check(
      'B6.2',
      '移除通行密钥：凭据删除并落库清零',
      pkRows && pkRows[0].n === 0,
      `D1 zeta_passkey_credentials 计数=${pkRows?.[0].n}`
    )
  } catch (e) {
    check('B6.x', 'B6 Passkey 移除弹窗', false, `异常：${e.message}`)
  }

  /* ══ B7 TOTP 二次登录回归 ═════════════════════════════════════ */
  try {
    await gotoAuthed(page, '/security', 'text=添加验证器应用', CURRENT_PASSWORD)
    await page.getByRole('button', { name: '添加验证器应用' }).click()
    await page.waitForSelector('#security-totp-code', { timeout: 20000 })
    totpSecret = await revealSecret(page)
    await page.fill('#security-totp-code', totpCode(totpSecret))
    await page.getByRole('button', { name: '确认并保存' }).click()
    await page.waitForTimeout(2500)
    const enabled = (await page.locator('body').textContent()).includes('添加于')
    check(
      'B7.1',
      '重新启用 TOTP（为登录回归做准备）',
      enabled,
      `凭据区可见=${enabled}，密钥长度=${(totpSecret || '').length}`
    )

    await gotoAuthed(page, '/query', 'button.rounded-full', CURRENT_PASSWORD, totpSecret)
    await page.locator('button.rounded-full').first().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /退出登录/ }).click()
    await page.waitForTimeout(1800)
    check(
      'B7.2',
      '登出：用户菜单「退出登录」可用，落到登录页',
      page.url().includes('/login'),
      `登出后 URL=${page.url()}`
    )

    await login(page, CURRENT_PASSWORD, { totpSecret })
    check(
      'B7.3',
      '登录回归：密码 + TOTP 验证码两步登录成功（2FA 弹窗出现并可验证）',
      !page.url().includes('/login'),
      `登录后 URL=${page.url()}`
    )
  } catch (e) {
    check('B7.x', 'B7 2FA 登录回归', false, `异常：${e.message}`)
  }

  await ctx.close()

  /* ══ B8 移动端 safe-area 吸底栏 ═══════════════════════════════ */
  let mp = null
  try {
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    })
    await mctx.addInitScript(() => {
      try {
        localStorage.setItem('locale', 'zh')
      } catch {}
    })
    mp = await mctx.newPage()
    const cdp = await mctx.newCDPSession(mp)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    })
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 34 } })

    await login(mp, CURRENT_PASSWORD, { totpSecret })
    await gotoAuthed(mp, '/profile', '#profile-run-limit', CURRENT_PASSWORD, totpSecret)

    const pad = await mp.evaluate(() => {
      const bar = document.querySelector('section[aria-label="保存设置"]')
      return bar ? getComputedStyle(bar).paddingBottom : null
    })
    check(
      'B8.1',
      '移动端：注入 safe-area inset 34px 后吸底栏 padding-bottom = 34px（env 生效）',
      pad === '34px',
      `吸底栏 computed padding-bottom=${pad}（CDP Emulation.setSafeAreaInsetsOverride bottom=34）`
    )

    await mp.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await mp.waitForTimeout(800)
    const m = await mp.evaluate(() => {
      const bar = document.querySelector('section[aria-label="保存设置"]')
      const btn = bar.querySelector('button')
      const input = document.querySelector('#profile-run-limit')
      const br = bar.getBoundingClientRect()
      const rr = btn.getBoundingClientRect()
      const ir = input.getBoundingClientRect()
      return {
        barTop: Math.round(br.top),
        barBottom: Math.round(br.bottom),
        barHeight: Math.round(br.height),
        barWidth: Math.round(br.width),
        padBottom: getComputedStyle(bar).paddingBottom,
        btnRect: { top: Math.round(rr.top), bottom: Math.round(rr.bottom), w: Math.round(rr.width) },
        inputRect: { top: Math.round(ir.top), bottom: Math.round(ir.bottom) },
        innerH: window.innerHeight,
        innerW: window.innerWidth,
        scrollY: Math.round(window.scrollY),
        docH: document.documentElement.scrollHeight,
      }
    })
    check(
      'B8.2',
      '移动端滚到底：吸底栏贴视口底部（含 34px 安全区），宽度与视口一致',
      m.barBottom === m.innerH && m.barWidth === m.innerW && m.padBottom === '34px',
      `bar=${JSON.stringify(m)}`
    )
    check(
      'B8.3',
      '移动端滚到底：末项（run_limit 输入框 + 保存按钮）完整可见且在安全区之上可点',
      m.btnRect.bottom <= m.innerH - 34 + 1 && m.btnRect.top >= 0 && m.inputRect.bottom <= m.innerH,
      `保存按钮=${JSON.stringify(m.btnRect)}；输入框=${JSON.stringify(m.inputRect)}；视口高=${m.innerH}`
    )
    await shot(mp, 'profile-mobile-safe-area-bottom.png')

    let putBody = null
    await mp.route('**/api/profile/run-settings', async (route) => {
      if (route.request().method() === 'PUT') putBody = route.request().postData()
      return route.continue()
    })
    /* 目标值必须与当前输入框里的值不同，否则前端不会进入「有未保存更改」态 */
    const curVal = (await mp.inputValue('#profile-run-limit')).trim()
    const target = curVal === '60' ? '61' : '60'
    await mp.fill('#profile-run-limit', target)
    await mp.waitForTimeout(400)
    const dirtyState = await mp.evaluate(() => {
      const bar = document.querySelector('section[aria-label="保存设置"]')
      return { text: bar.textContent.replace(/\s+/g, ' ').trim(), disabled: bar.querySelector('button').disabled }
    })
    await mp.getByRole('button', { name: '保存更改' }).click()
    await mp.waitForTimeout(1800)
    const savedState = await mp.evaluate(() => {
      const bar = document.querySelector('section[aria-label="保存设置"]')
      return { text: bar.textContent.replace(/\s+/g, ' ').trim(), disabled: bar.querySelector('button').disabled }
    })
    const db60 = d1(`SELECT notebook_run_limit AS run_limit FROM zeta_users WHERE email = '${EMAIL}'`)
    check(
      'B8.4',
      `移动端吸底栏可用：dirty（可保存）→ 保存 → 已保存，且落库 run_limit=${target}`,
      dirtyState.text.includes('有未保存更改') &&
        dirtyState.disabled === false &&
        savedState.text.includes('已保存') &&
        savedState.disabled === true &&
        db60 &&
        db60[0].run_limit === Number(target),
      `目标值=${target}（原值=${curVal || '空'}）；dirty=${JSON.stringify(dirtyState)}；saved=${JSON.stringify(savedState)}；PUT body=${putBody}；D1=${JSON.stringify(db60)}`
    )
    await shot(mp, 'profile-mobile-safe-area-saved.png')

    /* 桌面端形状对照 */
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await dctx.addInitScript(() => {
      try {
        localStorage.setItem('locale', 'zh')
      } catch {}
    })
    const dp = await dctx.newPage()
    await login(dp, CURRENT_PASSWORD, { totpSecret })
    await gotoAuthed(dp, '/profile', '#profile-run-limit', CURRENT_PASSWORD, totpSecret)
    const shape = (p) =>
      p.evaluate(() => {
        const bar = document.querySelector('section[aria-label="保存设置"]')
        const inner = bar.firstElementChild
        const btn = bar.querySelector('button')
        const cs = getComputedStyle(bar)
        return {
          position: cs.position,
          bottom: cs.bottom,
          innerDisplay: getComputedStyle(inner).display,
          innerAlign: getComputedStyle(inner).alignItems,
          btnClass: btn.className,
          barChildren: bar.children.length,
        }
      })
    const dShape = await shape(dp)
    const mShape = await shape(mp)
    const same =
      dShape.position === mShape.position &&
      dShape.innerDisplay === mShape.innerDisplay &&
      dShape.innerAlign === mShape.innerAlign &&
      dShape.barChildren === mShape.barChildren &&
      dShape.btnClass === mShape.btnClass
    check(
      'B8.5',
      '移动端与桌面端吸底栏布局一致（position/内层 flex/按钮样式相同，仅安全区内边距与宽度不同）',
      same,
      `桌面=${JSON.stringify(dShape)}；移动=${JSON.stringify(mShape)}`
    )
    await dctx.close()
    await mctx.close()
  } catch (e) {
    try {
      if (mp) await mp.screenshot({ path: `${REPO}/.github/assets/qa/profile-mobile-safe-area-FAIL.png` })
    } catch {
      /* 截图失败不影响结论 */
    }
    check('B8.x', 'B8 移动端 safe-area', false, `异常：${e.message}；失败时 URL=${mp ? mp.url() : 'n/a'}`)
  }

  fs.writeFileSync('/tmp/zeta-qa/ps-results-b.json', JSON.stringify({ results }, null, 2))
  console.log('\n=== 阶段 B 汇总 ===')
  const fail = results.filter((r) => !r.pass)
  console.log(`共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`)
  fail.forEach((f) => {
    console.log(`  FAIL ${f.id} ${f.name} :: ${f.detail}`)
  })
  console.log(`会话自愈次数=${RELOGIN_COUNT}`)
  await browser.close()
})().catch((e) => {
  console.error('脚本异常', e)
  process.exit(1)
})

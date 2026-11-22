/* QA 夹具复位：删除本地一次性 QA 账号及其关联行（仅本地 D1，不触碰生产） */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const REPO = process.env.ZETA_REPO || process.cwd()
const EMAIL = 'qa-split@example.com'
const D1_DIR = path.join(REPO, 'worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject')

let file = null
for (const f of fs.readdirSync(D1_DIR)) {
  if (!f.endsWith('.sqlite') || f === 'metadata.sqlite') continue
  const p = path.join(D1_DIR, f)
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='zeta_users'").get()
    db.close()
    if (t) {
      file = p
      break
    }
  } catch {}
}
if (!file) {
  console.error('找不到本地 D1 文件')
  process.exit(1)
}

const db = new DatabaseSync(file)
db.exec('PRAGMA busy_timeout=5000')
const u = db.prepare('SELECT id FROM zeta_users WHERE email = ?').get(EMAIL)
if (!u) {
  console.log('QA 账号不存在，无需清理')
} else {
  const tables = [
    'zeta_totp_credentials',
    'zeta_passkey_credentials',
    'zeta_notebook_runs',
    'zeta_notebooks',
    'zeta_user_database_permissions',
    'zeta_audit_logs',
  ]
  for (const t of tables) {
    try {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
      if (!has) continue
      const cols = db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => c.name)
      const col = cols.includes('user_id') ? 'user_id' : cols.includes('actor_id') ? 'actor_id' : null
      if (!col) continue
      const r = db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(u.id)
      console.log(`清空 ${t}: ${r.changes}`)
    } catch (e) {
      console.log(`跳过 ${t}: ${e.message}`)
    }
  }
  const r = db.prepare('DELETE FROM zeta_users WHERE id = ?').run(u.id)
  console.log(`删除 zeta_users: ${r.changes}`)
}
console.log('剩余账号数:', db.prepare('SELECT COUNT(*) AS n FROM zeta_users').get().n)
db.close()

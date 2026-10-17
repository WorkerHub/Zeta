import { describe, it, expect } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

describe('POST /api/admin/settings/test-email', () => {
  it('rate-limits test emails per admin', async () => {
    const { db } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await callWorker(
        env,
        '/api/admin/settings/test-email',
        postJson({ to: `x${i}@example.com` }, { headers })
      )
      statuses.push(res.status)
    }
    // No provider configured in tests, so allowed sends fail with 500; the 6th is rate-limited
    expect(statuses).toEqual([500, 500, 500, 500, 500, 429])
  })

  it('answers 400 to a missing or malformed body', async () => {
    const env = fakeEnv()
    const headers = await bearer(env, 'admin-1', 'admin')
    const bad = await callWorker(env, '/api/admin/settings/test-email', { method: 'POST', headers, body: 'nope' })
    expect(bad.status).toBe(400)
    const crlf = await callWorker(
      env,
      '/api/admin/settings/test-email',
      postJson({ to: 'a@example.com\r\nBcc: b@example.com' }, { headers })
    )
    expect(crlf.status).toBe(400)
  })
})

describe('PATCH /api/admin/settings', () => {
  const patch = (body: unknown, headers: Record<string, string>) => postJson(body, { method: 'PATCH', headers })

  it('rejects a malformed sender address without saving anything', async () => {
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    const smtp = JSON.stringify({ host: 'smtp.example.com', from: 'noreply@example.com\r\nRCPT TO:<x@example.com>' })
    const res = await callWorker(env, '/api/admin/settings', patch({ app_name: 'Renamed', smtp_config: smtp }, headers))
    expect(res.status).toBe(400)
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO settings'))).toBe(false)
  })

  it('accepts a valid or empty sender address', async () => {
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    for (const from of ['noreply@example.com', '']) {
      const res = await callWorker(
        env,
        '/api/admin/settings',
        patch({ resend_config: JSON.stringify({ api_key: 're_x', from }) }, headers)
      )
      expect(res.status).toBe(200)
    }
    expect(calls.filter((c) => c.sql.startsWith('INSERT INTO settings'))).toHaveLength(2)
  })
})

describe('PATCH /api/admin/settings email secrets', () => {
  const patch = (body: unknown, headers: Record<string, string>) => postJson(body, { method: 'PATCH', headers })
  const stored = JSON.stringify({ host: 'smtp.example.com', username: 'u', password: 'old-password' })

  async function save(password: unknown) {
    const { db, calls } = fakeD1((sql) =>
      sql.startsWith('SELECT key, value FROM settings') ? [{ key: 'smtp_config', value: stored }] : null
    )
    const env = fakeEnv({ DB: db })
    const config: Record<string, unknown> = { host: 'smtp2.example.com', username: 'u' }
    if (password !== undefined) config.password = password
    const res = await callWorker(
      env,
      '/api/admin/settings',
      patch({ smtp_config: JSON.stringify(config) }, await bearer(env, 'admin-1', 'admin'))
    )
    const write = calls.find((c) => c.sql.startsWith('INSERT INTO settings'))
    return { status: res.status, saved: write ? JSON.parse(write.args[1] as string) : null }
  }

  it('keeps the stored secret when it is omitted or sent back masked', async () => {
    for (const password of [undefined, '••••••']) {
      const { saved } = await save(password)
      expect(saved.host).toBe('smtp2.example.com')
      expect(saved.password).toMatch(/^enc:/)
      expect(saved.password).not.toContain('•')
    }
  })

  it('clears the stored secret when an empty string is sent', async () => {
    const { status, saved } = await save('')
    expect(status).toBe(200)
    expect(saved.password).toBe('')
  })

  it('stores a new secret encrypted', async () => {
    const { saved } = await save('new-password')
    expect(saved.password).toMatch(/^enc:/)
  })

  it('ignores a config whose secret is not a string', async () => {
    const { status, saved } = await save(42)
    expect(status).toBe(200)
    expect(saved).toBeNull()
  })
})

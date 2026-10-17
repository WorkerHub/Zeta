import { describe, it, expect } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

describe('POST /api/admin/settings/test-email', () => {
  it('rate-limits test emails per admin', async () => {
    const { db } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await callWorker(env, '/api/admin/settings/test-email', postJson({ to: `x${i}@example.com` }, { headers }))
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
    const crlf = await callWorker(env, '/api/admin/settings/test-email', postJson({ to: 'a@example.com\r\nBcc: b@example.com' }, { headers }))
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
      const res = await callWorker(env, '/api/admin/settings',
        patch({ resend_config: JSON.stringify({ api_key: 're_x', from }) }, headers))
      expect(res.status).toBe(200)
    }
    expect(calls.filter((c) => c.sql.startsWith('INSERT INTO settings'))).toHaveLength(2)
  })
})

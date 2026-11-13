import { describe, expect, it } from 'vitest'
import { fakeEnv } from '../../routes/__tests__/fakes'
import { sqliteD1 } from '../../routes/__tests__/sqlite-d1'
import type { Env } from '../../types'
import { now } from '../db'
import { getMigrations } from '../migrations'
import {
  beginExecution,
  cancelRequested,
  finishExecution,
  pruneExecutions,
  requestExecutionCancel,
} from '../executions'

// Real SQLite behind the D1 binding: the registry's semantics (conditional UPDATE, RETURNING, the
// conflict takeover) are SQL semantics, not code paths worth emulating.

const EXEC = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

async function registry(): Promise<{ env: Env; sqlite: ReturnType<typeof sqliteD1>['sqlite'] }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'one@example.com', 'One', 'member', 0, 0),
             ('u2', 'two@example.com', 'Two', 'member', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, is_active, created_at)
      VALUES ('db1', 'one', 'pg:db1', 'postgres', 1, 0);
  `)
  return { env: fakeEnv({ DB: app.db, TABLE_PREFIX: '' }), sqlite: app.sqlite }
}

const start = (env: Env, id = EXEC, userId = 'u1') =>
  beginExecution(env, { id, userId, databaseId: 'db1', kind: 'postgres', handle: 'marker-1' })

describe('execution registry', () => {
  it('registers a run before anything executes and reports it as not cancelled', async () => {
    const { env, sqlite } = await registry()

    expect(await start(env)).toEqual({ created: true })
    expect(await cancelRequested(env, EXEC)).toBe(false)
    const row = sqlite.prepare('SELECT * FROM executions WHERE id = ?').all(EXEC)[0] as Record<string, unknown>
    expect(row).toMatchObject({
      user_id: 'u1',
      database_id: 'db1',
      kind: 'postgres',
      handle: 'marker-1',
      cancel_requested_at: null,
      finished_at: null,
      outcome: null,
    })
  })

  it('refuses an id another unfinished execution is using', async () => {
    const { env } = await registry()
    await start(env)

    expect(await start(env)).toEqual({ created: false })
  })

  it('takes over an id whose execution already finished (a client retrying)', async () => {
    const { env, sqlite } = await registry()
    await start(env)
    await finishExecution(env, EXEC, 'ok')

    expect(await start(env)).toEqual({ created: true })
    expect(sqlite.prepare('SELECT finished_at, outcome FROM executions WHERE id = ?').all(EXEC)[0]).toEqual({
      finished_at: null,
      outcome: null,
    })
  })

  it('refuses to take over an id that belongs to another user', async () => {
    const { env } = await registry()
    await start(env)
    await finishExecution(env, EXEC, 'ok')

    expect(
      await beginExecution(env, { id: EXEC, userId: 'u2', databaseId: 'db1', kind: 'postgres', handle: null })
    ).toEqual({ created: false })
  })

  it('records the flag once and keeps the same timestamp on a repeat cancel', async () => {
    const { env, sqlite } = await registry()
    await start(env)

    const first = await requestExecutionCancel(env, EXEC, 'u1')
    expect(first).toMatchObject({ found: true, state: 'cancelled', dispatched: true, handle: 'marker-1' })
    const flag = (
      sqlite.prepare('SELECT cancel_requested_at FROM executions WHERE id = ?').all(EXEC)[0] as {
        cancel_requested_at: number
      }
    ).cancel_requested_at
    expect(flag).not.toBeNull()

    const second = await requestExecutionCancel(env, EXEC, 'u1')
    expect(second).toMatchObject({ found: true, state: 'cancelled', dispatched: false })
    expect(
      (
        sqlite.prepare('SELECT cancel_requested_at FROM executions WHERE id = ?').all(EXEC)[0] as {
          cancel_requested_at: number
        }
      ).cancel_requested_at
    ).toBe(flag)
    expect(await cancelRequested(env, EXEC)).toBe(true)
  })

  it('never cancels for another user, and answers exactly like a missing execution', async () => {
    const { env, sqlite } = await registry()
    await start(env)

    expect(await requestExecutionCancel(env, EXEC, 'u2')).toEqual({ found: false })
    expect(await requestExecutionCancel(env, OTHER, 'u1')).toEqual({ found: false })
    expect(await cancelRequested(env, EXEC)).toBe(false)
    expect(
      (
        sqlite.prepare('SELECT cancel_requested_at FROM executions WHERE id = ?').all(EXEC)[0] as {
          cancel_requested_at: number | null
        }
      ).cancel_requested_at
    ).toBeNull()
  })

  it('answers "finished" — and sends no kill — once the request closed its row', async () => {
    const { env } = await registry()
    await start(env)
    await finishExecution(env, EXEC, 'error')

    expect(await requestExecutionCancel(env, EXEC, 'u1')).toEqual({ found: true, state: 'finished' })
  })

  it('records the outcome only on the first finish', async () => {
    const { env, sqlite } = await registry()
    await start(env)
    await finishExecution(env, EXEC, 'cancelled')
    await finishExecution(env, EXEC, 'ok')

    const row = sqlite.prepare('SELECT finished_at, outcome FROM executions WHERE id = ?').all(EXEC)[0] as {
      finished_at: number | null
      outcome: string
    }
    expect(row.outcome).toBe('cancelled')
    expect(row.finished_at).not.toBeNull()
  })

  it('prunes rows past the retention window, finished or not', async () => {
    const { env, sqlite } = await registry()
    await start(env)
    const other = '33333333-3333-4333-8333-333333333333'
    await start(env, other)
    sqlite.prepare('UPDATE executions SET started_at = ? WHERE id = ?').run(now() - 25 * 60 * 60, EXEC)

    await pruneExecutions(env)

    expect(sqlite.prepare('SELECT id FROM executions').all()).toEqual([{ id: other }])
  })
})

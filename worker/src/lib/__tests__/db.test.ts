import { describe, expect, it } from 'vitest'
import { fakeD1 } from '../../routes/__tests__/fakes'
import {
  DEFAULT_TABLE_PREFIX,
  detectExistingMigrationLedgers,
  detectExistingTableFamily,
  migrationsTable,
  tablePrefix,
  tables,
} from '../db'

describe('tablePrefix', () => {
  it('resolves an unset TABLE_PREFIX to the default prefix', () => {
    expect(tablePrefix({})).toBe('zeta_')
    expect(tablePrefix({ TABLE_PREFIX: undefined })).toBe('zeta_')
    expect(DEFAULT_TABLE_PREFIX).toBe('zeta')
  })

  it('appends the trailing underscore to a custom value, preserving its case verbatim', () => {
    expect(tablePrefix({ TABLE_PREFIX: 'kp' })).toBe('kp_')
    expect(tablePrefix({ TABLE_PREFIX: 'ZETA' })).toBe('ZETA_') // never case-folded
    expect(tablePrefix({ TABLE_PREFIX: 'my_app' })).toBe('my_app_')
  })

  it('resolves an explicitly empty TABLE_PREFIX to no prefix', () => {
    expect(tablePrefix({ TABLE_PREFIX: '' })).toBe('')
  })

  it('keeps rejecting invalid characters', () => {
    for (const bad of ['kp!', ' kp', 'kp ', '  ', 'a-b', 'kp;drop']) {
      expect(() => tablePrefix({ TABLE_PREFIX: bad })).toThrow('TABLE_PREFIX contains invalid characters')
    }
  })
})

describe('tables', () => {
  it('uses the default prefix for every table when TABLE_PREFIX is unset', () => {
    expect(tables({})).toMatchObject({ users: 'zeta_users', settings: 'zeta_settings' })
    expect(Object.values(tables({})).every((name) => name.startsWith('zeta_'))).toBe(true)
  })

  it('uses a custom value as-is, including its case', () => {
    expect(tables({ TABLE_PREFIX: 'kp' }).users).toBe('kp_users')
    expect(tables({ TABLE_PREFIX: 'ZETA' }).user_database_permissions).toBe('ZETA_user_database_permissions')
  })

  it('uses no prefix for an explicitly empty TABLE_PREFIX', () => {
    expect(tables({ TABLE_PREFIX: '' })).toMatchObject({ users: 'users', rate_limits: 'rate_limits' })
  })
})

describe('detectExistingTableFamily', () => {
  const names = (...list: string[]) => fakeD1(() => list.map((name) => ({ name }))).db
  // The full 11-table family as it exists under a TABLE_PREFIX value ('ZETA', 'kp', or '' for none)
  const family = (value: string) => Object.values(tables({ TABLE_PREFIX: value }))

  it('finds nothing in an empty database', async () => {
    expect(await detectExistingTableFamily(names())).toBeNull()
  })

  it('finds a complete family under a custom prefix', async () => {
    expect(await detectExistingTableFamily(names(...family('ZETA')))).toEqual({
      prefix: 'ZETA_',
      tableCount: 11,
    })
  })

  it('finds an unprefixed family (prefix is the empty string)', async () => {
    expect(await detectExistingTableFamily(names(...family('')))).toEqual({ prefix: '', tableCount: 11 })
  })

  it('still detects a family that predates the newest two tables (9 of 11)', async () => {
    expect(await detectExistingTableFamily(names(...family('kp').slice(0, 9)))).toEqual({
      prefix: 'kp_',
      tableCount: 9,
    })
  })

  it('ignores other projects tables, whatever they are named', async () => {
    const foreign = ['SL_perm', 'eNotify_queue', 'TP_logs', 'YL_data', 'TEMP_scratch']
    expect(await detectExistingTableFamily(names(...foreign))).toBeNull()
  })

  it('does not let foreign tables sharing a family suffix reach the threshold', async () => {
    // A shared D1 where other projects happen to have users/settings/audit_logs tables
    expect(
      await detectExistingTableFamily(names('eNotify_users', 'eNotify_settings', 'SL_audit_logs', 'TP_notebooks'))
    ).toBeNull()
  })

  it('ignores a partial family below the threshold', async () => {
    expect(await detectExistingTableFamily(names('ZETA_users', 'ZETA_settings', 'ZETA_audit_logs'))).toBeNull()
  })

  it('detects the real family even when other projects share the database', async () => {
    expect(await detectExistingTableFamily(names('SL_perm', 'eNotify_users', ...family('ZETA')))).toEqual({
      prefix: 'ZETA_',
      tableCount: 11,
    })
  })
})

describe('migrationsTable', () => {
  it('uses the default prefix when TABLE_PREFIX is unset (the zeta_ business prefix)', () => {
    expect(migrationsTable({})).toBe('_zeta_schema_migrations')
    expect(migrationsTable({ TABLE_PREFIX: undefined })).toBe('_zeta_schema_migrations')
  })

  it('keeps a configured value verbatim, including its case', () => {
    expect(migrationsTable({ TABLE_PREFIX: 'ZETA' })).toBe('_ZETA_schema_migrations')
    expect(migrationsTable({ TABLE_PREFIX: 'kp' })).toBe('_kp_schema_migrations')
    expect(migrationsTable({ TABLE_PREFIX: 'my_app' })).toBe('_my_app_schema_migrations')
  })

  it('drops the trailing underscore and the extra one for an explicitly empty prefix', () => {
    expect(migrationsTable({ TABLE_PREFIX: '' })).toBe('_schema_migrations')
  })

  it('never normalises case', () => {
    expect(migrationsTable({ TABLE_PREFIX: 'Zeta' })).not.toBe(migrationsTable({ TABLE_PREFIX: 'zeta' }))
  })

  it('rejects an invalid TABLE_PREFIX through the single prefix helper', () => {
    expect(() => migrationsTable({ TABLE_PREFIX: 'kp!drop' })).toThrow('TABLE_PREFIX contains invalid characters')
  })
})

describe('detectExistingMigrationLedgers', () => {
  const names = (...list: string[]) => fakeD1(() => list.map((name) => ({ name }))).db

  it('finds nothing in an empty database', async () => {
    expect(await detectExistingMigrationLedgers(names())).toEqual([])
  })

  it('finds the unprefixed ledger', async () => {
    expect(await detectExistingMigrationLedgers(names('_schema_migrations'))).toEqual([
      { prefix: '', table: '_schema_migrations' },
    ])
  })

  it('finds prefixed ledgers and keeps their case', async () => {
    expect(await detectExistingMigrationLedgers(names('_ZETA_schema_migrations', '_kp_schema_migrations'))).toEqual([
      { prefix: 'ZETA_', table: '_ZETA_schema_migrations' },
      { prefix: 'kp_', table: '_kp_schema_migrations' },
    ])
  })

  it('ignores business tables and anything that is not a ledger', async () => {
    expect(
      await detectExistingMigrationLedgers(
        names('ZETA_users', 'SL_schema_migrations', '_schema_migration', '_migrations')
      )
    ).toEqual([])
  })
})

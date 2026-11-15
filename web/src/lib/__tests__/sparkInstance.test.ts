import { describe, expect, it } from 'vitest'
import {
  entriesToRows,
  isInstancePending,
  jarDisplayName,
  jarRefsMatch,
  jarServerState,
  judgeApplyStatus,
  parseJarInput,
  rowsMatchEntries,
  rowsToEntries,
  validateInstanceEntry,
} from '../spark-instance'
import type { JarRef, ServerJar, SparkConfigStatus } from '../../types'

const SHA = 'a'.repeat(64)

function status(overrides: Partial<SparkConfigStatus> = {}): SparkConfigStatus {
  return {
    state: 'running',
    epoch: 3,
    inflight: 0,
    effective: { entries: { 'spark.driver.memory': '4g' }, jars: ['my-udf.jar'] },
    lastError: null,
    ...overrides,
  }
}

describe('validateInstanceEntry (§6.2)', () => {
  it('accepts a startup-level key with a plain value', () => {
    expect(validateInstanceEntry('spark.driver.memory', '4g')).toBeNull()
    expect(validateInstanceEntry('spark.executor.cores', '2')).toBeNull()
    // A key that is neither `spark.sql.*` nor a known name is still a startup-level parameter.
    expect(validateInstanceEntry('spark.driver.extraJavaOptions', '-Xmx1g')).toBeNull()
  })

  it('lets a blank line through — it is dropped on save', () => {
    expect(validateInstanceEntry('', '')).toBeNull()
    expect(validateInstanceEntry('   ', '  ')).toBeNull()
  })

  it('blocks runtime `spark.sql.*` keys, with the startup-level ones allowed', () => {
    expect(validateInstanceEntry('spark.sql.shuffle.partitions', '200')).toBe('runtime_key')
    expect(validateInstanceEntry('spark.sql.adaptive.enabled', 'true')).toBe('runtime_key')
    expect(validateInstanceEntry('spark.sql.extensions', 'io.delta.sql.DeltaSparkSessionExtension')).toBeNull()
    expect(validateInstanceEntry('spark.sql.warehouse.dir', '/warehouse')).toBeNull()
    expect(
      validateInstanceEntry('spark.sql.catalog.spark_catalog', 'org.apache.spark.sql.delta.catalog.DeltaCatalog')
    ).toBeNull()
  })

  it('keeps spark.jars out of the entries — jars have their own section', () => {
    expect(validateInstanceEntry('spark.jars', 'delta.jar')).toBe('jars_key')
  })

  it('checks a *.memory value against the Spark memory format', () => {
    for (const value of ['4g', '512m', '2048', '1T', '2K']) {
      expect(validateInstanceEntry('spark.driver.memory', value), value).toBeNull()
    }
    for (const value of ['4X', '4 g', 'g', '-1g', '4gb']) {
      expect(validateInstanceEntry('spark.driver.memory', value), value).toBe('bad_memory')
    }
    // Only *.memory values carry the format; other keys keep free text.
    expect(validateInstanceEntry('spark.default.parallelism', '4X')).toBeNull()
  })

  it('rejects a malformed key, a half-filled row and an over-long value', () => {
    expect(validateInstanceEntry('driver.memory', '4g')).toBe('invalid_key')
    expect(validateInstanceEntry('spark.', '4g')).toBe('invalid_key')
    expect(validateInstanceEntry('spark.driver-memory', '4g')).toBe('invalid_key')
    expect(validateInstanceEntry('spark.driver.memory', '')).toBe('invalid_key')
    expect(validateInstanceEntry('', '4g')).toBe('invalid_key')
    expect(validateInstanceEntry(`spark.${'a'.repeat(130)}`, '4g')).toBe('too_long')
    // The memory format is checked before the value length (the worker's order).
    expect(validateInstanceEntry('spark.driver.memory', 'x'.repeat(513))).toBe('bad_memory')
    expect(validateInstanceEntry('spark.driver.extraJavaOptions', 'x'.repeat(513))).toBe('too_long')
  })
})

describe('parseJarInput (§6.2 jars)', () => {
  it('takes an http(s) URL, optionally pinned with a sha256', () => {
    const plain = parseJarInput('  https://repo1.maven.org/maven2/delta.jar ')
    expect(plain).toEqual({ ok: true, ref: { type: 'url', value: 'https://repo1.maven.org/maven2/delta.jar' } })

    const pinned = parseJarInput('https://repo1.maven.org/maven2/delta.jar', SHA.toUpperCase())
    expect(pinned).toEqual({
      ok: true,
      ref: { type: 'url', value: 'https://repo1.maven.org/maven2/delta.jar', sha256: SHA },
    })
  })

  it('rejects a sha256 that is not 64 hex characters', () => {
    expect(parseJarInput('https://x/delta.jar', 'abc')).toEqual({ ok: false, code: 'bad_sha256' })
    expect(parseJarInput('https://x/delta.jar', 'z'.repeat(64))).toEqual({ ok: false, code: 'bad_sha256' })
  })

  it('takes a bare file name and refuses a path or ".."', () => {
    expect(parseJarInput('my-udf.jar')).toEqual({ ok: true, ref: { type: 'file', value: 'my-udf.jar' } })
    expect(parseJarInput('/jars/delta.jar')).toEqual({ ok: false, code: 'bad_filename' })
    expect(parseJarInput('jars\\delta.jar')).toEqual({ ok: false, code: 'bad_filename' })
    expect(parseJarInput('../delta.jar')).toEqual({ ok: false, code: 'bad_filename' })
    expect(parseJarInput('')).toEqual({ ok: false, code: 'bad_filename' })
  })

  it('only a URL jar may carry a sha256', () => {
    expect(parseJarInput('my-udf.jar', SHA)).toEqual({ ok: false, code: 'bad_sha256' })
  })
})

describe('jarDisplayName', () => {
  it('is the value of a file jar and the last path segment of a URL', () => {
    expect(jarDisplayName({ type: 'file', value: 'my-udf.jar' })).toBe('my-udf.jar')
    expect(jarDisplayName({ type: 'url', value: 'https://repo1.maven.org/maven2/delta-core.jar' })).toBe(
      'delta-core.jar'
    )
    expect(jarDisplayName({ type: 'url', value: 'https://x/y/delta%20core.jar?v=1' })).toBe('delta core.jar')
    expect(jarDisplayName({ type: 'url', value: 'https://x' })).toBe('')
  })
})

describe('jarServerState', () => {
  const listing: ServerJar[] = [{ name: 'my-udf.jar', sizeBytes: 10 }]

  it('says a URL will be downloaded', () => {
    expect(jarServerState({ type: 'url', value: 'https://x/delta.jar' }, listing)).toBe('download')
    expect(jarServerState({ type: 'url', value: 'https://x/delta.jar' }, null)).toBe('download')
  })

  it('looks a file name up in the service listing', () => {
    expect(jarServerState({ type: 'file', value: 'my-udf.jar' }, listing)).toBe('present')
    expect(jarServerState({ type: 'file', value: 'other.jar' }, listing)).toBe('missing')
  })

  it('claims nothing without a listing', () => {
    expect(jarServerState({ type: 'file', value: 'my-udf.jar' }, null)).toBe('unknown')
  })
})

describe('rows and comparisons', () => {
  it('drops blank rows and trims both sides on the way to the wire', () => {
    expect(
      rowsToEntries([
        { key: ' spark.driver.memory ', value: ' 4g ' },
        { key: '', value: '' },
        { key: 'spark.executor.memory', value: '2g' },
      ])
    ).toEqual({ 'spark.driver.memory': '4g', 'spark.executor.memory': '2g' })
  })

  it('shows one blank row for an empty config and keeps stored order otherwise', () => {
    expect(entriesToRows({})).toEqual([{ key: '', value: '' }])
    expect(entriesToRows({ 'spark.b': '1', 'spark.a': '2' })).toEqual([
      { key: 'spark.b', value: '1' },
      { key: 'spark.a', value: '2' },
    ])
  })

  it('matches rows against a stored entries object', () => {
    const rows = [{ key: 'spark.driver.memory', value: '4g' }]
    expect(rowsMatchEntries(rows, { 'spark.driver.memory': '4g' })).toBe(true)
    expect(rowsMatchEntries(rows, { 'spark.driver.memory': '8g' })).toBe(false)
    expect(rowsMatchEntries(rows, { 'spark.driver.memory': '4g', 'spark.executor.cores': '2' })).toBe(false)
  })

  it('compares jar lists by the file name they land under', () => {
    const a: JarRef[] = [{ type: 'url', value: 'https://x/my-udf.jar' }]
    const b: JarRef[] = [{ type: 'file', value: 'my-udf.jar' }]
    expect(jarRefsMatch(a, b)).toBe(true)
    expect(jarRefsMatch(a, [{ type: 'file', value: 'other.jar' }])).toBe(false)
  })
})

describe('isInstancePending — the status line "unapplied changes"', () => {
  const rows = [{ key: 'spark.driver.memory', value: '4g' }]
  const jars: JarRef[] = [{ type: 'file', value: 'my-udf.jar' }]

  it('is what the service runs → not pending', () => {
    expect(isInstancePending(rows, jars, status())).toBe(false)
  })

  it('is not pending without a status to compare against', () => {
    expect(isInstancePending(rows, jars, null)).toBe(false)
    expect(isInstancePending([], [{ type: 'file', value: 'delta.jar' }], null)).toBe(false)
  })

  it('flags a changed entry, an added or a removed jar', () => {
    expect(isInstancePending([{ key: 'spark.driver.memory', value: '8g' }], jars, status())).toBe(true)
    expect(isInstancePending(rows, [...jars, { type: 'file', value: 'delta.jar' }], status())).toBe(true)
    expect(isInstancePending(rows, [], status())).toBe(true)
    // A URL jar matches the file it lands under.
    expect(isInstancePending(rows, [{ type: 'url', value: 'https://x/my-udf.jar' }], status())).toBe(false)
  })
})

describe('judgeApplyStatus — the apply outcome is the polled status, never the reply (§9.3)', () => {
  const expected = {
    entries: { 'spark.driver.memory': '8g' },
    jars: [{ type: 'file', value: 'my-udf.jar' }] as JarRef[],
    epoch: 3,
  }
  // What the service reports once it runs the config the apply asked for.
  const nowRunning = (overrides: Partial<SparkConfigStatus> = {}) =>
    status({ effective: { entries: { 'spark.driver.memory': '8g' }, jars: ['my-udf.jar'] }, ...overrides })

  it('waits while the service drains, restarts, or cannot be read', () => {
    expect(judgeApplyStatus(null, expected)).toEqual({ state: 'waiting' })
    expect(judgeApplyStatus(status({ state: 'draining' }), expected)).toEqual({ state: 'waiting' })
    expect(judgeApplyStatus(status({ state: 'restarting' }), expected)).toEqual({ state: 'waiting' })
  })

  it('is a success once the service runs the expected config', () => {
    expect(judgeApplyStatus(nowRunning(), expected)).toEqual({ state: 'applied' })
  })

  it('is a success when the epoch moved on, even before the config catches up', () => {
    expect(judgeApplyStatus(status({ epoch: 4 }), expected)).toEqual({ state: 'applied' })
  })

  it('is a failure with the service reason when it rolled back', () => {
    expect(
      judgeApplyStatus(status({ state: 'failed_fallback', lastError: 'Jar not found: delta.jar' }), expected)
    ).toEqual({ state: 'failed', lastError: 'Jar not found: delta.jar' })
    expect(judgeApplyStatus(status({ state: 'failed_fallback' }), expected)).toEqual({
      state: 'failed',
      lastError: null,
    })
  })

  it('is a failure when it runs with an error and kept the old config', () => {
    expect(judgeApplyStatus(status({ lastError: 'Cannot allocate 32g' }), expected)).toEqual({
      state: 'failed',
      lastError: 'Cannot allocate 32g',
    })
    // A stale error does not outvote a config that did land.
    expect(judgeApplyStatus(nowRunning({ lastError: 'Cannot allocate 32g' }), expected)).toEqual({ state: 'applied' })
  })

  it('is unchanged when it runs the old config with no error and the same epoch', () => {
    expect(judgeApplyStatus(status(), expected)).toEqual({ state: 'unchanged' })
    // Without an epoch read before applying, only the config itself can decide.
    expect(judgeApplyStatus(status(), { ...expected, epoch: null })).toEqual({ state: 'unchanged' })
  })

  it('treats running as terminal for a dialog that has no apply of its own', () => {
    expect(judgeApplyStatus(status(), null)).toEqual({ state: 'applied' })
  })
})

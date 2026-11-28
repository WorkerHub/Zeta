// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SparkUiMenuLink from '../../components/SparkUiMenuLink'
import querySource from '../../pages/Query.tsx?raw'
import type { Database, User } from '../../types'
import { clearSession, setSession } from '../auth'
import { setLocale, t } from '../translations'

const mockUser: User = {
  id: 'u-1',
  name: 'Test User',
  email: 'test@example.com',
  role: 'member',
  email_verified: 1,
  two_factor_required: 0,
  created_at: 1700000000,
}

let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  clearSession()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearSession()
  setLocale('en')
})

describe('SparkUiMenuLink Component', () => {
  it('renders Spark UI button when selectedDb is spark and has_spark_ui is true', () => {
    const db: Database = {
      id: 'db-spark-1',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    const onSelect = vi.fn()
    render(<SparkUiMenuLink selectedDb={db} onSelect={onSelect} />)

    const button = screen.getByRole('button', { name: /Spark UI/i })
    expect(button).toBeDefined()
    expect(button.getAttribute('href')).toBeNull()
  })

  it('triggers bootstrap POST request with Authorization, Content-Type, credentials and body on click, then opens /spark-ui/', async () => {
    setSession('test-access-token-123', mockUser)

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const db: Database = {
      id: 'spark/special:id?name=foo',
      name: 'Special Spark',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    const onSelect = vi.fn()
    render(<SparkUiMenuLink selectedDb={db} onSelect={onSelect} />)

    const button = screen.getByRole('button', { name: /Spark UI/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/spark-ui/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-access-token-123',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ db: 'spark/special:id?name=foo' }),
      })
    )

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('/spark-ui/', '_blank', 'noopener,noreferrer')
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('triggers bootstrap request on keyboard activation (Enter key)', async () => {
    setSession('test-token-kbd', mockUser)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    const db: Database = {
      id: 'db-spark-kbd',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    const onSelect = vi.fn()
    render(<SparkUiMenuLink selectedDb={db} onSelect={onSelect} />)

    const button = screen.getByRole('button', { name: /Spark UI/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('/spark-ui/', '_blank', 'noopener,noreferrer')
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('handles non-2xx response: does not open new tab and surfaces error message', async () => {
    setSession('test-access-token', mockUser)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const db: Database = {
      id: 'db-spark-1',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    const onSelect = vi.fn()
    const onError = vi.fn()
    render(<SparkUiMenuLink selectedDb={db} onSelect={onSelect} onError={onError} />)

    const button = screen.getByRole('button', { name: /Spark UI/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })

    expect(screen.getByText('Forbidden')).toBeDefined()
    expect(onError).toHaveBeenCalledWith('Forbidden')
    expect(openSpy).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('handles network failure (TypeError): surfaces offline error and does not open new tab', async () => {
    setSession('test-access-token', mockUser)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    const db: Database = {
      id: 'db-spark-1',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    const onSelect = vi.fn()
    const onError = vi.fn()
    render(<SparkUiMenuLink selectedDb={db} onSelect={onSelect} onError={onError} />)

    const button = screen.getByRole('button', { name: /Spark UI/i })
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })

    const offlineMsg = t('errors.network_offline')
    expect(screen.getByText(offlineMsg)).toBeDefined()
    expect(onError).toHaveBeenCalledWith(offlineMsg)
    expect(openSpy).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('handles classified Spark error code in failure response', async () => {
    setSession('test-access-token', mockUser)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'spark_stopped', error: 'Service stopped' }), {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const db: Database = {
      id: 'db-spark-1',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    render(<SparkUiMenuLink selectedDb={db} onSelect={vi.fn()} />)

    const button = screen.getByRole('button', { name: /Spark UI/i })
    fireEvent.click(button)

    const expectedText = t('spark_error.spark_stopped')
    await waitFor(() => {
      expect(screen.getByText(expectedText)).toBeDefined()
    })
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('renders localized label in Chinese when locale is zh', () => {
    setLocale('zh')
    const db: Database = {
      id: 'db-1',
      name: 'Spark',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    render(<SparkUiMenuLink selectedDb={db} onSelect={vi.fn()} />)
    expect(screen.getByText('Spark UI')).toBeDefined()
  })

  it('renders null when selectedDb is null or undefined', () => {
    const { container: c1 } = render(<SparkUiMenuLink selectedDb={null} onSelect={vi.fn()} />)
    expect(c1.innerHTML).toBe('')

    const { container: c2 } = render(<SparkUiMenuLink selectedDb={undefined} onSelect={vi.fn()} />)
    expect(c2.innerHTML).toBe('')
  })

  it('does NOT render Spark UI link when has_spark_ui is false or undefined', () => {
    const dbNoUi: Database = {
      id: 'db-spark-2',
      name: 'Spark No UI',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: false,
    }
    const { container: c1 } = render(<SparkUiMenuLink selectedDb={dbNoUi} onSelect={vi.fn()} />)
    expect(c1.innerHTML).toBe('')

    const dbUndefinedUi: Database = {
      id: 'db-spark-3',
      name: 'Spark Undefined UI',
      description: null,
      kind: 'spark',
      permission: 'read',
    }
    const { container: c2 } = render(<SparkUiMenuLink selectedDb={dbUndefinedUi} onSelect={vi.fn()} />)
    expect(c2.innerHTML).toBe('')
  })

  it('does NOT render Spark UI link for PostgreSQL, MySQL, or SQLite even if has_spark_ui is set', () => {
    const pgDb: Database = {
      id: 'db-pg',
      name: 'PG DB',
      description: null,
      kind: 'postgres',
      permission: 'read',
      has_spark_ui: true,
    }
    const { container: c1 } = render(<SparkUiMenuLink selectedDb={pgDb} onSelect={vi.fn()} />)
    expect(c1.innerHTML).toBe('')

    const mysqlDb: Database = {
      id: 'db-mysql',
      name: 'MySQL DB',
      description: null,
      kind: 'mysql',
      permission: 'read',
      has_spark_ui: true,
    }
    const { container: c2 } = render(<SparkUiMenuLink selectedDb={mysqlDb} onSelect={vi.fn()} />)
    expect(c2.innerHTML).toBe('')

    const sqliteDb: Database = {
      id: 'db-sqlite',
      name: 'D1 DB',
      description: null,
      kind: 'sqlite',
      permission: 'read',
      has_spark_ui: true,
    }
    const { container: c3 } = render(<SparkUiMenuLink selectedDb={sqliteDb} onSelect={vi.fn()} />)
    expect(c3.innerHTML).toBe('')
  })
})

describe('SparkUiMenuLink Integration with Query.tsx', () => {
  it('imports SparkUiMenuLink in Query.tsx', () => {
    expect(querySource).toContain("import SparkUiMenuLink from '../components/SparkUiMenuLink'")
  })

  it('renders SparkUiMenuLink in both desktop and mobile dropdowns with onSelect closing menu', () => {
    const matches = querySource.match(
      /<SparkUiMenuLink selectedDb=\{selectedDb\} onSelect=\{\(\) => setShowDbMenu\(false\)\} onError=\{setPageError\} \/>/g
    )
    expect(matches).toHaveLength(2)
  })
})

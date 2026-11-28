// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SparkUiMenuLink from '../../components/SparkUiMenuLink'
import querySource from '../../pages/Query.tsx?raw'
import type { Database } from '../../types'
import { setLocale } from '../translations'

afterEach(() => {
  cleanup()
  setLocale('en')
})

describe('SparkUiMenuLink Component', () => {
  it('renders Spark UI link when selectedDb is spark and has_spark_ui is true', () => {
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

    const link = screen.getByRole('link', { name: /Spark UI/i })
    expect(link).toBeDefined()
    expect(link.getAttribute('href')).toBe('/spark-ui/?db=db-spark-1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')

    fireEvent.click(link)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('encodes special characters in database ID for the URL query param', () => {
    const db: Database = {
      id: 'spark/special:id?name=foo',
      name: 'Special Spark',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    render(<SparkUiMenuLink selectedDb={db} onSelect={vi.fn()} />)
    const link = screen.getByRole('link', { name: /Spark UI/i })
    expect(link.getAttribute('href')).toBe('/spark-ui/?db=spark%2Fspecial%3Aid%3Fname%3Dfoo')
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
      /<SparkUiMenuLink selectedDb=\{selectedDb\} onSelect=\{\(\) => setShowDbMenu\(false\)\} \/>/g
    )
    expect(matches).toHaveLength(2)
  })
})

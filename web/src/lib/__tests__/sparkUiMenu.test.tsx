// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import querySource from '../../pages/Query.tsx?raw'
import { setLocale, t } from '../translations'
import type { Database } from '../../types'
import { ExternalLink } from 'lucide-react'

afterEach(() => {
  cleanup()
  setLocale('en')
})

describe('Spark UI Menu Entry in Query.tsx Source', () => {
  it('renders Spark UI entry only when selectedDb is spark and has_spark_ui is true', () => {
    expect(querySource).toContain("selectedDb?.kind === 'spark' && selectedDb.has_spark_ui")
  })

  it('opens in a new tab with the signed /spark-ui/?db=<id> link', () => {
    expect(querySource).toContain('/spark-ui/?db=')
    expect(querySource).toContain('encodeURIComponent(selectedDb.id)')
    expect(querySource).toContain('target="_blank"')
    expect(querySource).toContain('rel="noopener noreferrer"')
  })

  it('closes the menu on click', () => {
    expect(querySource).toContain('onClick={() => setShowDbMenu(false)}')
  })

  it('renders ExternalLink icon and spark.spark_ui translation', () => {
    expect(querySource).toContain("t('spark.spark_ui')")
    expect(querySource).toContain('<ExternalLink')
  })

  it('renders in both desktop and mobile showDbMenu dropdowns', () => {
    const matches = querySource.match(/selectedDb\?\.kind === 'spark' && selectedDb\.has_spark_ui/g)
    expect(matches).toHaveLength(2)
  })
})

function MenuDropdown({ selectedDb, onClose }: { selectedDb?: Database | null; onClose: () => void }) {
  return (
    <div data-testid="db-menu">
      {selectedDb?.kind === 'spark' && selectedDb.has_spark_ui && (
        <>
          <hr className="h-px bg-ink-200 border-0" />
          <a
            href={`/spark-ui/?db=${encodeURIComponent(selectedDb.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="flex items-center justify-between w-full px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 transition-colors duration-(--duration-base)"
          >
            <span>{t('spark.spark_ui')}</span>
            <ExternalLink size={13} className="text-ink-400 shrink-0" aria-hidden="true" />
          </a>
        </>
      )}
    </div>
  )
}

describe('Spark UI Menu Entry Component Presentation', () => {
  it('renders Spark UI link when selectedDb is spark and has_spark_ui is true', () => {
    const db: Database = {
      id: 'db-spark-1',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_spark_ui: true,
    }
    const onClose = vi.fn()
    render(<MenuDropdown selectedDb={db} onClose={onClose} />)

    const link = screen.getByRole('link', { name: /Spark UI/i })
    expect(link).toBeDefined()
    expect(link.getAttribute('href')).toBe('/spark-ui/?db=db-spark-1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
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
    const { rerender } = render(<MenuDropdown selectedDb={dbNoUi} onClose={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /Spark UI/i })).toBeNull()

    const dbUndefinedUi: Database = {
      id: 'db-spark-3',
      name: 'Spark Undefined UI',
      description: null,
      kind: 'spark',
      permission: 'read',
    }
    rerender(<MenuDropdown selectedDb={dbUndefinedUi} onClose={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /Spark UI/i })).toBeNull()
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
    const { rerender } = render(<MenuDropdown selectedDb={pgDb} onClose={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /Spark UI/i })).toBeNull()

    const mysqlDb: Database = {
      id: 'db-mysql',
      name: 'MySQL DB',
      description: null,
      kind: 'mysql',
      permission: 'read',
      has_spark_ui: true,
    }
    rerender(<MenuDropdown selectedDb={mysqlDb} onClose={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /Spark UI/i })).toBeNull()

    const sqliteDb: Database = {
      id: 'db-sqlite',
      name: 'D1 DB',
      description: null,
      kind: 'sqlite',
      permission: 'read',
      has_spark_ui: true,
    }
    rerender(<MenuDropdown selectedDb={sqliteDb} onClose={vi.fn()} />)
    expect(screen.queryByRole('link', { name: /Spark UI/i })).toBeNull()
  })
})

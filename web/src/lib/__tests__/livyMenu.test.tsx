// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LivyMenuLink from '../../components/LivyMenuLink'
import querySource from '../../pages/Query.tsx?raw'
import type { Database } from '../../types'
import { setLocale } from '../translations'

afterEach(() => {
  cleanup()
  setLocale('en')
})

describe('LivyMenuLink Component', () => {
  it('renders Livy console and batches buttons when selectedDb is spark and has_livy is true', () => {
    const db: Database = {
      id: 'db-spark-1',
      name: 'Spark Cluster',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_livy: true,
    }
    const onOpenConsole = vi.fn()
    const onOpenBatches = vi.fn()
    render(<LivyMenuLink selectedDb={db} onOpenConsole={onOpenConsole} onOpenBatches={onOpenBatches} />)

    const consoleBtn = screen.getByRole('button', { name: /Livy Console/i })
    expect(consoleBtn).toBeDefined()
    fireEvent.click(consoleBtn)
    expect(onOpenConsole).toHaveBeenCalledTimes(1)

    const batchesBtn = screen.getByRole('button', { name: /Livy Batches/i })
    expect(batchesBtn).toBeDefined()
    fireEvent.click(batchesBtn)
    expect(onOpenBatches).toHaveBeenCalledTimes(1)
  })

  it('renders localized labels in Chinese when locale is zh', () => {
    setLocale('zh')
    const db: Database = {
      id: 'db-1',
      name: 'Spark',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_livy: true,
    }
    render(<LivyMenuLink selectedDb={db} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />)
    expect(screen.getByText('Livy 控制台')).toBeDefined()
    expect(screen.getByText('Livy 批量作业')).toBeDefined()
  })

  it('renders null when selectedDb is null or undefined', () => {
    const { container: c1 } = render(<LivyMenuLink selectedDb={null} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />)
    expect(c1.innerHTML).toBe('')

    const { container: c2 } = render(
      <LivyMenuLink selectedDb={undefined} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />
    )
    expect(c2.innerHTML).toBe('')
  })

  it('does NOT render Livy links when has_livy is false or undefined', () => {
    const dbNoLivy: Database = {
      id: 'db-spark-2',
      name: 'Spark No Livy',
      description: null,
      kind: 'spark',
      permission: 'read',
      has_livy: false,
    }
    const { container: c1 } = render(
      <LivyMenuLink selectedDb={dbNoLivy} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />
    )
    expect(c1.innerHTML).toBe('')

    const dbUndefinedLivy: Database = {
      id: 'db-spark-3',
      name: 'Spark Undefined Livy',
      description: null,
      kind: 'spark',
      permission: 'read',
    }
    const { container: c2 } = render(
      <LivyMenuLink selectedDb={dbUndefinedLivy} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />
    )
    expect(c2.innerHTML).toBe('')
  })

  it('does NOT render Livy links for PostgreSQL, MySQL, or SQLite even if has_livy is set', () => {
    const pgDb: Database = {
      id: 'db-pg',
      name: 'PG DB',
      description: null,
      kind: 'postgres',
      permission: 'read',
      has_livy: true,
    }
    const { container: c1 } = render(<LivyMenuLink selectedDb={pgDb} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />)
    expect(c1.innerHTML).toBe('')

    const mysqlDb: Database = {
      id: 'db-mysql',
      name: 'MySQL DB',
      description: null,
      kind: 'mysql',
      permission: 'read',
      has_livy: true,
    }
    const { container: c2 } = render(
      <LivyMenuLink selectedDb={mysqlDb} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />
    )
    expect(c2.innerHTML).toBe('')

    const sqliteDb: Database = {
      id: 'db-sqlite',
      name: 'D1 DB',
      description: null,
      kind: 'sqlite',
      permission: 'read',
      has_livy: true,
    }
    const { container: c3 } = render(
      <LivyMenuLink selectedDb={sqliteDb} onOpenConsole={vi.fn()} onOpenBatches={vi.fn()} />
    )
    expect(c3.innerHTML).toBe('')
  })
})

describe('LivyMenuLink Integration with Query.tsx', () => {
  it('imports LivyMenuLink and LivyDialog in Query.tsx', () => {
    expect(querySource).toContain("import LivyMenuLink from '../components/LivyMenuLink'")
    expect(querySource).toContain("import LivyDialog from '../components/LivyDialog'")
  })

  it('renders LivyMenuLink in both desktop and mobile dropdowns', () => {
    const matches = querySource.match(/<LivyMenuLink/g)
    expect(matches).toHaveLength(2)
  })

  it('renders LivyDialog in Query.tsx', () => {
    expect(querySource).toContain('<LivyDialog')
    expect(querySource).toContain("selectedDb?.kind === 'spark' && selectedDb.has_livy && (")
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SparkProfilesDialog from '../../components/SparkProfilesDialog'
import { ApiError, sparkProfilesApi } from '../../lib/api'
import type { SparkProfile } from '../../types'
import { setLocale, t } from '../translations'
import { installRadixPolyfills } from './jsdom-radix'

beforeEach(() => {
  installRadixPolyfills()
  setLocale('en')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setLocale('en')
})

const PROFILES: SparkProfile[] = [
  {
    id: 'p1',
    name: 'Analytics',
    entries: [{ key: 'spark.sql.shuffle.partitions', value: '200' }],
    updated_at: 1,
  },
  {
    id: 'p2',
    name: 'Memory tuning',
    entries: [{ key: 'spark.sql.adaptive.enabled', value: 'true' }],
    updated_at: 2,
  },
]

function renderDialog(props: Partial<Parameters<typeof SparkProfilesDialog>[0]> = {}) {
  const handlers = { onOpenChange: vi.fn(), onSelectProfile: vi.fn(), onSaved: vi.fn() }
  render(
    <SparkProfilesDialog open databaseId="db1" profiles={PROFILES} selectedProfileId="p1" {...handlers} {...props} />
  )
  return { ...handlers, user: userEvent.setup() }
}

const nameInput = () => screen.getByLabelText(t('spark.name')) as HTMLInputElement
const buttons = () => screen.getAllByRole('button')

describe('SparkProfilesDialog', () => {
  it('opens on the current connection selection with its rows loaded', async () => {
    renderDialog()
    expect(await screen.findByRole('heading', { name: t('spark.dialog_title') })).toBeTruthy()
    expect(nameInput().value).toBe('Analytics')
    expect((screen.getByLabelText('key') as HTMLInputElement).value).toBe('spark.sql.shuffle.partitions')
    expect((screen.getByLabelText('value') as HTMLInputElement).value).toBe('200')
  })

  it('pins the built-in default as the first entry and makes it read-only', async () => {
    const { onSelectProfile, user } = renderDialog()
    // left list order: default, then the caller's profiles
    const list = buttons()
      .filter((b) => b.className.includes('w-full rounded-md px-2.5'))
      .map((b) => b.textContent)
    expect(list).toEqual([t('spark.default_profile'), 'Analytics', 'Memory tuning'])

    await user.click(screen.getByRole('button', { name: t('spark.default_profile') }))
    expect(onSelectProfile).toHaveBeenCalledWith(null)
    expect(nameInput().disabled).toBe(true)
    expect(nameInput().value).toBe(t('spark.default_profile'))
    expect((screen.getByRole('button', { name: t('spark.delete_profile') }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: t('spark.save') }) as HTMLButtonElement).disabled).toBe(true)
    // The built-in default carries no rows at all: the editor is empty and its "add row" is off.
    expect(screen.queryAllByLabelText('key')).toHaveLength(0)
    expect((screen.getByRole('button', { name: t('spark.add_row') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts a blank draft on "+ New"', async () => {
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: t('spark.new_profile') }))
    expect(nameInput().value).toBe('')
    expect(nameInput().disabled).toBe(false)
    const keys = screen.getAllByLabelText('key') as HTMLInputElement[]
    expect(keys).toHaveLength(1)
    expect(keys[0]!.value).toBe('')
    expect((screen.getByRole('button', { name: t('spark.delete_profile') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a duplicate key with its own copy, not the invalid-key copy', async () => {
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: t('spark.add_row') }))
    const keys = screen.getAllByLabelText('key') as HTMLInputElement[]
    const values = screen.getAllByLabelText('value') as HTMLInputElement[]
    await user.type(keys[1]!, 'spark.sql.shuffle.partitions')
    await user.type(values[1]!, '200')
    expect((await screen.findAllByText(t('spark.duplicate_key', { key: 'spark.sql.shuffle.partitions' }))).length).toBe(
      2
    )
    expect(screen.queryByText(t('spark_error.invalid_key', { key: 'spark.sql.shuffle.partitions' }))).toBeNull()
  })

  it('maps a server key error onto a row whose input carries surrounding whitespace', async () => {
    vi.spyOn(sparkProfilesApi, 'update').mockRejectedValue(
      new ApiError('Invalid key', 400, { error: 'Invalid key', code: 'invalid_key', key: 'spark.sql.nope' })
    )
    const { user } = renderDialog()
    const key = screen.getByLabelText('key') as HTMLInputElement
    await user.clear(key)
    await user.type(key, '  spark.sql.nope  ')
    await user.click(screen.getByRole('button', { name: t('spark.save') }))

    // cleanedEntries() trims before sending, so the row's trimmed key is what the 400 names
    await waitFor(() =>
      expect(sparkProfilesApi.update).toHaveBeenCalledWith('db1', 'p1', {
        name: 'Analytics',
        entries: [{ key: 'spark.sql.nope', value: '200' }],
      })
    )
    expect(await screen.findByText(t('spark_error.invalid_key', { key: 'spark.sql.nope' }))).toBeTruthy()
  })

  it('saves a new draft and selects it', async () => {
    const created: SparkProfile = { id: 'p3', name: 'Fresh', entries: [], updated_at: 3 }
    vi.spyOn(sparkProfilesApi, 'create').mockResolvedValue(created)
    const { onSelectProfile, onSaved, user } = renderDialog()
    await user.click(screen.getByRole('button', { name: t('spark.new_profile') }))
    await user.type(nameInput(), 'Fresh')
    await user.click(screen.getByRole('button', { name: t('spark.save') }))

    await waitFor(() => expect(sparkProfilesApi.create).toHaveBeenCalledWith('db1', { name: 'Fresh', entries: [] }))
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSelectProfile).toHaveBeenCalledWith('p3')
  })

  it('confirms before deleting a profile', async () => {
    vi.spyOn(sparkProfilesApi, 'remove').mockResolvedValue({ message: 'Deleted' })
    const { onSelectProfile, user } = renderDialog({ selectedProfileId: 'p2' })
    // the dialog opens on the connection selection
    expect(nameInput().value).toBe('Memory tuning')
    await user.click(screen.getByRole('button', { name: t('spark.delete_profile') }))

    // §7.3: the delete goes through the shared confirmation, not straight to the API
    const alert = await screen.findByRole('alertdialog')
    expect(alert.textContent).toContain(t('spark.delete_confirm_title'))
    expect(sparkProfilesApi.remove).not.toHaveBeenCalled()

    await user.click(within(alert).getByRole('button', { name: t('common.delete') }))
    await waitFor(() => expect(sparkProfilesApi.remove).toHaveBeenCalledWith('db1', 'p2'))
    expect(onSelectProfile).toHaveBeenCalledWith(null)
  })
})

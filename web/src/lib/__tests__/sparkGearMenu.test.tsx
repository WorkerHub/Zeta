// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SparkGearMenu from '../../components/SparkGearMenu'
import type { SparkProfile } from '../../types'
import { setLocale, t } from '../translations'
import { installRadixPolyfills } from './jsdom-radix'

beforeEach(() => {
  installRadixPolyfills()
  setLocale('en')
})

afterEach(() => {
  cleanup()
  setLocale('en')
})

const PROFILES: SparkProfile[] = [
  { id: 'p1', name: 'Analytics', entries: [], updated_at: 1 },
  { id: 'p2', name: 'Memory tuning', entries: [], updated_at: 2 },
]

function renderMenu(props: Partial<Parameters<typeof SparkGearMenu>[0]> = {}) {
  const onSelectProfile = vi.fn()
  const onOpenManage = vi.fn()
  render(
    <SparkGearMenu
      profiles={PROFILES}
      selectedProfileId="p1"
      onSelectProfile={onSelectProfile}
      onOpenManage={onOpenManage}
      {...props}
    />
  )
  return { onSelectProfile, onOpenManage, user: userEvent.setup() }
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: t('spark.gear_label') }))
  await screen.findByRole('menu')
}

describe('SparkGearMenu', () => {
  it('lists the built-in default and every profile, checking the current one', async () => {
    const { user } = renderMenu()
    await openMenu(user)
    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((el) => el.textContent)).toEqual([t('spark.default_profile'), 'Analytics', 'Memory tuning'])
    expect(screen.getByRole('menuitemradio', { name: t('spark.default_profile') }).getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(screen.getByRole('menuitemradio', { name: 'Analytics' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Memory tuning' }).getAttribute('aria-checked')).toBe('false')
  })

  it('checks the built-in default when no profile is selected', async () => {
    const { user } = renderMenu({ selectedProfileId: null })
    await openMenu(user)
    expect(
      (await screen.findByRole('menuitemradio', { name: t('spark.default_profile') })).getAttribute('aria-checked')
    ).toBe('true')
  })

  it('reports a picked profile, and null for the built-in default', async () => {
    const { onSelectProfile, user } = renderMenu()
    await openMenu(user)
    await user.click(screen.getByRole('menuitemradio', { name: 'Memory tuning' }))
    expect(onSelectProfile).toHaveBeenCalledWith('p2')

    await openMenu(user)
    await user.click(screen.getByRole('menuitemradio', { name: t('spark.default_profile') }))
    expect(onSelectProfile).toHaveBeenLastCalledWith(null)
  })

  it('opens the manage dialog and ships no dead instance-config entry', async () => {
    const { onOpenManage, user } = renderMenu()
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: t('spark.manage_configs') }))
    expect(onOpenManage).toHaveBeenCalledTimes(1)
    // §7.4 belongs to the instance-config dialog task: no entry until that dialog exists.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.queryByText(/instance config/i)).toBeNull()
  })
})

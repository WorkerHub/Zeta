// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SparkInstanceConfigDialog from '../../components/SparkInstanceConfigDialog'
import { sparkInstanceConfigApi } from '../../lib/api'
import type { JarRef, SparkConfigStatus } from '../../types'
import { setLocale, t } from '../translations'
import { installRadixPolyfills } from './jsdom-radix'

beforeEach(() => {
  installRadixPolyfills()
  setLocale('en')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  setLocale('en')
})

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

const JARS: JarRef[] = [{ type: 'file', value: 'my-udf.jar' }]

type GetResult = Awaited<ReturnType<typeof sparkInstanceConfigApi.get>>

function config(overrides: Partial<GetResult> = {}): GetResult {
  return {
    entries: { 'spark.driver.memory': '4g' },
    jars: JARS,
    status: status(),
    serverJars: [{ name: 'my-udf.jar', sizeBytes: 1234 }],
    ...overrides,
  }
}

function mockApi() {
  const get = vi.spyOn(sparkInstanceConfigApi, 'get')
  const save = vi.spyOn(sparkInstanceConfigApi, 'save')
  const apply = vi.spyOn(sparkInstanceConfigApi, 'apply')
  get.mockResolvedValue(config())
  // The PUT echoes what was sent, so the dialog's stored snapshot moves with the draft.
  save.mockImplementation(async (_id: string, body: { entries: Record<string, string>; jars: JarRef[] }) => body)
  apply.mockResolvedValue({ state: 'draining' })
  return { get, save, apply }
}

function renderDialog() {
  const onOpenChange = vi.fn()
  const user = userEvent.setup()
  render(<SparkInstanceConfigDialog open databaseId="db1" onOpenChange={onOpenChange} />)
  return { onOpenChange, user }
}

/**
 * Clicks and types without userEvent: its wrapper waits on a real setTimeout, which the polling
 * tests have already faked. fireEvent drives the same React handlers synchronously.
 */
const click = (element: Element) => {
  fireEvent.click(element)
}

const typeInto = (element: Element, value: string) => {
  fireEvent.change(element, { target: { value } })
}

/** Drains the loaded config's promise chain without moving the clock. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Advances the fake clock by one poll interval and drains what the poll resolved. */
const tick = async (ms = 2000) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const footerButton = (label: string) => {
  const dialog = screen.getByRole('dialog')
  const buttons = within(dialog)
    .getAllByRole('button', { name: label })
    .filter((button) => button.closest('[role="alertdialog"]') === null) as HTMLButtonElement[]
  return buttons[0]!
}

const confirmCard = () => screen.getByRole('alertdialog')

describe('SparkInstanceConfigDialog — loading and the status line', () => {
  it('opens on the stored config with its effective summary', async () => {
    const { get } = mockApi()
    renderDialog()
    await settle()

    expect(screen.getByRole('heading', { name: t('spark.instance_dialog_title') })).toBeTruthy()
    expect(get).toHaveBeenCalledWith('db1')
    expect((screen.getByLabelText('value') as HTMLInputElement).value).toBe('4g')
    expect((screen.getByLabelText(t('spark.jar_input_label')) as HTMLInputElement).value).toBe('my-udf.jar')
    expect(screen.getByText(t('spark.jar_state_present'))).toBeTruthy()
    expect(screen.getByText(t('spark.instance_status_running'))).toBeTruthy()
    expect(screen.getByText(t('spark.instance_summary', { memory: '4g', count: 1 }))).toBeTruthy()
  })

  it('says the status is unknown when the service cannot be reached', async () => {
    const { get } = mockApi()
    get.mockResolvedValue(config({ status: null, serverJars: null }))
    renderDialog()
    await settle()

    expect(screen.getByText(t('spark.instance_status_unknown'))).toBeTruthy()
    expect(screen.getByText(t('spark.instance_status_unknown_note'))).toBeTruthy()
    // No summary, and no chip claiming anything about the jar.
    expect(screen.queryByText(t('spark.instance_status_running'))).toBeNull()
    expect(screen.queryByText(t('spark.jar_state_present'))).toBeNull()
    expect(screen.queryByText(t('spark.jar_state_missing'))).toBeNull()
    // Applying stays possible: the API answers with its own sentence if the service is down.
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(false)
  })

  it('reports a load failure instead of an empty form', async () => {
    const { get } = mockApi()
    get.mockRejectedValue(new Error('Access denied'))
    renderDialog()
    await settle()

    expect(screen.getByText('Access denied')).toBeTruthy()
    expect(footerButton(t('spark.save')).disabled).toBe(true)
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(true)
  })
})

describe('SparkInstanceConfigDialog — the draft', () => {
  it('turns an edit into "unapplied changes" and saves the map and the jar references', async () => {
    const { save } = mockApi()
    const { user } = renderDialog()
    await settle()

    const value = screen.getByLabelText('value')
    expect(screen.getByText(t('spark.instance_status_running'))).toBeTruthy()
    await user.clear(value)
    await user.type(value, '8g')
    expect(screen.getByText(t('spark.instance_status_pending'))).toBeTruthy()

    await user.click(footerButton(t('spark.save')))
    await settle()
    expect(save).toHaveBeenCalledWith('db1', {
      entries: { 'spark.driver.memory': '8g' },
      jars: [{ type: 'file', value: 'my-udf.jar' }],
    })
    // Saved, still not what the service runs.
    expect(screen.getByText(t('spark.instance_status_pending'))).toBeTruthy()
  })

  it('shows the three jar chips', async () => {
    const { get } = mockApi()
    get.mockResolvedValue(
      config({
        jars: [
          { type: 'url', value: 'https://repo1.maven.org/maven2/delta-core.jar' },
          { type: 'file', value: 'my-udf.jar' },
          { type: 'file', value: 'other.jar' },
        ],
        status: status({
          effective: {
            entries: { 'spark.driver.memory': '4g' },
            jars: ['delta-core.jar', 'my-udf.jar', 'other.jar'],
          },
        }),
      })
    )
    renderDialog()
    await settle()

    expect(screen.getByText(t('spark.jar_state_download'))).toBeTruthy()
    expect(screen.getByText(t('spark.jar_state_present'))).toBeTruthy()
    expect(screen.getByText(t('spark.jar_state_missing'))).toBeTruthy()
    // The draft matches what the service runs, jars included.
    expect(screen.getByText(t('spark.instance_status_running'))).toBeTruthy()
  })

  it('warns about a jar the service does not have, yet still saves it', async () => {
    const { save } = mockApi()
    const { user } = renderDialog()
    await settle()

    await user.click(screen.getByRole('button', { name: t('spark.jar_add') }))
    const jarInputs = screen.getAllByLabelText(t('spark.jar_input_label')) as HTMLInputElement[]
    await user.type(jarInputs[1]!, 'missing.jar')
    expect(screen.getByText(t('spark.jar_state_missing'))).toBeTruthy()

    await user.click(footerButton(t('spark.save')))
    await settle()
    expect(save).toHaveBeenCalledWith('db1', {
      entries: { 'spark.driver.memory': '4g' },
      jars: [
        { type: 'file', value: 'my-udf.jar' },
        { type: 'file', value: 'missing.jar' },
      ],
    })
  })

  it('blocks a runtime parameter with the sentence that points at the personal config', async () => {
    mockApi()
    const { user } = renderDialog()
    await settle()

    const key = screen.getByLabelText('key')
    await user.clear(key)
    await user.type(key, 'spark.sql.shuffle.partitions')
    expect(
      screen.getByText(t('spark_error.instance_runtime_key', { key: 'spark.sql.shuffle.partitions' }))
    ).toBeTruthy()
  })

  it('keeps an invalid parameter row from reaching the API', async () => {
    const { save } = mockApi()
    const { user } = renderDialog()
    await settle()

    const value = screen.getByLabelText('value')
    await user.clear(value)
    await user.type(value, '4X')
    expect(screen.getByText(t('spark_error.instance_bad_memory', { key: 'spark.driver.memory' }))).toBeTruthy()

    await user.click(footerButton(t('spark.save')))
    await settle()
    // The row's own message is the whole explanation — the worker's English rule never arrives.
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects a jar carrying a bad sha256 before it reaches the API', async () => {
    const { save } = mockApi()
    const { user } = renderDialog()
    await settle()

    await user.click(screen.getByRole('button', { name: t('spark.jar_add') }))
    const jarInputs = screen.getAllByLabelText(t('spark.jar_input_label')) as HTMLInputElement[]
    await user.type(jarInputs[1]!, 'https://repo1.maven.org/maven2/delta.jar')
    await user.type(screen.getByLabelText(t('spark.jar_sha256_label')), 'abc')
    expect(screen.getByText(t('spark_error.instance_bad_sha256'))).toBeTruthy()

    await user.click(footerButton(t('spark.save')))
    await settle()
    expect(save).not.toHaveBeenCalled()
  })
})

describe('SparkInstanceConfigDialog — apply and poll', () => {
  it('confirms with the in-flight count, applies, polls to running and re-enables both buttons', async () => {
    vi.useFakeTimers()
    const { get, save, apply } = mockApi()
    get
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(config({ status: status({ inflight: 2 }) }))
      .mockResolvedValueOnce(config({ status: status({ state: 'draining', inflight: 2 }) }))
      .mockResolvedValueOnce(config({ status: status({ state: 'restarting' }) }))
      .mockResolvedValueOnce(
        config({
          status: status({
            epoch: 4,
            effective: { entries: { 'spark.driver.memory': '8g' }, jars: ['my-udf.jar'] },
          }),
        })
      )
    renderDialog()
    await settle()

    typeInto(screen.getByLabelText('value'), '8g')

    click(footerButton(t('spark.instance_apply')))
    await settle()
    const card = confirmCard()
    expect(within(card).getByText(t('spark.instance_confirm_title'))).toBeTruthy()
    // The freeze sentence, the live in-flight count, and the "saves first" note (the draft is dirty).
    expect(card.textContent).toContain('Queries in flight right now: 2.')
    expect(card.textContent).toContain('The restart waits for all of them to finish')
    expect(card.textContent).toContain('Your current edits are saved first.')
    expect(apply).not.toHaveBeenCalled()

    click(within(card).getByRole('button', { name: t('spark.instance_apply') }))
    await settle()
    expect(save).toHaveBeenCalled()
    expect(apply).toHaveBeenCalledWith('db1')
    // While the environment applies, both actions are disabled.
    expect(footerButton(t('spark.save')).disabled).toBe(true)
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(true)

    await tick()
    expect(screen.getByText(t('spark.instance_status_draining', { n: 2 }))).toBeTruthy()
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(true)

    await tick()
    expect(screen.getByText(t('spark.instance_status_restarting'))).toBeTruthy()

    await tick()
    expect(screen.getByText(t('spark.instance_status_running'))).toBeTruthy()
    expect(screen.getByText(t('spark.instance_summary', { memory: '8g', count: 1 }))).toBeTruthy()
    expect(footerButton(t('spark.save')).disabled).toBe(false)
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(false)
    // The terminal state stops the polling.
    const calls = get.mock.calls.length
    await tick(6000)
    expect(get.mock.calls.length).toBe(calls)
  })

  it('reports a rolled-back apply with its reason', async () => {
    vi.useFakeTimers()
    const { get } = mockApi()
    get
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(config({ status: status({ state: 'draining', inflight: 0 }) }))
      .mockResolvedValueOnce(
        config({ status: status({ state: 'failed_fallback', lastError: 'Jar not found: delta.jar' }) })
      )
    renderDialog()
    await settle()

    click(footerButton(t('spark.instance_apply')))
    await settle()
    click(within(confirmCard()).getByRole('button', { name: t('spark.instance_apply') }))
    await settle()

    await tick()
    // Draining with nothing in flight reads as "draining", not "draining 0 queries".
    expect(screen.getByText(t('spark.instance_status_draining_unknown'))).toBeTruthy()

    await tick()
    expect(screen.getByText(t('spark.instance_status_failed'))).toBeTruthy()
    expect(screen.getByText('Jar not found: delta.jar')).toBeTruthy()
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(false)
  })

  it('gives up after three minutes of waiting and says so', async () => {
    vi.useFakeTimers()
    const { get } = mockApi()
    get
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(config())
      .mockResolvedValue(config({ status: status({ state: 'restarting' }) }))
    renderDialog()
    await settle()

    click(footerButton(t('spark.instance_apply')))
    await settle()
    click(within(confirmCard()).getByRole('button', { name: t('spark.instance_apply') }))
    await settle()
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(true)

    await tick(180_000)
    expect(screen.getByText(t('spark.instance_poll_timeout'))).toBeTruthy()
    expect(footerButton(t('spark.instance_apply')).disabled).toBe(false)
  })

  it('warns with the count-less copy when the in-flight number is unknown', async () => {
    const { get } = mockApi()
    get.mockResolvedValueOnce(config()).mockResolvedValueOnce(config({ status: null, serverJars: null }))
    const { user } = renderDialog()
    await settle()

    await user.click(footerButton(t('spark.instance_apply')))
    await settle()
    expect(confirmCard().textContent).toContain('The number of queries in flight is unknown.')
    await user.click(within(confirmCard()).getByRole('button', { name: t('common.cancel') }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

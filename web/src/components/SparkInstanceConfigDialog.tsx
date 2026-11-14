import { Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from '../hooks/useLocale'
import { sparkInstanceConfigApi } from '../lib/api'
import {
  INSTANCE_JARS_MAX,
  entriesToRows,
  isInstancePending,
  jarRefsMatch,
  jarServerState,
  parseJarInput,
  rowsMatchEntries,
  rowsToEntries,
  validateInstanceEntry,
  type InstanceJarError,
} from '../lib/spark-instance'
import type { JarRef, ProfileEntry, ServerJar, SparkConfigState, SparkConfigStatus } from '../types'
import ConfirmDialog from './ConfirmDialog'
import Dialog from './Dialog'
import KeyValueEditor from './KeyValueEditor'

const KEY_PLACEHOLDER = 'spark.driver.memory'
const VALUE_PLACEHOLDER = '4g'
// SPEC §6.1: poll every 2 s and give up after 3 minutes of waiting.
const POLL_INTERVAL_MS = 2000
const POLL_LIMIT_MS = 180_000

interface JarRow {
  value: string
  sha256: string
}

const EMPTY_JAR: JarRow = { value: '', sha256: '' }
const EMPTY_ROW: ProfileEntry = { key: '', value: '' }

function toJarRows(jars: JarRef[]): JarRow[] {
  return jars.map((ref) => ({ value: ref.value, sha256: ref.sha256 ?? '' }))
}

/** A jar row counts as a URL while it carries the scheme the service downloads from. */
function isUrlRow(row: JarRow): boolean {
  return /^https?:\/\//i.test(row.value.trim())
}

function jarErrorText(t: (key: string) => string, code: InstanceJarError): string {
  return code === 'bad_sha256' ? t('spark_error.instance_bad_sha256') : t('spark_error.instance_bad_jar')
}

type StatusTone = 'green' | 'yellow' | 'red' | 'ink'

interface StatusLine {
  tone: StatusTone
  text: string
  /** Second line under the status: the failure reason, the unknown-state note, the poll timeout. */
  note: string | null
  noteTone: 'danger' | 'ink'
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  databaseId: string
}

/**
 * The instance-config dialog (§7.4): a status line, the startup-level parameters (the shared
 * key-value row editor with the §6.2 validator injected) and the jar list. The expected config is
 * stored by PUT; "apply and restart" hands it to the service and polls GET (2 s, at most 3 minutes)
 * until the service reports a terminal state, so the dialog's two buttons stay disabled while the
 * environment drains and restarts.
 */
export default function SparkInstanceConfigDialog({ open, onOpenChange, databaseId }: Props) {
  const { t } = useLocale()

  // The draft being edited, and the stored config it started from (the confirm copy names the
  // difference: an apply saves the draft first).
  const [rows, setRows] = useState<ProfileEntry[]>([EMPTY_ROW])
  const [jarRows, setJarRows] = useState<JarRow[]>([])
  const [stored, setStored] = useState<{ entries: Record<string, string>; jars: JarRef[] } | null>(null)

  // The service's side: its status and jar listing, both null when it could not be reached.
  const [status, setStatus] = useState<SparkConfigStatus | null>(null)
  const [serverJars, setServerJars] = useState<ServerJar[] | null>(null)
  // The state the apply call reported, kept until the first poll answers (the status may be null,
  // e.g. the service was unreachable at open time, and the line should still say "applying").
  const [applyState, setApplyState] = useState<SparkConfigState | null>(null)

  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [polling, setPolling] = useState(false)
  const [pollTimedOut, setPollTimedOut] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmStatus, setConfirmStatus] = useState<SparkConfigStatus | null>(null)

  const jarInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const [focusJarIndex, setFocusJarIndex] = useState<number | null>(null)

  useEffect(() => {
    if (focusJarIndex === null) return
    jarInputRefs.current[focusJarIndex]?.focus()
    setFocusJarIndex(null)
  }, [focusJarIndex])

  const applySnapshot = useCallback((next: { entries: Record<string, string>; jars: JarRef[] }) => {
    setRows(entriesToRows(next.entries))
    setJarRows(toJarRows(next.jars))
    setStored({ entries: next.entries, jars: next.jars })
  }, [])

  // On open, read the stored config together with the service's current status and jar listing.
  useEffect(() => {
    if (!open) {
      setPolling(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setDialogError(null)
    setPollTimedOut(false)
    setApplyState(null)
    sparkInstanceConfigApi
      .get(databaseId)
      .then((res) => {
        if (cancelled) return
        applySnapshot({ entries: res.entries, jars: res.jars })
        setStatus(res.status)
        setServerJars(res.serverJars)
        setLoaded(true)
        // An environment left draining/restarting (by this user or another one) keeps polling.
        setPolling(res.status?.state === 'draining' || res.status?.state === 'restarting')
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : t('spark.instance_load_failed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, databaseId, applySnapshot, t])

  // The poll loop (§6.1): one GET every 2 s until a terminal state or the 3-minute limit. A null
  // status (the service is restarting, its port briefly closed) is not a failure — keep waiting.
  useEffect(() => {
    if (!open || !polling) return
    let cancelled = false
    let timer: number | undefined
    const deadline = Date.now() + POLL_LIMIT_MS
    const tick = async () => {
      let next: { status: SparkConfigStatus | null; serverJars: ServerJar[] | null } | null = null
      try {
        next = await sparkInstanceConfigApi.get(databaseId)
      } catch {
        next = null
      }
      if (cancelled) return
      if (next) {
        setStatus(next.status)
        setServerJars(next.serverJars)
        setApplyState(null)
      }
      const state = next?.status?.state
      if (state === 'running' || state === 'failed_fallback') {
        setPolling(false)
        setPollTimedOut(false)
        return
      }
      if (Date.now() >= deadline) {
        setPolling(false)
        setPollTimedOut(true)
        return
      }
      timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    }
    timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [open, polling, databaseId])

  // The draft's jar references; a blank row is dropped, an invalid one is shown inline.
  const parsedJars = jarRows.map((row) => ({ row, parsed: parseJarInput(row.value, row.sha256) }))
  const draftJars = parsedJars.flatMap(({ row, parsed }) => (row.value.trim() !== '' && parsed.ok ? [parsed.ref] : []))

  const dirty = stored !== null && (!rowsMatchEntries(rows, stored.entries) || !jarRefsMatch(draftJars, stored.jars))

  const pending = loaded && isInstancePending(rows, draftJars, status)
  const summary = status
    ? t('spark.instance_summary', {
        memory: status.effective.entries?.['spark.driver.memory'] ?? '—',
        count: status.effective.jars?.length ?? 0,
      })
    : null

  const statusLine = (): StatusLine => {
    const state = applyState ?? status?.state ?? null
    if (state === 'draining') {
      const inflight = status?.inflight ?? 0
      return {
        tone: 'yellow',
        text:
          inflight > 0
            ? t('spark.instance_status_draining', { n: inflight })
            : t('spark.instance_status_draining_unknown'),
        note: null,
        noteTone: 'ink',
      }
    }
    if (state === 'restarting') {
      return { tone: 'yellow', text: t('spark.instance_status_restarting'), note: null, noteTone: 'ink' }
    }
    if (state === 'failed_fallback') {
      return {
        tone: 'red',
        text: t('spark.instance_status_failed'),
        note: status?.lastError ?? null,
        noteTone: 'danger',
      }
    }
    if (!status) {
      return {
        tone: 'ink',
        text: t('spark.instance_status_unknown'),
        note: t('spark.instance_status_unknown_note'),
        noteTone: 'ink',
      }
    }
    if (pending) {
      return { tone: 'yellow', text: t('spark.instance_status_pending'), note: null, noteTone: 'ink' }
    }
    return { tone: 'green', text: t('spark.instance_status_running'), note: null, noteTone: 'ink' }
  }

  // Before the first answer there is nothing to report yet — say so instead of "status unknown".
  const line: StatusLine =
    !loaded && loading ? { tone: 'ink', text: t('common.loading'), note: null, noteTone: 'ink' } : statusLine()
  const pollNote = pollTimedOut ? t('spark.instance_poll_timeout') : null
  const busy = !loaded || saving || checking || applying || polling

  // One validator for the row editor (§6.2), the same rules the worker enforces; duplicate keys
  // are a list-level concern the entries object cannot hold, so it is checked here.
  const validateRow = (row: ProfileEntry, all: ProfileEntry[]): string | null => {
    const key = row.key.trim()
    const code = validateInstanceEntry(row.key, row.value)
    if (code === 'runtime_key') return t('spark_error.instance_runtime_key', { key })
    if (code === 'jars_key') return t('spark_error.instance_jars_key')
    if (code === 'bad_memory') return t('spark_error.instance_bad_memory', { key })
    if (code === 'too_long') return t('spark_error.instance_too_long', { key })
    if (code === 'invalid_key') return t('spark_error.instance_bad_key', { key: key || '…' })
    if (key && all.filter((other) => other.key.trim() === key).length > 1) {
      return t('spark.duplicate_key', { key })
    }
    return null
  }

  // Stores the draft as the expected config. Rows are validated first, so an unusable line never
  // reaches the API — the row's own message is the whole explanation, and the worker would answer
  // the same rule in English; the stored snapshot is refreshed from the response.
  const persistDraft = async (): Promise<boolean> => {
    if (!loaded) return false
    if (rows.some((row) => validateRow(row, rows) !== null)) return false
    for (const { row, parsed } of parsedJars) {
      if (row.value.trim() === '') continue
      if (!parsed.ok) {
        setDialogError(jarErrorText(t, parsed.code))
        return false
      }
    }
    setDialogError(null)
    setSaving(true)
    try {
      const res = await sparkInstanceConfigApi.save(databaseId, {
        entries: rowsToEntries(rows),
        jars: draftJars,
      })
      applySnapshot({ entries: res.entries, jars: res.jars })
      return true
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('spark.instance_load_failed'))
      return false
    } finally {
      setSaving(false)
    }
  }

  // "Apply and restart" acts on what the screen shows: it stores the draft, then asks the service
  // to apply. The confirmation names the latest in-flight count, so the status is re-read first.
  const startApply = async () => {
    setDialogError(null)
    setChecking(true)
    try {
      const res = await sparkInstanceConfigApi.get(databaseId)
      setStatus(res.status)
      setServerJars(res.serverJars)
      setConfirmStatus(res.status)
    } catch {
      setConfirmStatus(status)
    } finally {
      setChecking(false)
    }
    setConfirming(true)
  }

  const doApply = async () => {
    setConfirming(false)
    setApplying(true)
    setDialogError(null)
    try {
      if (!(await persistDraft())) return
      const res = await sparkInstanceConfigApi.apply(databaseId)
      setApplyState(res.state)
      setPollTimedOut(false)
      setPolling(true)
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('spark.instance_load_failed'))
      // The environment may have stayed as it was; read its real state instead of guessing.
      try {
        const res = await sparkInstanceConfigApi.get(databaseId)
        setStatus(res.status)
        setServerJars(res.serverJars)
      } catch {
        // Nothing more to show: the error sentence above stands.
      }
    } finally {
      setApplying(false)
    }
  }

  const addJarRow = () => {
    setJarRows((current) => [...current, EMPTY_JAR])
    setFocusJarIndex(jarRows.length)
  }

  const setJarField = (index: number, field: keyof JarRow, value: string) => {
    setJarRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  const removeJarRow = (index: number) => {
    setJarRows((current) => current.filter((_, i) => i !== index))
  }

  const tagClass = (tone: StatusTone) =>
    tone === 'green'
      ? 'bg-success-600'
      : tone === 'yellow'
        ? 'bg-warning-500'
        : tone === 'red'
          ? 'bg-danger-600'
          : 'bg-ink-400'

  const textClass = (tone: StatusTone) =>
    tone === 'green'
      ? 'text-success-600'
      : tone === 'yellow'
        ? 'text-warning-700'
        : tone === 'red'
          ? 'text-danger-600'
          : 'text-ink-500'

  const confirmInflight = confirmStatus?.inflight ?? null
  const confirmDesc =
    (confirmInflight !== null
      ? t('spark.instance_confirm_desc', { n: confirmInflight })
      : t('spark.instance_confirm_desc_unknown')) + (dirty ? t('spark.instance_confirm_unsaved') : '')

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('spark.instance_dialog_title')} className="max-w-2xl">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {/* Status line: a dot, the state in words and the effective summary */}
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-ink-200 bg-ink-50 px-3 py-2"
          aria-live="polite"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tagClass(line.tone)}`} aria-hidden="true" />
          <span className={`text-body-strong ${textClass(line.tone)}`}>{line.text}</span>
          {summary && <span className="ml-auto text-caption text-ink-500">{summary}</span>}
        </div>
        {line.note && (
          <p
            className={`-mt-1 text-caption break-words ${line.noteTone === 'danger' ? 'text-danger-600' : 'text-ink-500'}`}
          >
            {line.note}
          </p>
        )}
        {pollNote && <p className="-mt-1 text-caption text-warning-700">{pollNote}</p>}
        {loadError && <p className="-mt-1 text-caption break-words text-danger-600">{loadError}</p>}
        {dialogError && <p className="-mt-1 text-caption break-words text-danger-600">{dialogError}</p>}

        {/* Parameters: the shared row editor with the instance-config validator */}
        <div>
          <h3 className="label">{t('spark.instance_entries')}</h3>
          <KeyValueEditor
            rows={rows}
            onChange={setRows}
            validate={validateRow}
            placeholders={{ key: KEY_PLACEHOLDER, value: VALUE_PLACEHOLDER }}
          />
        </div>

        {/* Jars */}
        <div>
          <h3 className="label">{t('spark.instance_jars')}</h3>
          <div className="flex flex-col gap-2">
            {jarRows.map((row, i) => {
              const parsed = parseJarInput(row.value, row.sha256)
              const chip = row.value.trim() !== '' && parsed.ok ? jarServerState(parsed.ref, serverJars) : null
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: jar rows have no stable id; position is the identity while editing
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      ref={(el) => {
                        jarInputRefs.current[i] = el
                      }}
                      value={row.value}
                      onChange={(e) => setJarField(i, 'value', e.target.value)}
                      placeholder={t('spark.jar_placeholder')}
                      aria-label={t('spark.jar_input_label')}
                      className="input kv-input min-w-0 flex-1 font-mono"
                    />
                    {chip && chip !== 'unknown' && (
                      <span
                        className={`shrink-0 ${
                          chip === 'present' ? 'badge-green' : chip === 'missing' ? 'badge-yellow' : 'badge-neutral'
                        }`}
                      >
                        {chip === 'present'
                          ? t('spark.jar_state_present')
                          : chip === 'missing'
                            ? t('spark.jar_state_missing')
                            : t('spark.jar_state_download')}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeJarRow(i)}
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      className="shrink-0 rounded p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-(--duration-base)"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  {/* A sha256 pins a download, so only a URL row offers it */}
                  {isUrlRow(row) && (
                    <input
                      value={row.sha256}
                      onChange={(e) => setJarField(i, 'sha256', e.target.value)}
                      placeholder={t('spark.jar_sha256_placeholder')}
                      aria-label={t('spark.jar_sha256_label')}
                      className="input kv-input max-w-xs font-mono"
                    />
                  )}
                  {row.value.trim() !== '' && !parsed.ok && (
                    <p className="text-micro text-danger-600">{jarErrorText(t, parsed.code)}</p>
                  )}
                </div>
              )
            })}
            <button
              type="button"
              onClick={addJarRow}
              disabled={jarRows.length >= INSTANCE_JARS_MAX}
              className="btn-ghost btn-sm w-fit"
            >
              <Plus size={13} aria-hidden="true" />
              {t('spark.jar_add')}
            </button>
          </div>
        </div>
      </div>

      {/* Footer: both actions sit on the right; while the environment applies, both are disabled */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-200 px-4 py-3">
        <button type="button" onClick={() => void persistDraft()} disabled={busy} className="btn-secondary">
          {t('spark.save')}
        </button>
        <button type="button" onClick={() => void startApply()} disabled={busy} className="btn-primary">
          {t('spark.instance_apply')}
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title={t('spark.instance_confirm_title')}
          description={confirmDesc}
          confirmLabel={t('spark.instance_apply')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void doApply()}
        />
      )}
    </Dialog>
  )
}

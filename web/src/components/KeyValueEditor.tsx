import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../hooks/useLocale'
import type { ProfileEntry } from '../types'

interface Props {
  /** Ordered rows; the editor is controlled and never mutates them. */
  rows: ProfileEntry[]
  onChange: (rows: ProfileEntry[]) => void
  /** Injected validator (SPEC §7.5): a per-row error message, or null when the row is fine. */
  validate?: (row: ProfileEntry, all: ProfileEntry[]) => string | null
  /** Server-returned errors keyed by the offending `key` (SPEC §7.3 inline red). */
  serverErrors?: Record<string, string>
  /** Example text for the empty inputs. */
  placeholders?: { key?: string; value?: string }
  /** At most this many rows (SPEC §3: 50). */
  maxRows?: number
  /** Read-only (e.g. the built-in default profile). */
  disabled?: boolean
}

/**
 * The one key-value row editor, shared by the manage-config dialog (§7.3) and the instance-config
 * dialog (#56). Each line is `key = value` plus a row delete; "+ Add row" appends a blank line and
 * focuses its key input. The internal model is always an ordered `{ key, value }[]` — callers
 * convert to their own wire shape on save. Validation is injected, never hard-coded.
 */
export default function KeyValueEditor({
  rows,
  onChange,
  validate,
  serverErrors = {},
  placeholders,
  maxRows = 50,
  disabled = false,
}: Props) {
  const { t } = useLocale()
  const keyInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const [focusIndex, setFocusIndex] = useState<number | null>(null)

  // Focus the row just added, once it has mounted.
  useEffect(() => {
    if (focusIndex !== null) {
      keyInputRefs.current[focusIndex]?.focus()
      setFocusIndex(null)
    }
  }, [focusIndex])

  const addRow = () => {
    onChange([...rows, { key: '', value: '' }])
    setFocusIndex(rows.length)
  }

  const setField = (index: number, field: 'key' | 'value', value: string) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const trimmedKey = row.key.trim()
        const error = serverErrors[trimmedKey] ?? validate?.(row, rows) ?? null
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are key=value pairs with no stable id; position is the identity during editing
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                ref={(el) => {
                  keyInputRefs.current[i] = el
                }}
                value={row.key}
                onChange={(e) => setField(i, 'key', e.target.value)}
                placeholder={placeholders?.key}
                disabled={disabled}
                aria-label="key"
                className="input kv-input min-w-0 flex-1 font-mono"
              />
              <span className="shrink-0 text-ink-300 text-body-strong" aria-hidden="true">
                =
              </span>
              <input
                value={row.value}
                onChange={(e) => setField(i, 'value', e.target.value)}
                placeholder={placeholders?.value}
                disabled={disabled}
                aria-label="value"
                className="input kv-input min-w-0 flex-1 font-mono"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={disabled || rows.length <= 1}
                title={t('common.delete')}
                aria-label={t('common.delete')}
                className="shrink-0 rounded p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-(--duration-base)"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {error && <p className="text-micro text-danger-600">{error}</p>}
          </div>
        )
      })}
      <button
        type="button"
        onClick={addRow}
        disabled={disabled || rows.length >= maxRows}
        className="btn-ghost btn-sm w-fit"
      >
        <Plus size={13} aria-hidden="true" />
        {t('spark.add_row')}
      </button>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, FileText, Loader2, Play, RefreshCw, X } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import { livyApi } from '../lib/api'
import type { LivyBatch } from '../types'

interface Props {
  databaseId: string
}

const TERMINAL_STATES = new Set(['success', 'dead', 'killed', 'error', 'unknown'])

export default function LivyBatchesPanel({ databaseId }: Props) {
  const { t } = useLocale()

  // Form state
  const [jarSourceType, setJarSourceType] = useState<'url' | 'file'>('url')
  const [file, setFile] = useState('')
  const [className, setClassName] = useState('')
  const [args, setArgs] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // List state
  const [batches, setBatches] = useState<LivyBatch[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')

  // Log state
  const [activeBatchId, setActiveBatchId] = useState<string | number | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState('')

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadBatches = useCallback(
    async (silent = false) => {
      if (!databaseId) return
      if (!silent) setListLoading(true)
      setListError('')
      try {
        const res = await livyApi.listBatches(databaseId)
        if (mountedRef.current) {
          setBatches(res.results || [])
        }
      } catch (err) {
        if (mountedRef.current && !silent) {
          setListError(err instanceof Error ? err.message : t('errors.generic'))
        }
      } finally {
        if (mountedRef.current && !silent) {
          setListLoading(false)
        }
      }
    },
    [databaseId, t]
  )

  useEffect(() => {
    loadBatches()
  }, [loadBatches])

  // Auto-refresh until all batches reach terminal state
  useEffect(() => {
    const hasActive = batches.some((b) => !TERMINAL_STATES.has(b.state.toLowerCase()))
    if (!hasActive) return

    const interval = setInterval(() => {
      loadBatches(true)
    }, 3000)

    return () => clearInterval(interval)
  }, [batches, loadBatches])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedFile = file.trim()
    if (!trimmedFile || submitting) return

    setSubmitting(true)
    setSubmitError('')
    try {
      const trimmedClass = className.trim()
      const trimmedArgs = args.trim()
      const splitArgs = trimmedArgs ? trimmedArgs.split(/\s+/).filter(Boolean) : undefined

      await livyApi.submitBatch(databaseId, {
        file: trimmedFile,
        className: trimmedClass || undefined,
        args: splitArgs,
      })
      setFile('')
      setClassName('')
      setArgs('')
      await loadBatches(true)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  const loadDriverLog = async (batchId: string | number) => {
    setActiveBatchId(batchId)
    setLogLoading(true)
    setLogError('')
    try {
      const res = await livyApi.getBatchLog(databaseId, batchId, { size: 100 })
      let lines = res.log || []
      if (typeof res.total === 'number' && res.total > 100) {
        if (!mountedRef.current) return
        const tail = await livyApi.getBatchLog(databaseId, batchId, {
          from: Math.max(0, res.total - 100),
          size: 100,
        })
        lines = tail.log || []
      }
      if (mountedRef.current) {
        setLogLines(lines)
      }
    } catch (err) {
      if (mountedRef.current) {
        setLogError(err instanceof Error ? err.message : t('errors.generic'))
      }
    } finally {
      if (mountedRef.current) {
        setLogLoading(false)
      }
    }
  }

  return (
    <div className="flex flex-col h-[70vh] max-h-[750px] overflow-hidden">
      {/* Top half: submit form */}
      <div className="p-5 border-b border-ink-200 bg-ink-50 shrink-0">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            {/* Jar source and input */}
            <div className="sm:col-span-1 space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="batch-jar-input" className="label text-caption">
                  {t('livy.batch_jar_source')}
                </label>
                <div className="flex items-center gap-1 rounded border border-ink-200 bg-ink-100 p-0.5 text-micro">
                  <button
                    type="button"
                    onClick={() => setJarSourceType('url')}
                    className={`px-2 py-0.5 rounded ${
                      jarSourceType === 'url' ? 'bg-ink-0 text-ink-900 font-medium' : 'text-ink-500'
                    }`}
                  >
                    {t('livy.batch_jar_url')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setJarSourceType('file')}
                    className={`px-2 py-0.5 rounded ${
                      jarSourceType === 'file' ? 'bg-ink-0 text-ink-900 font-medium' : 'text-ink-500'
                    }`}
                  >
                    {t('livy.batch_jar_file')}
                  </button>
                </div>
              </div>
              <input
                id="batch-jar-input"
                type="text"
                value={file}
                onChange={(e) => setFile(e.target.value)}
                placeholder={
                  jarSourceType === 'url' ? t('livy.batch_file_placeholder_url') : t('livy.batch_file_placeholder_file')
                }
                required
                className="input font-mono text-caption"
              />
            </div>

            {/* Entrance class */}
            <div className="sm:col-span-1 space-y-1.5">
              <label htmlFor="batch-class-input" className="label text-caption">
                {t('livy.batch_class')}
              </label>
              <input
                id="batch-class-input"
                type="text"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                placeholder={t('livy.batch_class_placeholder')}
                className="input font-mono text-caption"
              />
            </div>

            {/* Args */}
            <div className="sm:col-span-1 space-y-1.5">
              <label htmlFor="batch-args-input" className="label text-caption">
                {t('livy.batch_args')}
              </label>
              <input
                id="batch-args-input"
                type="text"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={t('livy.batch_args_placeholder')}
                className="input font-mono text-caption"
              />
            </div>
          </div>

          {submitError && (
            <p role="alert" className="text-caption text-danger-600 flex items-center gap-1">
              <AlertCircle size={13} /> {submitError}
            </p>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={submitting || !file.trim()} className="btn-primary btn-sm gap-1.5">
              {submitting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              <span>{submitting ? t('livy.batch_submitting') : t('livy.batch_submit')}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Bottom half: batch list & logs */}
      <div className="flex-1 overflow-hidden flex flex-col p-5 bg-ink-0">
        <div className="flex items-center justify-between pb-3 shrink-0">
          <h3 className="text-body-strong text-ink-900">{t('livy.batch_list_title')}</h3>
          <button
            type="button"
            onClick={() => loadBatches()}
            disabled={listLoading}
            className="btn-ghost btn-sm gap-1 text-caption text-ink-500"
          >
            <RefreshCw size={12} className={listLoading ? 'animate-spin' : ''} />
            <span>{t('livy.refresh')}</span>
          </button>
        </div>

        {listError && (
          <div className="p-3 mb-3 rounded bg-danger-50 text-danger-700 text-caption flex items-center gap-2 shrink-0">
            <AlertCircle size={14} />
            <span>{listError}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto border border-ink-200 rounded-lg [scrollbar-width:thin]">
          {batches.length === 0 ? (
            <p className="text-caption text-ink-400 text-center py-8">
              {listLoading ? t('livy.loading') : t('livy.no_batches')}
            </p>
          ) : (
            <table className="w-full text-left border-collapse text-caption">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50 text-ink-500 sticky top-0">
                  <th className="py-2 px-3 font-medium">ID</th>
                  <th className="py-2 px-3 font-medium">File</th>
                  <th className="py-2 px-3 font-medium">Class</th>
                  <th className="py-2 px-3 font-medium">Created</th>
                  <th className="py-2 px-3 font-medium">State</th>
                  <th className="py-2 px-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {batches.map((batch) => {
                  const st = batch.state.toLowerCase()
                  const isRunning = !TERMINAL_STATES.has(st)
                  const isSuccess = st === 'success'
                  const isError = st === 'dead' || st === 'killed' || st === 'error'

                  return (
                    <tr key={batch.id} className="hover:bg-ink-50/60">
                      <td className="py-2 px-3 font-mono text-ink-600">#{batch.batch_id ?? batch.id}</td>
                      <td className="py-2 px-3 font-mono text-ink-900 truncate max-w-[200px]" title={batch.file}>
                        {batch.file}
                      </td>
                      <td
                        className="py-2 px-3 font-mono text-ink-600 truncate max-w-[150px]"
                        title={batch.class_name ?? '—'}
                      >
                        {batch.class_name || '—'}
                      </td>
                      <td className="py-2 px-3 text-ink-500 whitespace-nowrap">
                        {new Date(batch.created_at).toLocaleTimeString()}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span
                          className={`badge ${
                            isSuccess
                              ? 'badge-success'
                              : isError
                                ? 'badge-danger'
                                : isRunning
                                  ? 'badge-warning'
                                  : 'badge-brand'
                          }`}
                        >
                          {isRunning && <Loader2 size={10} className="animate-spin inline mr-1" />}
                          {batch.state}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => loadDriverLog(batch.batch_id ?? batch.id)}
                          className="btn-ghost btn-sm gap-1 text-caption text-brand-600 dark:text-brand-400"
                        >
                          <FileText size={12} />
                          <span>{t('livy.batch_logs')}</span>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Driver Log Viewer */}
        {activeBatchId !== null && (
          <div className="mt-3 border border-ink-200 rounded-lg bg-ink-950 text-ink-100 flex flex-col max-h-52 shrink-0">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-ink-800 text-caption">
              <span className="font-mono text-micro text-ink-400">
                {t('livy.batch_logs')} · #{activeBatchId}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadDriverLog(activeBatchId)}
                  disabled={logLoading}
                  className="text-ink-400 hover:text-ink-200 p-1"
                  title={t('livy.refresh')}
                >
                  <RefreshCw size={12} className={logLoading ? 'animate-spin' : ''} />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveBatchId(null)}
                  className="text-ink-400 hover:text-ink-200 p-1"
                  title={t('livy.close_logs')}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <div className="p-3 overflow-y-auto font-mono text-caption whitespace-pre-wrap [scrollbar-width:thin] flex-1">
              {logLoading ? (
                <div className="flex items-center gap-2 text-ink-400">
                  <Loader2 size={12} className="animate-spin" />
                  <span>{t('livy.loading')}</span>
                </div>
              ) : logError ? (
                <div className="text-danger-400">{logError}</div>
              ) : logLines.length > 0 ? (
                logLines.join('\n')
              ) : (
                <span className="text-ink-500">{t('livy.no_logs')}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

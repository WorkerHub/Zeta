import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Play, RefreshCw } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import { ApiError, livyApi } from '../lib/api'
import { forgetLivySession, readLivySession, rememberLivySession } from '../lib/livy-session'
import type { LivySession, LivySessionKind, LivyStatement } from '../types'

interface Props {
  databaseId: string
  userId: string
}

const KINDS: Array<{ kind: LivySessionKind; label: string }> = [
  { kind: 'spark', label: 'Scala (spark)' },
  { kind: 'pyspark', label: 'Python (pyspark)' },
  { kind: 'sql', label: 'SQL (sql)' },
]

export default function LivyConsolePanel({ databaseId, userId }: Props) {
  const { t } = useLocale()
  const [session, setSession] = useState<LivySession | null>(null)
  const [activeKind, setActiveKind] = useState<LivySessionKind>('spark')
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState('')
  const [code, setCode] = useState('')
  const [statements, setStatements] = useState<LivyStatement[]>([])
  const [executing, setExecuting] = useState(false)
  const mountedRef = useRef(true)
  const stmtPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const nextClientErrorIdRef = useRef(-1)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (stmtPollIntervalRef.current) {
        clearInterval(stmtPollIntervalRef.current)
        stmtPollIntervalRef.current = null
      }
    }
  }, [])

  // Initialize or probe session
  const initSession = useCallback(
    async (targetKind: LivySessionKind) => {
      if (!databaseId || !userId) return
      setSessionLoading(true)
      setSessionError('')

      const cached = readLivySession(userId, databaseId)
      if (cached) {
        try {
          const probed = await livyApi.getSession(databaseId, cached.sessionId)
          if (probed.state === 'dead' || probed.state === 'killed' || probed.state === 'error') {
            // Session expired on Livy side, recreate
            forgetLivySession(userId, databaseId)
          } else {
            if (mountedRef.current) {
              setSession(probed)
              setActiveKind(cached.kind)
              setSessionLoading(false)
            }
            return
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            forgetLivySession(userId, databaseId)
          } else {
            if (mountedRef.current) {
              setSessionError(err instanceof Error ? err.message : t('errors.generic'))
              setSessionLoading(false)
            }
            return
          }
        }
      }

      // Create fresh session
      try {
        const created = await livyApi.createSession(databaseId, targetKind)
        if (mountedRef.current) {
          setSession(created)
          setActiveKind(targetKind)
          rememberLivySession(userId, databaseId, { sessionId: created.id, kind: targetKind })
        }
      } catch (err) {
        if (mountedRef.current) {
          setSessionError(err instanceof Error ? err.message : t('errors.generic'))
        }
      } finally {
        if (mountedRef.current) {
          setSessionLoading(false)
        }
      }
    },
    [databaseId, userId, t]
  )

  useEffect(() => {
    const cached = readLivySession(userId, databaseId)
    initSession(cached?.kind ?? 'spark')
  }, [initSession, databaseId, userId])

  // Poll session state while it is starting
  useEffect(() => {
    if (!session || (session.state !== 'starting' && session.state !== 'not_started')) {
      return
    }
    const interval = setInterval(async () => {
      try {
        const updated = await livyApi.getSession(databaseId, session.id)
        if (mountedRef.current) {
          setSession(updated)
        }
      } catch {
        // Ignore polling error
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [databaseId, session])

  const handleSwitchKind = async (nextKind: LivySessionKind) => {
    if (nextKind === activeKind && session) return
    if (session) {
      try {
        await livyApi.deleteSession(databaseId, session.id)
      } catch {
        // Ignore session delete failure
      }
      forgetLivySession(userId, databaseId)
    }
    setActiveKind(nextKind)
    setSession(null)
    setStatements([])
    await initSession(nextKind)
  }

  const handleRebuild = async () => {
    if (session) {
      try {
        await livyApi.deleteSession(databaseId, session.id)
      } catch {
        // Ignore session delete failure
      }
      forgetLivySession(userId, databaseId)
    }
    setSession(null)
    setStatements([])
    await initSession(activeKind)
  }

  const executeStatement = async () => {
    const trimmed = code.trim()
    if (!trimmed || !session || executing) return

    setExecuting(true)
    try {
      const initial = await livyApi.runStatement(databaseId, session.id, trimmed, activeKind)
      setCode('')
      setStatements((prev) => [...prev, initial])

      // Poll until available or error
      if (initial.state !== 'available' && initial.state !== 'error') {
        const stmtId = initial.id
        if (stmtPollIntervalRef.current) {
          clearInterval(stmtPollIntervalRef.current)
          stmtPollIntervalRef.current = null
        }
        stmtPollIntervalRef.current = setInterval(async () => {
          try {
            const res = await livyApi.getStatement(databaseId, session.id, stmtId)
            if (res.state === 'available' || res.state === 'error') {
              if (stmtPollIntervalRef.current) {
                clearInterval(stmtPollIntervalRef.current)
                stmtPollIntervalRef.current = null
              }
              if (mountedRef.current) {
                setStatements((prev) => prev.map((s) => (s.id === stmtId ? res : s)))
                setExecuting(false)
              }
            } else if (mountedRef.current) {
              setStatements((prev) => prev.map((s) => (s.id === stmtId ? res : s)))
            }
          } catch {
            if (stmtPollIntervalRef.current) {
              clearInterval(stmtPollIntervalRef.current)
              stmtPollIntervalRef.current = null
            }
            if (mountedRef.current) setExecuting(false)
          }
        }, 1500)
      } else {
        setExecuting(false)
      }
    } catch (err) {
      if (stmtPollIntervalRef.current) {
        clearInterval(stmtPollIntervalRef.current)
        stmtPollIntervalRef.current = null
      }
      setExecuting(false)
      const errorOutput: LivyStatement = {
        id: nextClientErrorIdRef.current--,
        code: trimmed,
        state: 'error',
        output: {
          status: 'error',
          evalue: err instanceof Error ? err.message : t('errors.generic'),
        },
        progress: 0,
      }
      setStatements((prev) => [...prev, errorOutput])
    }
  }

  const isSessionReady =
    session &&
    session.state !== 'starting' &&
    session.state !== 'not_started' &&
    session.state !== 'dead' &&
    session.state !== 'killed' &&
    session.state !== 'error'

  return (
    <div className="flex flex-col h-[70vh] max-h-[750px] overflow-hidden">
      {/* Control bar: kind switcher, status, rebuild */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-ink-200 bg-ink-50 shrink-0">
        <div className="flex items-center gap-1 rounded-md border border-ink-200 bg-ink-100 p-0.5">
          {KINDS.map((k) => (
            <button
              type="button"
              key={k.kind}
              onClick={() => handleSwitchKind(k.kind)}
              disabled={sessionLoading}
              className={`px-3 py-1 text-caption rounded transition-colors duration-(--duration-base) ${
                activeKind === k.kind
                  ? 'bg-ink-0 text-ink-900 font-medium shadow-xs'
                  : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 text-caption">
          <div className="flex items-center gap-1.5">
            <span className="text-ink-500">{t('livy.session_status')}:</span>
            {sessionLoading ? (
              <span className="flex items-center gap-1 text-ink-600">
                <Loader2 size={12} className="animate-spin" />
                {t('livy.loading')}
              </span>
            ) : session ? (
              <span
                className={`badge ${
                  session.state === 'idle'
                    ? 'badge-success'
                    : session.state === 'busy' || session.state === 'starting'
                      ? 'badge-warning'
                      : 'badge-danger'
                }`}
              >
                {session.state}
                {session.appId ? ` · ${session.appId}` : ''}
              </span>
            ) : (
              <span className="text-ink-400">—</span>
            )}
          </div>

          <button
            type="button"
            onClick={handleRebuild}
            disabled={sessionLoading}
            className="btn-ghost btn-sm gap-1 text-caption"
            title={t('livy.rebuild_session')}
          >
            <RefreshCw size={12} className={sessionLoading ? 'animate-spin' : ''} />
            <span>{t('livy.rebuild_session')}</span>
          </button>
        </div>
      </div>

      {sessionError && (
        <div className="px-5 py-2 bg-danger-50 border-b border-danger-200 text-danger-700 text-caption flex items-center gap-2">
          <AlertCircle size={14} className="shrink-0" />
          <span>{sessionError}</span>
        </div>
      )}

      {/* Output stream */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-ink-0 [scrollbar-width:thin]">
        {statements.length === 0 ? (
          <p className="text-caption text-ink-400 text-center py-8">{t('livy.no_output')}</p>
        ) : (
          statements.map((stmt, idx) => {
            const isErr = stmt.state === 'error' || stmt.output?.status === 'error'
            const isRunning = stmt.state !== 'available' && stmt.state !== 'error'

            return (
              <div key={stmt.id ?? idx} className="rounded-lg border border-ink-200 bg-ink-50 p-3 space-y-2">
                <div className="flex items-center justify-between text-micro text-ink-400 border-b border-ink-200/60 pb-1.5">
                  <div className="flex items-center gap-1.5">
                    {isRunning ? (
                      <Loader2 size={12} className="animate-spin text-warning-600" />
                    ) : isErr ? (
                      <AlertCircle size={12} className="text-danger-600" />
                    ) : (
                      <CheckCircle2 size={12} className="text-success-600" />
                    )}
                    <span>#{idx + 1}</span>
                  </div>
                  <span className="font-mono uppercase">{stmt.state}</span>
                </div>

                {/* Code input verbatim */}
                <pre className="font-mono text-caption text-ink-800 whitespace-pre-wrap break-words">{stmt.code}</pre>

                {/* Output verbatim */}
                {isRunning ? (
                  <div className="flex items-center gap-2 text-caption text-ink-500 py-1">
                    <Loader2 size={13} className="animate-spin" />
                    <span>{t('livy.running')}</span>
                  </div>
                ) : isErr ? (
                  <div className="rounded bg-danger-50 border border-danger-200 p-2 text-danger-700 text-caption font-mono whitespace-pre-wrap break-words">
                    {stmt.output?.traceback && stmt.output.traceback.length > 0
                      ? stmt.output.traceback.join('\n')
                      : stmt.output?.evalue
                        ? `${stmt.output.ename ? `${stmt.output.ename}: ` : ''}${stmt.output.evalue}`
                        : 'Error executing statement'}
                  </div>
                ) : stmt.output?.data ? (
                  <div className="space-y-1">
                    {stmt.output.data['application/json'] !== undefined && (
                      <pre className="rounded bg-ink-100 p-2 text-ink-900 text-caption font-mono whitespace-pre-wrap break-words overflow-x-auto">
                        {typeof stmt.output.data['application/json'] === 'string'
                          ? stmt.output.data['application/json']
                          : JSON.stringify(stmt.output.data['application/json'], null, 2)}
                      </pre>
                    )}
                    {stmt.output.data['text/plain'] !== undefined && (
                      <pre className="rounded bg-ink-100 p-2 text-ink-900 text-caption font-mono whitespace-pre-wrap break-words overflow-x-auto">
                        {stmt.output.data['text/plain']}
                      </pre>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      {/* Input & Execute bar */}
      <div className="p-4 border-t border-ink-200 bg-ink-50 flex flex-col gap-2 shrink-0">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              executeStatement()
            }
          }}
          placeholder={t('livy.input_placeholder')}
          rows={3}
          disabled={sessionLoading || executing || !isSessionReady}
          className="input font-mono text-caption resize-none w-full"
        />
        <div className="flex items-center justify-between">
          <span className="text-micro text-ink-400">Cmd/Ctrl + Enter</span>
          <button
            type="button"
            onClick={executeStatement}
            disabled={sessionLoading || executing || !isSessionReady || !code.trim()}
            className="btn-primary btn-sm gap-1.5"
          >
            {executing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            <span>{executing ? t('livy.running') : t('livy.run')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

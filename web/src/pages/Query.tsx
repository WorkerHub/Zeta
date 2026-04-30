import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  Database, Play, Clock, ChevronDown, LogOut, Settings,
  User as UserIcon, History, AlertCircle, CheckCircle2, Loader2,
  Shield
} from 'lucide-react'
import { databasesApi, queryApi } from '../lib/api'
import { useAuthContext } from '../hooks/useAuth'
import ResultTable from '../components/ResultTable'
import QueryHistoryPanel from '../components/QueryHistoryPanel'
import type { Database as DbType } from '../types'

export default function QueryPage() {
  const { user, logout } = useAuthContext()
  const [databases, setDatabases] = useState<DbType[]>([])
  const [selectedDb, setSelectedDb] = useState<DbType | null>(null)
  const [sqlText, setSqlText] = useState('SELECT * FROM sqlite_master\nWHERE type = \'table\';')
  const [results, setResults] = useState<{ results: Record<string, unknown>[]; duration_ms?: number } | null>(null)
  const [queryError, setQueryError] = useState('')
  const [running, setRunning] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showDbMenu, setShowDbMenu] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const dbMenuRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    databasesApi.list().then((dbs) => {
      setDatabases(dbs)
      if (dbs.length > 0 && !selectedDb) setSelectedDb(dbs[0] ?? null)
    }).catch(() => {})
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dbMenuRef.current && !dbMenuRef.current.contains(e.target as Node)) setShowDbMenu(false)
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const runQuery = useCallback(async () => {
    if (!selectedDb || !sqlText.trim()) return
    setRunning(true)
    setQueryError('')
    setResults(null)
    try {
      const res = await queryApi.execute({ databaseId: selectedDb.id, sql: sqlText.trim() })
      if (res.error) {
        setQueryError(res.error)
      } else {
        setResults({ results: (res.results ?? []) as Record<string, unknown>[], duration_ms: res.duration_ms })
      }
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setRunning(false)
    }
  }, [selectedDb, sqlText])

  // Ctrl/Cmd+Enter to run
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        runQuery()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [runQuery])

  return (
    <div className="flex flex-col h-screen bg-zinc-950">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2 mr-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <Database size={15} className="text-white" />
          </div>
          <span className="font-semibold text-zinc-100 hidden sm:block">D1 Studio</span>
        </div>

        {/* Database selector */}
        <div className="relative" ref={dbMenuRef}>
          <button
            onClick={() => setShowDbMenu(!showDbMenu)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-200 transition-colors max-w-[200px]"
          >
            <Database size={13} className="text-zinc-400 shrink-0" />
            <span className="truncate">{selectedDb?.name ?? 'Select database'}</span>
            {selectedDb && (
              <span className={`badge ${selectedDb.permission === 'write' ? 'badge-blue' : 'badge-zinc'} ml-1 shrink-0`}>
                {selectedDb.permission}
              </span>
            )}
            <ChevronDown size={13} className="text-zinc-500 shrink-0 ml-0.5" />
          </button>
          {showDbMenu && (
            <div className="absolute left-0 top-full mt-1 w-64 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl z-20 overflow-hidden">
              {databases.length === 0 ? (
                <p className="px-4 py-3 text-sm text-zinc-500">No databases available</p>
              ) : databases.map((db) => (
                <button
                  key={db.id}
                  onClick={() => { setSelectedDb(db); setShowDbMenu(false) }}
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-800 transition-colors flex items-center justify-between ${selectedDb?.id === db.id ? 'text-blue-400' : 'text-zinc-200'}`}
                >
                  <span>{db.name}</span>
                  <span className={`badge ${db.permission === 'write' ? 'badge-blue' : 'badge-zinc'}`}>{db.permission}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* History toggle */}
        <button
          onClick={() => setShowHistory(!showHistory)}
          className={`btn-ghost btn-sm gap-1.5 ${showHistory ? 'text-blue-400 bg-blue-500/10' : ''}`}
        >
          <History size={15} />
          <span className="hidden sm:inline">History</span>
        </button>

        {/* User menu */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors text-xs font-semibold"
          >
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </button>
          {showUserMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl z-20 overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800">
                <p className="text-sm font-medium text-zinc-200 truncate">{user?.name}</p>
                <p className="text-xs text-zinc-500 truncate">{user?.email}</p>
              </div>
              <Link to="/profile" onClick={() => setShowUserMenu(false)}
                className="flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors">
                <UserIcon size={14} /> Profile & Security
              </Link>
              {user?.role === 'admin' && (
                <Link to="/admin" onClick={() => setShowUserMenu(false)}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors">
                  <Shield size={14} /> Admin Panel
                </Link>
              )}
              <button onClick={logout}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-zinc-800 transition-colors border-t border-zinc-800">
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main area */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* SQL Editor */}
          <div className="flex flex-col border-b border-zinc-800" style={{ height: '40%', minHeight: 180 }}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">SQL Editor</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 hidden sm:block">⌘+Enter to run</span>
                <button
                  onClick={runQuery}
                  disabled={running || !selectedDb}
                  className="btn-primary btn-sm gap-1.5"
                >
                  {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Run
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <CodeMirror
                value={sqlText}
                onChange={setSqlText}
                theme={oneDark}
                extensions={[sql()]}
                height="100%"
                style={{ height: '100%', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}
                basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: true }}
              />
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto">
            {running && (
              <div className="flex items-center justify-center h-full gap-2 text-zinc-500">
                <Loader2 size={18} className="animate-spin" />
                <span className="text-sm">Running query…</span>
              </div>
            )}
            {!running && queryError && (
              <div className="m-4 flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-400 mb-1">Query error</p>
                  <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono">{queryError}</pre>
                </div>
              </div>
            )}
            {!running && !queryError && results && (
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <CheckCircle2 size={13} className="text-emerald-400" />
                  <span>{results.results.length} row{results.results.length !== 1 ? 's' : ''}</span>
                  {results.duration_ms !== undefined && (
                    <>
                      <span>·</span>
                      <Clock size={12} />
                      <span>{results.duration_ms}ms</span>
                    </>
                  )}
                </div>
                <ResultTable rows={results.results} />
              </div>
            )}
            {!running && !queryError && !results && (
              <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
                Run a query to see results
              </div>
            )}
          </div>
        </div>

        {/* History sidebar */}
        {showHistory && selectedDb && (
          <div className="w-80 border-l border-zinc-800 overflow-auto shrink-0 hidden lg:block">
            <QueryHistoryPanel
              databaseId={selectedDb.id}
              onSelect={(s) => setSqlText(s)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

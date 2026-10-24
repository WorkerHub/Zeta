import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import {
  Play,
  ChevronDown,
  LogOut,
  User as UserIcon,
  History,
  AlertCircle,
  Loader2,
  Shield,
  Monitor,
  Sun,
  Moon,
  X,
  Globe,
  Plus,
  Info,
  Columns2,
  LayoutPanelTop,
} from 'lucide-react'
import { databasesApi, queryApi, ApiError } from '../lib/api'
import { useAuthContext } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useLocale } from '../hooks/useLocale'
import { useNotebooks } from '../hooks/useNotebooks'
import { useNotebookRuns } from '../hooks/useNotebookRuns'
import ResultsPanel from '../components/ResultsPanel'
import RunHistoryBar from '../components/RunHistoryBar'
import RunHistoryDrawer from '../components/RunHistoryDrawer'
import ConfirmDialog from '../components/ConfirmDialog'
import Logo from '../components/Logo'
import { splitSqlStatements } from '../lib/sql'
import type { Database as DbType, NotebookRunSummary, StatementResult } from '../types'

const THEME_ICONS = { auto: Monitor, light: Sun, dark: Moon }

export default function QueryPage() {
  const { user, logout } = useAuthContext()
  const { theme, cycleTheme } = useTheme()
  const { t, locale, changeLocale } = useLocale()
  const [databases, setDatabases] = useState<DbType[]>([])
  const {
    notebooks,
    activeId,
    setActiveId,
    createNotebook,
    deleteNotebook,
    renameNotebook,
    updateContent,
    updateDatabase,
    saveError,
    loadError: notebooksLoadError,
    loading: notebooksLoading,
    canCreate,
  } = useNotebooks()

  const activeNotebook = notebooks.find((n) => n.id === activeId) ?? null
  const sqlText = activeNotebook?.sql_content ?? ''
  const selectedDb = databases.find((d) => d.id === activeNotebook?.database_id) ?? null
  // Saved runs per notebook; what the results panel shows comes from here
  const runs = useNotebookRuns(activeId)
  const { running, runError, transient, selectedRun, selectedResults, startRun, finishRun } = runs
  const statementResults: StatementResult[] =
    transient ?? (selectedResults?.status === 'ready' ? selectedResults.results : [])
  const [activeResultIdx, setActiveResultIdx] = useState(0)
  // Failures outside a query run (loading databases, deleting a notebook, managing saved runs)
  const [pageError, setPageError] = useState('')
  const [showRunHistory, setShowRunHistory] = useState(false)
  const [showDbMenu, setShowDbMenu] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Notebook pending deletion — the design-system ConfirmDialog replaces window.confirm
  const [deletingNotebookId, setDeletingNotebookId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [selectedSql, setSelectedSql] = useState('')
  const selectedSqlRef = useRef('')
  const sqlHasMultiple = useMemo(() => splitSqlStatements(sqlText).length > 1, [sqlText])
  const dbMenuRef = useRef<HTMLDivElement>(null)
  const dbMenuDesktopRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  // The drawer returns focus here when it closes
  const historyBtnRef = useRef<HTMLButtonElement>(null)

  // Track dark mode for CodeMirror theme
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  // Layout: 'vertical' = top/bottom, 'horizontal' = left/right
  const [layout, setLayout] = useState<'vertical' | 'horizontal'>(() =>
    localStorage.getItem('query-layout') === 'horizontal' ? 'horizontal' : 'vertical'
  )

  // Draggable split
  const [editorPct, setEditorPct] = useState(40)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragStartCoord = useRef(0)
  const dragStartPct = useRef(0)

  const ThemeIcon = THEME_ICONS[theme]

  useEffect(() => {
    databasesApi
      .list()
      .then(setDatabases)
      .catch(() => setPageError(t('errors.load_databases_failed')))
  }, [t])

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const inDesktop = dbMenuDesktopRef.current?.contains(e.target as Node)
      const inMobile = dbMenuRef.current?.contains(e.target as Node)
      if (!inDesktop && !inMobile) setShowDbMenu(false)
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const runQuery = useCallback(async () => {
    const sqlToRun = selectedSqlRef.current.trim() || sqlText.trim()
    const nbId = activeId
    const db = selectedDb
    if (!db || !nbId || !sqlToRun) return

    const statements = splitSqlStatements(sqlToRun)
    if (statements.length === 0) return

    // The run belongs to the notebook it started in, even if the user switches tabs meanwhile
    startRun(nbId)
    setActiveResultIdx(0)

    // A saved run (one the server names and numbers) goes into the notebook's run list
    const summary = (
      saved: { run_id?: unknown; seq?: unknown; executed_at?: unknown },
      results: StatementResult[]
    ): NotebookRunSummary | null =>
      typeof saved.run_id === 'string' && typeof saved.seq === 'number'
        ? {
            id: saved.run_id,
            seq: saved.seq,
            notebook_id: nbId,
            database_id: db.id,
            database_name: db.name,
            sql: sqlToRun,
            statement_count: results.length,
            row_count: results.reduce((n, r) => n + (r.changes ?? r.results.length), 0),
            error_count: results.filter((r) => r.error).length,
            duration_ms: results.reduce((n, r) => n + r.duration_ms, 0),
            storage_truncated: 0,
            results_bytes: 0,
            executed_at: typeof saved.executed_at === 'number' ? saved.executed_at : Date.now(),
            accessible: true,
          }
        : null

    try {
      if (statements.length === 1) {
        // Single statement — use existing endpoint
        const stmt = statements[0]!
        try {
          const res = await queryApi.execute({ databaseId: db.id, sql: stmt, notebookId: nbId })
          const entry: StatementResult = {
            sql: stmt,
            results: res.results ?? [],
            duration_ms: res.duration_ms ?? 0,
            changes: res.meta?.changes,
            truncated: res.truncated,
          }
          finishRun(nbId, { run: summary(res, [entry]), results: [entry] })
        } catch (err) {
          const message = err instanceof Error ? err.message : t('errors.query_failed')
          const entry: StatementResult = { sql: stmt, results: [], duration_ms: 0, error: message }
          // A statement that ran and failed is saved too; the error response names the run
          finishRun(nbId, { run: summary(err instanceof ApiError ? err.body : {}, [entry]), results: [entry] })
        }
      } else {
        // Multiple statements — use batch endpoint
        const res = await queryApi.executeBatch({ databaseId: db.id, statements, notebookId: nbId })
        finishRun(nbId, { run: summary(res, res.results), results: res.results })
      }
    } catch (err) {
      finishRun(nbId, { error: err instanceof Error ? err.message : t('errors.query_failed') })
    }
  }, [activeId, selectedDb, sqlText, t, startRun, finishRun])

  // Cmd/Ctrl+Enter: override CodeMirror's default Mod-Enter (insertBlankLine)
  // so we can read the selection directly from view state before it gets cleared.
  const runQueryRef = useRef(runQuery)
  useEffect(() => {
    runQueryRef.current = runQuery
  }, [runQuery])

  const runShortcutExtension = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const sel = view.state.selection.main
              const selected = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to)
              selectedSqlRef.current = selected
              setSelectedSql(selected)
              runQueryRef.current()
              return true
            },
          },
        ])
      ),
    []
  )

  // Clear the editor selection when switching tabs (each notebook keeps its own results)
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId is the trigger, not an input of the effect
  useEffect(() => {
    setSelectedSql('')
    selectedSqlRef.current = ''
    // The run history drawer lists one notebook's runs, so it closes when another one opens
    setShowRunHistory(false)
  }, [activeId])

  // Show the first statement of whichever run comes into view
  const shownRunId = transient ? null : (selectedRun?.id ?? null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shown run is the trigger, not an input of the effect
  useEffect(() => {
    setActiveResultIdx(0)
  }, [activeId, shownRunId])

  // Saved-run actions report failures in the page error banner
  const reportRunAction = (action: Promise<void>) => {
    setPageError('')
    action.catch((err) => setPageError(err instanceof Error ? err.message : t('errors.runs_failed')))
  }

  // Draggable divider handlers
  function onDividerPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    dragging.current = true
    dragStartCoord.current = layout === 'vertical' ? e.clientY : e.clientX
    dragStartPct.current = editorPct
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onDividerPointerMove(e: React.PointerEvent) {
    if (!dragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const containerSize = layout === 'vertical' ? rect.height : rect.width
    const delta = (layout === 'vertical' ? e.clientY : e.clientX) - dragStartCoord.current
    const deltaPct = (delta / containerSize) * 100
    setEditorPct(Math.min(80, Math.max(20, dragStartPct.current + deltaPct)))
  }

  function onDividerPointerUp() {
    dragging.current = false
  }

  function changeLayout(next: 'vertical' | 'horizontal') {
    if (next === layout) return
    localStorage.setItem('query-layout', next)
    setEditorPct(40)
    setLayout(next)
  }

  if (notebooksLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-50 text-ink-500 text-body">
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-ink-50">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-ink-200 bg-ink-0 shrink-0">
        <div className="flex items-center gap-2 mr-2">
          <Logo size="sm" />
          <span className="text-body-strong text-ink-900 hidden sm:block">{t('app.name')}</span>
        </div>

        {/* Database selector — hidden on mobile (shown in bottom bar) */}
        <div className="relative hidden sm:block" ref={dbMenuDesktopRef}>
          <button
            type="button"
            onClick={() => setShowDbMenu(!showDbMenu)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ink-100 hover:bg-ink-200 border border-ink-200 text-body-strong text-ink-700 transition-colors duration-(--duration-base) max-w-[200px]"
          >
            <span className="truncate">{selectedDb?.name ?? t('query.select_db')}</span>
            <ChevronDown size={13} className="text-ink-400 shrink-0 ml-0.5" />
          </button>
          {showDbMenu && (
            <div className="absolute left-0 top-full mt-1 w-64 bg-ink-0 border border-ink-200 rounded-lg shadow-md z-(--z-dropdown) overflow-hidden animate-overlay-enter">
              {databases.length === 0 ? (
                <p className="px-4 py-3 text-body text-ink-500">{t('query.no_databases')}</p>
              ) : (
                databases.map((db) => (
                  <button
                    type="button"
                    key={db.id}
                    onClick={() => {
                      if (activeId) updateDatabase(activeId, db.id)
                      setShowDbMenu(false)
                    }}
                    className={`w-full text-left px-4 py-2.5 text-body hover:bg-ink-100 transition-colors duration-(--duration-base) ${
                      selectedDb?.id === db.id ? 'text-brand-600 dark:text-brand-400 font-medium' : 'text-ink-700'
                    }`}
                  >
                    {db.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* The only entry to the run history drawer (see below) */}
        <button
          ref={historyBtnRef}
          type="button"
          onClick={() => {
            // Focus first so the drawer can hand focus back here, in browsers that do not focus
            // buttons on click
            historyBtnRef.current?.focus()
            setShowRunHistory(true)
          }}
          aria-expanded={showRunHistory}
          aria-haspopup="dialog"
          aria-controls={showRunHistory ? 'run-history-panel' : undefined}
          aria-label={t('runs.open_history')}
          title={t('runs.history')}
          className={`btn-ghost btn-sm gap-1.5 ${showRunHistory ? 'text-brand-600 dark:text-brand-400 bg-brand-50' : ''}`}
        >
          <History size={15} />
          <span className="hidden sm:inline">{t('query.history')}</span>
        </button>

        {/* Language toggle */}
        <button
          type="button"
          onClick={() => changeLocale(locale === 'en' ? 'zh' : 'en')}
          className="btn-ghost btn-sm p-2"
          title={t('lang.label')}
        >
          <Globe size={15} />
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={cycleTheme}
          className="btn-ghost btn-sm p-2"
          title={`${t('theme.label')}: ${t(`theme.${theme}`)}`}
        >
          <ThemeIcon size={15} />
        </button>

        {/* User menu */}
        <div className="relative" ref={userMenuRef}>
          <button
            type="button"
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-8 h-8 rounded-full bg-ink-100 border border-ink-200 flex items-center justify-center text-ink-500 hover:text-ink-900 hover:bg-ink-200 transition-colors duration-(--duration-base) text-caption font-semibold"
          >
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </button>
          {showUserMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-ink-0 border border-ink-200 rounded-lg shadow-md z-(--z-dropdown) overflow-hidden animate-overlay-enter">
              <div className="px-4 py-3 border-b border-ink-200">
                <p className="text-body-strong text-ink-900 truncate">{user?.name}</p>
                <p className="text-caption text-ink-500 truncate">{user?.email}</p>
              </div>
              <Link
                to="/profile"
                onClick={() => setShowUserMenu(false)}
                className="flex items-center gap-2 px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 hover:text-ink-950 transition-colors duration-(--duration-base)"
              >
                <UserIcon size={14} /> {t('user.profile_security')}
              </Link>
              {user?.role === 'admin' && (
                <Link
                  to="/admin"
                  onClick={() => setShowUserMenu(false)}
                  className="flex items-center gap-2 px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 hover:text-ink-950 transition-colors duration-(--duration-base)"
                >
                  <Shield size={14} /> {t('user.admin_panel')}
                </Link>
              )}
              <Link
                to="/about"
                onClick={() => setShowUserMenu(false)}
                className="flex items-center gap-2 px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 hover:text-ink-950 transition-colors duration-(--duration-base)"
              >
                <Info size={14} /> {t('user.about')}
              </Link>
              <button
                type="button"
                onClick={logout}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-body text-danger-600 hover:bg-ink-100 transition-colors duration-(--duration-base) border-t border-ink-200"
              >
                <LogOut size={14} /> {t('user.sign_out')}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Notebook tab bar */}
      <div
        id="notebook-tabs"
        role="tablist"
        className="flex items-center border-b border-ink-200 bg-ink-0 shrink-0 overflow-x-auto min-h-[36px] [scrollbar-width:thin]"
      >
        {notebooks.map((nb) => (
          <div
            key={nb.id}
            role="tab"
            tabIndex={0}
            aria-selected={nb.id === activeId}
            className={`group flex items-center gap-1 px-3 py-1.5 text-body border-r border-ink-200 cursor-pointer shrink-0 select-none transition-colors duration-(--duration-base) ${
              nb.id === activeId
                ? 'text-brand-700 dark:text-brand-400 bg-ink-50 font-medium border-b-2 border-b-brand-500'
                : 'text-ink-500 hover:text-ink-900 hover:bg-ink-50'
            }`}
            onClick={() => setActiveId(nb.id)}
            onKeyDown={(e) => {
              // Ignore keys typed into the rename input or aimed at the delete button
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveId(nb.id)
              } else if (e.key === 'F2') {
                e.preventDefault()
                setRenamingId(nb.id)
                setRenameValue(nb.name)
              }
            }}
          >
            {renamingId === nb.id ? (
              <input
                // biome-ignore lint/a11y/noAutofocus: the rename input appears on demand and must take focus to be usable
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => {
                  renameNotebook(nb.id, renameValue)
                  setRenamingId(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    renameNotebook(nb.id, renameValue)
                    setRenamingId(null)
                  }
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
                className="bg-transparent outline-none border-b border-brand-500 w-24 text-body"
              />
            ) : (
              // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename is a mouse shortcut; keyboard users press F2 on the focused tab
              <span
                className="max-w-[120px] truncate"
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setRenamingId(nb.id)
                  setRenameValue(nb.name)
                }}
              >
                {nb.name}
              </span>
            )}
            {notebooks.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setDeletingNotebookId(nb.id)
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-ink-200 text-ink-400 hover:text-ink-700 transition-opacity duration-(--duration-base)"
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={createNotebook}
          disabled={!canCreate}
          title={canCreate ? t('notebook.new') : t('notebook.limit_reached')}
          className="shrink-0 px-2.5 py-1.5 text-ink-400 hover:text-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-(--duration-base)"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Main content */}
      <div
        ref={containerRef}
        className="flex flex-1 overflow-hidden clear-mobile-bar sm:pb-0"
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
      >
        {/* Editor + Results */}
        <div className={`flex ${layout === 'horizontal' ? 'flex-row' : 'flex-col'} flex-1 overflow-hidden`}>
          {/* SQL Editor */}
          <div
            className={`flex flex-col ${layout === 'horizontal' ? 'border-r' : 'border-b'} border-ink-200`}
            style={
              layout === 'horizontal'
                ? { width: `${editorPct}%`, minWidth: 200 }
                : { height: `${editorPct}%`, minHeight: 120 }
            }
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-ink-200 shrink-0">
              <span className="text-micro uppercase text-ink-500">{t('query.sql_editor')}</span>
              <div className="flex items-center gap-2">
                {/* Layout toggle buttons */}
                <div className="hidden sm:flex items-center gap-0.5 rounded-md border border-ink-200 p-0.5">
                  <button
                    type="button"
                    onClick={() => changeLayout('vertical')}
                    className={`p-1 rounded transition-colors duration-(--duration-base) ${layout === 'vertical' ? 'bg-ink-200 text-ink-900' : 'text-ink-400 hover:text-ink-700'}`}
                    title={t('query.layout_vertical')}
                  >
                    <LayoutPanelTop size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => changeLayout('horizontal')}
                    className={`p-1 rounded transition-colors duration-(--duration-base) ${layout === 'horizontal' ? 'bg-ink-200 text-ink-900' : 'text-ink-400 hover:text-ink-700'}`}
                    title={t('query.layout_horizontal')}
                  >
                    <Columns2 size={13} />
                  </button>
                </div>
                {saveError && (
                  <span className="text-caption text-warning-600" title={t('query.autosave_failed_desc')}>
                    {t('query.autosave_failed')}
                  </span>
                )}
                <span className="text-caption text-ink-400 hidden sm:block tnum">{t('query.shortcut')}</span>
                <button
                  type="button"
                  onClick={runQuery}
                  disabled={running || !selectedDb}
                  className="btn-primary btn-sm gap-1.5 hidden sm:flex"
                >
                  {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  {selectedSql.trim() ? t('query.run_selection') : sqlHasMultiple ? t('query.run_all') : t('query.run')}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <CodeMirror
                value={sqlText}
                onChange={(val) => {
                  if (activeId) updateContent(activeId, val)
                }}
                onUpdate={(update) => {
                  const sel = update.state.selection.main
                  const selected = sel.empty ? '' : update.state.sliceDoc(sel.from, sel.to)
                  selectedSqlRef.current = selected
                  setSelectedSql(selected)
                }}
                theme={isDark ? oneDark : 'light'}
                extensions={[sql(), runShortcutExtension]}
                height="100%"
                style={{ height: '100%', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}
                basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: true }}
              />
            </div>
          </div>

          {/* Draggable divider */}
          <div
            className={`${layout === 'horizontal' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} bg-ink-200 hover:bg-brand-400 transition-colors duration-(--duration-base) shrink-0 touch-none`}
            onPointerDown={onDividerPointerDown}
          />

          {/* Results */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {(pageError || notebooksLoadError) && (
              <div className="mx-4 mt-4 flex items-start gap-2 p-3 bg-danger-50 border border-danger-200 rounded-lg shrink-0">
                <AlertCircle size={16} className="text-danger-600 shrink-0 mt-0.5" />
                <p className="flex-1 text-body text-danger-600">{pageError || t('errors.load_notebooks_failed')}</p>
                {pageError && (
                  <button
                    type="button"
                    onClick={() => setPageError('')}
                    className="p-0.5 rounded text-danger-600 hover:bg-danger-100 transition-colors duration-(--duration-base)"
                    title={t('common.dismiss')}
                    aria-label={t('common.dismiss')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
            {running && (
              <div className="flex items-center justify-center h-full gap-2 text-ink-500">
                <Loader2 size={18} className="animate-spin" />
                <span className="text-body">{t('query.running')}</span>
              </div>
            )}
            {!running && runError && (
              <div className="m-4 flex items-start gap-3 p-4 bg-danger-50 border border-danger-200 rounded-lg">
                <AlertCircle size={18} className="text-danger-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-body-strong text-danger-600 mb-1">{t('query.error')}</p>
                  <pre className="text-caption text-danger-700 whitespace-pre-wrap font-mono">{runError}</pre>
                </div>
              </div>
            )}
            {!running && !runError && !transient && selectedRun && (
              <RunHistoryBar
                runs={runs.list}
                selected={selectedRun}
                hasMore={runs.hasMore}
                loading={runs.loading}
                loadError={runs.loadError}
                onSelect={runs.selectRun}
                onLoadMore={runs.loadMore}
                onDelete={(runId) => reportRunAction(runs.deleteRun(runId))}
              />
            )}
            {!running && !runError && statementResults.length > 0 && (
              <div className="flex-1 overflow-hidden">
                <ResultsPanel
                  results={statementResults}
                  activeIndex={activeResultIdx}
                  onSelectIndex={setActiveResultIdx}
                />
              </div>
            )}
            {!running && !runError && !transient && selectedResults && selectedResults.status !== 'ready' && (
              <div className="flex items-center justify-center flex-1 gap-2 px-4 text-center text-body text-ink-400">
                {selectedResults.status === 'loading' && <Loader2 size={16} className="animate-spin" />}
                {selectedResults.status === 'loading'
                  ? t('runs.loading')
                  : selectedResults.status === 'denied'
                    ? t('runs.access_denied')
                    : t('runs.load_failed')}
              </div>
            )}
            {!running && !runError && !transient && !selectedRun && (
              <div className="flex items-center justify-center h-full text-ink-400 text-body">
                {runs.loading ? t('common.loading') : runs.loadError ? t('runs.list_failed') : t('query.no_results')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile bottom bar */}
      <div className="sm:hidden fixed bottom-0 left-0 right-0 z-(--z-sticky-bar) safe-b flex items-center gap-2 px-3 py-2 bg-ink-0 border-t border-ink-200">
        {/* DB selector */}
        <div className="relative flex-1" ref={dbMenuRef}>
          <button
            type="button"
            onClick={() => {
              setShowDbMenu(!showDbMenu)
            }}
            className="w-full flex items-center gap-1.5 px-3 py-2 rounded-md bg-ink-100 border border-ink-200 text-body-strong text-ink-700 transition-colors duration-(--duration-base)"
          >
            <span className="truncate flex-1 text-left">{selectedDb?.name ?? t('query.select_db')}</span>
            <ChevronDown size={13} className="text-ink-400 shrink-0" />
          </button>
          {showDbMenu && (
            <div className="absolute left-0 bottom-full mb-1 w-56 bg-ink-0 border border-ink-200 rounded-lg shadow-md z-(--z-dropdown) overflow-hidden animate-overlay-enter">
              {databases.map((db) => (
                <button
                  type="button"
                  key={db.id}
                  onClick={() => {
                    if (activeId) updateDatabase(activeId, db.id)
                    setShowDbMenu(false)
                  }}
                  className={`w-full text-left px-4 py-2.5 text-body hover:bg-ink-100 transition-colors duration-(--duration-base) ${selectedDb?.id === db.id ? 'text-brand-600 dark:text-brand-400 font-medium' : 'text-ink-700'}`}
                >
                  {db.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Run button */}
        <button
          type="button"
          onClick={runQuery}
          disabled={running || !selectedDb}
          className="btn-primary gap-1.5 px-4 py-2"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {selectedSql.trim() ? t('query.run_selection') : t('query.run')}
        </button>
      </div>

      {/* Notebook deletion confirmation (design-system dialog, §3.1 micro_interaction) */}
      {deletingNotebookId && (
        <ConfirmDialog
          title={t('notebook.delete_confirm')}
          description={t('notebook.delete_confirm_desc')}
          confirmLabel={t('common.delete')}
          onCancel={() => setDeletingNotebookId(null)}
          onConfirm={() => {
            const nbId = deletingNotebookId
            setDeletingNotebookId(null)
            setPageError('')
            deleteNotebook(nbId)
              .then(() => runs.forgetNotebook(nbId))
              .catch((err) => setPageError(err instanceof Error ? err.message : t('errors.delete_notebook_failed')))
          }}
        />
      )}

      {/* Run history drawer — every saved run of the current notebook */}
      {showRunHistory && (
        <RunHistoryDrawer
          runs={runs.list}
          selectedRun={selectedRun}
          selectedResults={selectedResults}
          hasMore={runs.hasMore}
          loading={runs.loading}
          loadError={runs.loadError}
          onSelect={runs.selectRun}
          onLoadMore={runs.loadMore}
          onDelete={runs.deleteRun}
          onClear={runs.clearRuns}
          onClose={() => setShowRunHistory(false)}
        />
      )}
    </div>
  )
}

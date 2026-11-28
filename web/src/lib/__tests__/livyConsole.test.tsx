// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LivyConsolePanel from '../../components/LivyConsolePanel'
import { ApiError, livyApi } from '../api'
import { readLivySession, rememberLivySession } from '../livy-session'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    livyApi: {
      getSession: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      runStatement: vi.fn(),
      getStatement: vi.fn(),
    },
  }
})

describe('LivyConsolePanel', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('creates a new session when none is cached', async () => {
    vi.mocked(livyApi.createSession).mockResolvedValue({
      id: 101,
      state: 'idle',
      kind: 'spark',
      appId: 'app-101',
    })

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(livyApi.createSession).toHaveBeenCalledWith('db-1', 'spark')
    })

    expect(readLivySession('user-1', 'db-1')).toEqual({ sessionId: 101, kind: 'spark' })
    expect(await screen.findByText(/app-101/)).toBeDefined()
  })

  it('probes cached session and keeps it if alive', async () => {
    rememberLivySession('user-1', 'db-1', { sessionId: 202, kind: 'pyspark' })

    vi.mocked(livyApi.getSession).mockResolvedValue({
      id: 202,
      state: 'idle',
      kind: 'pyspark',
      appId: 'app-202',
    })

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(livyApi.getSession).toHaveBeenCalledWith('db-1', 202)
    })
    expect(livyApi.createSession).not.toHaveBeenCalled()
    expect(await screen.findByText(/app-202/)).toBeDefined()
  })

  it('recreates session when probed cached session is 404 or dead', async () => {
    rememberLivySession('user-1', 'db-1', { sessionId: 303, kind: 'sql' })

    vi.mocked(livyApi.getSession).mockRejectedValue(new ApiError('Session not found', 404))
    vi.mocked(livyApi.createSession).mockResolvedValue({
      id: 404,
      state: 'idle',
      kind: 'sql',
      appId: 'app-404',
    })

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(livyApi.getSession).toHaveBeenCalledWith('db-1', 303)
      expect(livyApi.createSession).toHaveBeenCalledWith('db-1', 'sql')
    })

    expect(readLivySession('user-1', 'db-1')).toEqual({ sessionId: 404, kind: 'sql' })
  })

  it('retains cached session and surfaces error when probe fails with non-404 (e.g. 500 or network error)', async () => {
    rememberLivySession('user-1', 'db-1', { sessionId: 303, kind: 'sql' })

    vi.mocked(livyApi.getSession).mockRejectedValue(new ApiError('Backend unavailable', 500))

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(livyApi.getSession).toHaveBeenCalledWith('db-1', 303)
    })

    expect(livyApi.createSession).not.toHaveBeenCalled()
    expect(readLivySession('user-1', 'db-1')).toEqual({ sessionId: 303, kind: 'sql' })
    expect(await screen.findByText('Backend unavailable')).toBeDefined()
  })

  it('switches kind and creates new session immediately', async () => {
    vi.mocked(livyApi.createSession)
      .mockResolvedValueOnce({
        id: 501,
        state: 'idle',
        kind: 'spark',
        appId: 'app-501',
      })
      .mockResolvedValueOnce({
        id: 502,
        state: 'idle',
        kind: 'pyspark',
        appId: 'app-502',
      })
    vi.mocked(livyApi.deleteSession).mockResolvedValue({ message: 'Deleted' })

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(livyApi.createSession).toHaveBeenCalledWith('db-1', 'spark')
    })

    const pythonBtn = screen.getByRole('button', { name: /Python \(pyspark\)/i })
    fireEvent.click(pythonBtn)

    await waitFor(() => {
      expect(livyApi.deleteSession).toHaveBeenCalledWith('db-1', 501)
      expect(livyApi.createSession).toHaveBeenCalledWith('db-1', 'pyspark')
    })

    expect(readLivySession('user-1', 'db-1')).toEqual({ sessionId: 502, kind: 'pyspark' })
  })

  it('submits code and displays output without custom renderers', async () => {
    vi.mocked(livyApi.createSession).mockResolvedValue({
      id: 601,
      state: 'idle',
      kind: 'spark',
      appId: 'app-601',
    })
    vi.mocked(livyApi.runStatement).mockResolvedValue({
      id: 1,
      code: 'val x = 42',
      state: 'available',
      output: {
        status: 'ok',
        data: {
          'text/plain': 'x: Int = 42\n',
        },
      },
      progress: 1,
    })

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Enter code to execute/i)).toBeDefined()
    })

    const textarea = screen.getByPlaceholderText(/Enter code to execute/i)
    fireEvent.change(textarea, { target: { value: 'val x = 42' } })

    const executeBtn = screen.getByRole('button', { name: /Execute/i })
    fireEvent.click(executeBtn)

    await waitFor(() => {
      expect(livyApi.runStatement).toHaveBeenCalledWith('db-1', 601, 'val x = 42', 'spark')
    })

    expect(await screen.findByText('x: Int = 42')).toBeDefined()
  })

  it('renders statement error and traceback cleanly', async () => {
    vi.mocked(livyApi.createSession).mockResolvedValue({
      id: 701,
      state: 'idle',
      kind: 'spark',
      appId: 'app-701',
    })
    vi.mocked(livyApi.runStatement).mockResolvedValue({
      id: 1,
      code: '1 / 0',
      state: 'error',
      output: {
        status: 'error',
        ename: 'ArithmeticException',
        evalue: '/ by zero',
        traceback: ['java.lang.ArithmeticException: / by zero', '\tat line 1'],
      },
      progress: 1,
    })

    render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Enter code to execute/i)).toBeDefined()
    })

    const textarea = screen.getByPlaceholderText(/Enter code to execute/i)
    fireEvent.change(textarea, { target: { value: '1 / 0' } })

    const executeBtn = screen.getByRole('button', { name: /Execute/i })
    fireEvent.click(executeBtn)

    expect(await screen.findByText(/java.lang.ArithmeticException: \/ by zero/)).toBeDefined()
  })

  it('handles client submission error and clears interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    vi.mocked(livyApi.createSession).mockResolvedValue({
      id: 801,
      state: 'idle',
      kind: 'spark',
      appId: 'app-801',
    })
    vi.mocked(livyApi.runStatement).mockRejectedValue(new Error('Network drop'))

    const { unmount } = render(<LivyConsolePanel databaseId="db-1" userId="user-1" />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Enter code to execute/i)).toBeDefined()
    })

    const textarea = screen.getByPlaceholderText(/Enter code to execute/i)
    fireEvent.change(textarea, { target: { value: 'println("test")' } })
    const executeBtn = screen.getByRole('button', { name: /Execute/i })
    fireEvent.click(executeBtn)

    expect(await screen.findByText('Network drop')).toBeDefined()

    unmount()
    expect(clearIntervalSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })
})

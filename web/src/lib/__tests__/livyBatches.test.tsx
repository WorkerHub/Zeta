// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LivyBatchesPanel from '../../components/LivyBatchesPanel'
import { livyApi } from '../api'

vi.mock('../api', () => ({
  livyApi: {
    listBatches: vi.fn(),
    submitBatch: vi.fn(),
    getBatchLog: vi.fn(),
  },
}))

describe('LivyBatchesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders submit form and lists batches', async () => {
    vi.mocked(livyApi.listBatches).mockResolvedValue({
      results: [
        {
          id: '1',
          batch_id: 1,
          file: 'https://example.com/app.jar',
          class_name: 'org.example.Main',
          created_at: 1700000000000,
          state: 'success',
          appId: 'app-batch-1',
        },
      ],
    })

    render(<LivyBatchesPanel databaseId="db-1" />)

    await waitFor(() => {
      expect(livyApi.listBatches).toHaveBeenCalledWith('db-1')
    })

    expect(screen.getByText('https://example.com/app.jar')).toBeDefined()
    expect(screen.getByText('org.example.Main')).toBeDefined()
    expect(screen.getByText('success')).toBeDefined()
  })

  it('submits a batch with jar URL, class name, and space-split args', async () => {
    vi.mocked(livyApi.listBatches).mockResolvedValue({ results: [] })
    vi.mocked(livyApi.submitBatch).mockResolvedValue({
      id: '2',
      batch_id: 2,
      file: 'https://example.com/job.jar',
      class_name: 'org.example.Job',
      created_at: 1700000001000,
      state: 'starting',
      appId: null,
    })

    render(<LivyBatchesPanel databaseId="db-1" />)

    const fileInput = screen.getByLabelText(/Jar Source/i)
    const classInput = screen.getByLabelText(/Main Class/i)
    const argsInput = screen.getByLabelText(/Arguments/i)

    fireEvent.change(fileInput, { target: { value: 'https://example.com/job.jar' } })
    fireEvent.change(classInput, { target: { value: 'org.example.Job' } })
    fireEvent.change(argsInput, { target: { value: 'arg1  arg2' } })

    const submitBtn = screen.getByRole('button', { name: /Submit Batch/i })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(livyApi.submitBatch).toHaveBeenCalledWith('db-1', {
        file: 'https://example.com/job.jar',
        className: 'org.example.Job',
        args: ['arg1', 'arg2'],
      })
    })
  })

  it('submits a batch with filename only when file toggle is selected', async () => {
    vi.mocked(livyApi.listBatches).mockResolvedValue({ results: [] })
    vi.mocked(livyApi.submitBatch).mockResolvedValue({
      id: '3',
      batch_id: 3,
      file: 'local-app.jar',
      class_name: null,
      created_at: 1700000002000,
      state: 'starting',
      appId: null,
    })

    render(<LivyBatchesPanel databaseId="db-1" />)

    const fileToggle = screen.getByRole('button', { name: /File Name/i })
    fireEvent.click(fileToggle)

    const fileInput = screen.getByPlaceholderText(/app.jar \(filename only\)/i)
    fireEvent.change(fileInput, { target: { value: 'local-app.jar' } })

    const submitBtn = screen.getByRole('button', { name: /Submit Batch/i })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(livyApi.submitBatch).toHaveBeenCalledWith('db-1', {
        file: 'local-app.jar',
        className: undefined,
        args: undefined,
      })
    })
  })

  it('fetches and views driver log on demand', async () => {
    vi.mocked(livyApi.listBatches).mockResolvedValue({
      results: [
        {
          id: '10',
          batch_id: 10,
          file: 'task.jar',
          class_name: null,
          created_at: 1700000003000,
          state: 'running',
          appId: 'app-10',
        },
      ],
    })
    vi.mocked(livyApi.getBatchLog).mockResolvedValue({
      id: 10,
      from: 0,
      size: 2,
      total: 2,
      log: ['Driver log line 1', 'Driver log line 2'],
    })

    render(<LivyBatchesPanel databaseId="db-1" />)

    await waitFor(() => {
      expect(screen.getByText('task.jar')).toBeDefined()
    })

    const logBtn = screen.getByRole('button', { name: /Driver Log/i })
    fireEvent.click(logBtn)

    await waitFor(() => {
      expect(livyApi.getBatchLog).toHaveBeenCalledWith('db-1', 10, { size: 100 })
    })

    expect(await screen.findByText(/Driver log line 1/)).toBeDefined()
    expect(await screen.findByText(/Driver log line 2/)).toBeDefined()

    const closeBtn = screen.getByTitle(/Close Log/i)
    fireEvent.click(closeBtn)

    expect(screen.queryByText(/Driver log line 1/)).toBeNull()
  })
})

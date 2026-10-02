import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AiCore from '@cherrystudio/ai-core'

import { makeModel, makeProvider } from '../../__tests__/fixtures'
import type { CompressionModelDescriptor } from '../resolveCompressionModel'
import { summarizeCompaction } from '../summarizeCompaction'

const { mockSummarizeHistory, mockRunPiOneShotText } = vi.hoisted(() => ({
  mockSummarizeHistory: vi.fn(),
  mockRunPiOneShotText: vi.fn()
}))

// Real `fromModelMessages` rides along; only the shaping pipeline's LLM seam
// and the pi one-shot are mocked (each at its own module boundary).
vi.mock('@cherrystudio/ai-core', async (importOriginal) => ({
  ...(await importOriginal<typeof AiCore>()),
  summarizeHistory: mockSummarizeHistory
}))

vi.mock('../../runtime/pi/piOneShot', () => ({
  runPiOneShotText: (...args: unknown[]) => mockRunPiOneShotText(...args)
}))

const COMPRESSION_MODEL: CompressionModelDescriptor = {
  provider: makeProvider({ id: 'compressor' }),
  model: makeModel({ id: 'compressor::small', providerId: 'compressor' }),
  contextWindow: 8_000,
  conversationId: 'topic-1'
}

/** Drive the mocked pipeline by invoking the compress callback it was handed. */
function capturePipeline() {
  let captured: { messages: unknown[]; opts: unknown; compress: (messages: never[]) => Promise<string> } | undefined
  mockSummarizeHistory.mockImplementation(async (messages, compress, opts) => {
    captured = { messages, opts, compress }
    return compress(messages)
  })
  return () => captured
}

describe('summarizeCompaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunPiOneShotText.mockResolvedValue({ text: 'RAW SUMMARY' })
  })

  it('drops system rows, threads budgets into the pipeline, and returns its summary', async () => {
    const getCaptured = capturePipeline()
    const summary = await summarizeCompaction(
      [
        { role: 'system', content: 'standing instructions' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
      ] as never,
      COMPRESSION_MODEL,
      { maxOutputTokens: 1_000, maxInputTokens: 4_000 }
    )

    expect(summary).toBe('RAW SUMMARY')
    const captured = getCaptured()!
    expect(captured.messages.map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant'])
    expect(captured.opts).toEqual({ maxInputTokens: 4_000 })
  })

  it('issues the LLM call on the pi one-shot lane with the compression descriptor', async () => {
    capturePipeline()
    await summarizeCompaction([{ role: 'user', content: 'hello' }] as never, COMPRESSION_MODEL, {
      maxOutputTokens: 1_000
    })

    expect(mockRunPiOneShotText).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: COMPRESSION_MODEL.provider,
        model: COMPRESSION_MODEL.model,
        sessionId: 'topic-1',
        requestOptions: { maxTokens: 1_000 }
      })
    )
  })

  it('folds tool interactions into described text, mirroring the legacy compression adapter', async () => {
    capturePipeline()
    await summarizeCompaction(
      [
        { role: 'user', content: 'find cherries' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'cherry' } }]
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { type: 'text', value: 'hits' } }
          ]
        },
        { role: 'user', content: 'wrap up' }
      ] as never,
      COMPRESSION_MODEL
    )

    const messages = mockRunPiOneShotText.mock.calls[0][0].messages
    expect(messages).toEqual([
      { role: 'user', content: 'find cherries' },
      {
        role: 'assistant',
        content: '[Called tool: search({"q":"cherry"})]'
      },
      { role: 'user', content: '[Tool result (c1): hits]' },
      { role: 'user', content: 'wrap up' }
    ])
  })

  it('returns the model output verbatim, an empty summary included', async () => {
    capturePipeline()
    mockRunPiOneShotText.mockResolvedValue({ text: '' })
    expect(await summarizeCompaction([{ role: 'user', content: 'hello' }] as never, COMPRESSION_MODEL)).toBe('')
  })

  it('propagates provider failures — the compaction caller owns the fail-open contract', async () => {
    capturePipeline()
    mockRunPiOneShotText.mockRejectedValue(new Error('compressor down'))
    await expect(summarizeCompaction([{ role: 'user', content: 'hello' }] as never, COMPRESSION_MODEL)).rejects.toThrow(
      'compressor down'
    )
  })
})

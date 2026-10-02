import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeModel, makeProvider } from '../../__tests__/fixtures'
import { resolveCompressionModel } from '../resolveCompressionModel'

const { providerLookup, modelLookup } = vi.hoisted(() => ({
  providerLookup: vi.fn(),
  modelLookup: vi.fn()
}))
vi.mock('@main/data/services/ProviderService', () => ({ providerService: { getByProviderId: providerLookup } }))
vi.mock('@main/data/services/ModelService', () => ({ modelService: { getByKey: modelLookup } }))

const CONVERSATION = { id: 'conversation-1', topicId: 'topic-1' }

describe('resolveCompressionModel', () => {
  beforeEach(() => {
    providerLookup.mockReturnValue(makeProvider({ id: 'opencode' }))
    modelLookup.mockReturnValue(
      makeModel({ id: 'opencode::small', providerId: 'opencode', apiModelId: 'small', contextWindow: 8_000 })
    )
  })

  it('returns null for a non-UniqueModelId string', async () => {
    expect(await resolveCompressionModel('not-a-unique-id', CONVERSATION)).toBeNull()
  })

  it('returns null when provider/model lookup throws', async () => {
    providerLookup.mockImplementationOnce(() => {
      throw new Error('no such provider')
    })
    expect(await resolveCompressionModel('ghost::model-x', CONVERSATION)).toBeNull()
  })

  it('returns the provider/model rows the pi one-shot lane resolves its injection from', async () => {
    const descriptor = await resolveCompressionModel('opencode::small', CONVERSATION)
    expect(descriptor).not.toBeNull()
    expect(descriptor?.provider.id).toBe('opencode')
    expect(descriptor?.model.id).toBe('opencode::small')
    // The wire id is the injection's concern — the row keeps whatever it declares.
    expect(descriptor?.model.apiModelId).toBe('small')
  })

  it('carries the owning conversation so session-scoped providers stamp it on the summarize call', async () => {
    const descriptor = await resolveCompressionModel('opencode::small', CONVERSATION)
    expect(descriptor?.conversationId).toBe('conversation-1')
  })

  it('budgets the summary against the compressor own window', async () => {
    expect((await resolveCompressionModel('opencode::small', CONVERSATION))?.contextWindow).toBe(8_000)
  })

  it('reports a null window when the compressor row declares none', async () => {
    modelLookup.mockReturnValue(makeModel({ contextWindow: undefined }))
    expect((await resolveCompressionModel('opencode::small', CONVERSATION))?.contextWindow).toBeNull()
  })
})

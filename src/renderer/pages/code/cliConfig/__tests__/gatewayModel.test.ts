import { describe, expect, it } from 'vitest'

import { formatGatewayModelId } from '@shared/utils/apiGateway'

import { gatewayExpectedModel } from '../gatewayModel'

/**
 * The gateway addressing string is the one contract the write side and every
 * connection-match side must agree on byte-for-byte, so these pin its shape:
 * `providerId:apiModelId` (single colon, NOT the `::` internal UniqueModelId).
 */
describe('formatGatewayModelId', () => {
  it('joins providerId and apiModelId with a single colon (never the "::" internal separator)', () => {
    expect(formatGatewayModelId('deepseek', 'deepseek-chat')).toBe('deepseek:deepseek-chat')
    expect(formatGatewayModelId('openai', 'gpt-4o')).not.toContain('::')
  })
})

describe('gatewayExpectedModel', () => {
  it('formats the gateway address for a valid stored UniqueModelId', () => {
    expect(gatewayExpectedModel('deepseek::deepseek-chat')).toBe('deepseek:deepseek-chat')
  })

  it('prefers the passed apiModelId over the parsed internal model id', () => {
    // The connection-match side passes the model record's apiModelId so it lines
    // up with what resolveContext writes (which also uses apiModelId).
    expect(gatewayExpectedModel('deepseek::deepseek-chat', 'deepseek-reasoner')).toBe('deepseek:deepseek-reasoner')
  })

  it('returns undefined for a missing or non-UniqueModelId value (matcher skips the model check)', () => {
    expect(gatewayExpectedModel(null)).toBeUndefined()
    expect(gatewayExpectedModel(undefined)).toBeUndefined()
    expect(gatewayExpectedModel('not-a-unique-id')).toBeUndefined()
  })
})

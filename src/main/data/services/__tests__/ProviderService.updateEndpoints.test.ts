// Load the sibling so it self-registers in the data-service registry (prod loads it via its DataApi handler).
import '@data/services/ProviderRegistryService'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { userProviderTable } from '@data/db/schemas/userProvider'
import { providerService } from '@data/services/ProviderService'
import { ENDPOINT_TYPE } from '@shared/data/types/model'

// Stub the registry loader so the preset lookup returns a minimal Relay row
// (its anthropic / gemini / OpenAI endpoints tagged `newapi`) without
// reading the shipped providers.json, whose path is mocked away in the harness.
vi.mock('@cherrystudio/provider-registry/node', () => {
  class RegistryLoader {
    loadProviders() {
      return [
        {
          id: 'relay-hub',
          endpointConfigs: {
            'anthropic-messages': { adapterFamily: 'newapi', baseUrl: 'https://open.relay-hub.net' },
            'google-generate-content': { adapterFamily: 'newapi', baseUrl: 'https://open.relay-hub.net' },
            'openai-responses': { adapterFamily: 'newapi', baseUrl: 'https://open.relay-hub.net' },
            'openai-chat-completions': { adapterFamily: 'newapi', baseUrl: 'https://open.relay-hub.net' }
          }
        }
      ]
    }
    loadModels() {
      return []
    }
    loadProviderModels() {
      return []
    }
    findModel() {
      return null
    }
    findOverride() {
      return null
    }
  }
  return { RegistryLoader }
})

describe('ProviderService.update — endpoint config overrides', () => {
  const dbh = setupTestDatabase()

  it('strips legacy reasoningFormatType from persisted endpoint configs on read', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'legacy-reasoning-format',
      name: 'Legacy Reasoning Format',
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://proxy.example/v1',
          adapterFamily: 'openai',
          reasoningFormatType: 'openai-responses'
        }
      } as never,
      orderKey: 'a0'
    })

    const provider = providerService.getByProviderId('legacy-reasoning-format')
    const endpointConfig = provider.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]

    expect(endpointConfig).toEqual({
      baseUrl: 'https://proxy.example/v1',
      adapterFamily: 'openai'
    })
    expect(endpointConfig).not.toHaveProperty('reasoningFormatType')
  })

  it('persists a { baseUrl }-only override when a settings PATCH adds an endpoint', async () => {
    // A correctly-created preset-derived instance (openai-chat tagged `newapi`).
    providerService.create({
      providerId: 'relay-hub-express',
      presetProviderId: 'relay-hub',
      name: 'CherryIn Express',
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://express-ent-admin.relay-hub.ai' }
      }
    })

    // The "add endpoint" drawer PATCHes the public baseUrl-only shape.
    providerService.update('relay-hub-express', {
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://express-ent-admin.relay-hub.ai'
        },
        [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]: { baseUrl: 'https://express-ent-admin.relay-hub.ai/v1' }
      }
    })

    const [row] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, 'relay-hub-express'))

    // Rows persist only the user-owned override shape — the echoed
    // adapterFamily is stripped for preset-linked providers.
    expect(row.endpointConfigs?.[ENDPOINT_TYPE.ANTHROPIC_MESSAGES]).toEqual({
      baseUrl: 'https://express-ent-admin.relay-hub.ai/v1'
    })
    expect(row.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]).toEqual({
      baseUrl: 'https://express-ent-admin.relay-hub.ai'
    })
    // The runtime read supplies the preset family for the newly-added
    // endpoint instead of the openai-compatible fallback.
    const runtime = providerService.getByProviderId('relay-hub-express')
    expect(runtime.endpointConfigs?.[ENDPOINT_TYPE.ANTHROPIC_MESSAGES]?.adapterFamily).toBe('newapi')
    expect(runtime.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.adapterFamily).toBe('newapi')
  })

  it('preserves a main-only legacy adapterFamily when a custom provider baseUrl is updated', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'custom-newapi-relay',
      name: 'Custom NewAPI Relay',
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://old-relay.example.com',
          adapterFamily: 'newapi'
        }
      },
      orderKey: 'a0'
    })

    providerService.update('custom-newapi-relay', {
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://new-relay.example.com' }
      }
    })

    const [row] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, 'custom-newapi-relay'))
    expect(row.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]).toEqual({
      baseUrl: 'https://new-relay.example.com',
      adapterFamily: 'newapi'
    })
    const runtime = providerService.getByProviderId('custom-newapi-relay')
    expect(runtime.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.adapterFamily).toBe('newapi')
  })

  it('uses the preset adapter family when adding the Relay Responses endpoint', async () => {
    providerService.create({
      providerId: 'relay-hub-express-2',
      presetProviderId: 'relay-hub',
      name: 'CherryIn Express 2',
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://express-ent-admin.relay-hub.ai' }
      }
    })

    providerService.update('relay-hub-express-2', {
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: { baseUrl: 'https://express-ent-admin.relay-hub.ai' }
      }
    })

    const [row] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, 'relay-hub-express-2'))
    expect(row.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_RESPONSES]).toEqual({
      baseUrl: 'https://express-ent-admin.relay-hub.ai'
    })
    const runtime = providerService.getByProviderId('relay-hub-express-2')
    expect(runtime.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_RESPONSES]?.adapterFamily).toBe('newapi')
  })
})

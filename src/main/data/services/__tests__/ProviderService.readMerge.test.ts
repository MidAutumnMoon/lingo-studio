// Load the sibling so it self-registers in the data-service registry (prod loads it via its DataApi handler).
import '@data/services/ProviderRegistryService'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { userProviderTable } from '@data/db/schemas/userProvider'
import { providerService } from '@data/services/ProviderService'
import { resolveAiSdkProviderId } from '@main/ai/provider/endpoint'
import { ErrorCode } from '@shared/data/api/errors'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
import { ProviderSchema } from '@shared/data/types/provider'

vi.mock('@main/utils/appEdition', () => ({ getAppEdition: () => 'global' }))

// Stub the registry loader with a relay preset plus a future `my-relay` preset.
// `google-generate-content` is deliberately present for relay-hub but ABSENT
// from the persisted rows below — modelling an install seeded before the
// registry gained that endpoint (#17096). `my-relay` models a later registry
// id collision with an already-persisted fully custom provider.
vi.mock('@cherrystudio/provider-registry/node', () => {
  class RegistryLoader {
    loadProviders() {
      return [
        {
          id: 'relay-hub',
          endpointConfigs: {
            'openai-chat-completions': {
              adapterFamily: 'newapi',
              baseUrl: 'https://open.relay-hub.net',
              modelsApiUrls: { default: 'https://open.relay-hub.net/v1/models' }
            },
            'openai-responses': { adapterFamily: 'newapi', baseUrl: 'https://open.relay-hub.net' },
            'google-generate-content': { adapterFamily: 'newapi', baseUrl: 'https://open.relay-hub.net' }
          },
          defaultChatEndpoint: 'openai-chat-completions',
          reportsActualCost: false,
          reportedCostCurrency: 'USD',
          availableInEditions: ['global', 'cn']
        },
        {
          id: 'my-relay',
          description: 'Future registry provider',
          supplementModelsFromRegistry: true,
          endpointConfigs: {
            'openai-chat-completions': {
              adapterFamily: 'future-registry',
              baseUrl: 'https://registry.example/v1',
              modelsApiUrls: { default: 'https://registry.example/v1/models' }
            }
          },
          defaultChatEndpoint: 'openai-chat-completions'
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

describe('ProviderService read-time registry merge (#17096)', () => {
  const dbh = setupTestDatabase()

  it.each([
    { providerId: 'my-relay', presetProviderId: 'my-relay', expected: true },
    { providerId: 'my-relay', presetProviderId: null, expected: undefined },
    { providerId: 'relay-copy', presetProviderId: 'my-relay', expected: true },
    { providerId: 'relay-hub', presetProviderId: null, expected: undefined },
    { providerId: 'custom-provider', presetProviderId: null, expected: undefined }
  ])(
    'resolves model-list supplementation for $providerId with preset $presetProviderId',
    ({ providerId, presetProviderId, expected }) => {
      dbh.db.insert(userProviderTable).values({ providerId, presetProviderId, name: providerId, orderKey: 'a0' }).run()

      const provider = ProviderSchema.parse(providerService.getByProviderId(providerId))

      expect(provider.supplementModelsFromRegistry).toBe(expected)
    }
  )

  it.each(['github', 'yi'])(
    'makes retired %s providers and copies unavailable without deleting data',
    async (retiredId) => {
      await dbh.db.insert(userProviderTable).values([
        {
          providerId: retiredId,
          presetProviderId: null,
          name: 'Retired Provider',
          apiKeys: [{ id: `${retiredId}-key`, key: 'secret', isEnabled: true }],
          orderKey: 'a0'
        },
        {
          providerId: `${retiredId}-copy`,
          presetProviderId: retiredId,
          name: 'Retired Provider Copy',
          apiKeys: [{ id: `${retiredId}-copy-key`, key: 'copy-secret', isEnabled: true }],
          orderKey: 'a1'
        },
        {
          providerId: 'custom-relay',
          presetProviderId: null,
          name: 'Custom Relay',
          orderKey: 'a2'
        }
      ])

      const originalRows = dbh.db.select().from(userProviderTable).all()

      expect(providerService.list({}).map((provider) => provider.id)).toEqual(['custom-relay'])
      expect(() => providerService.getByProviderId(retiredId)).toThrowError(
        expect.objectContaining({ code: ErrorCode.NOT_FOUND })
      )
      expect(() => providerService.getByProviderId(`${retiredId}-copy`)).toThrowError(
        expect.objectContaining({ code: ErrorCode.NOT_FOUND })
      )

      for (const { providerId, keyId } of [
        { providerId: retiredId, keyId: `${retiredId}-key` },
        { providerId: `${retiredId}-copy`, keyId: `${retiredId}-copy-key` }
      ]) {
        const operations = [
          () => providerService.assertAvailable(providerId),
          () => providerService.update(providerId, { name: 'Still retired' }),
          () => providerService.resolveApiKey(providerId),
          () => providerService.getApiKeys(providerId),
          () => providerService.getAuthConfig(providerId),
          () => providerService.addApiKey(providerId, 'new-secret'),
          () =>
            providerService.replaceApiKeys(providerId, [
              { id: 'replacement-key', key: 'replacement-secret', isEnabled: true }
            ]),
          () => providerService.updateApiKey(providerId, keyId, { label: 'updated' }),
          () => providerService.deleteApiKey(providerId, keyId),
          () => providerService.delete(providerId)
        ]

        for (const operation of operations) {
          expect(operation).toThrowError(expect.objectContaining({ code: ErrorCode.NOT_FOUND }))
        }
      }
      expect(dbh.db.select().from(userProviderTable).all()).toEqual(originalRows)
    }
  )

  it('surfaces a registry-added endpoint type absent from the persisted row', async () => {
    // Stale seed: only openai-chat persisted; google-generate-content added to
    // the registry after this row was seeded.
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://open.relay-hub.net',
          adapterFamily: 'newapi'
        }
      },
      orderKey: 'a0'
    })

    const provider = providerService.getByProviderId('relay-hub')

    expect(provider.endpointConfigs?.[ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]).toEqual({
      adapterFamily: 'newapi',
      baseUrl: 'https://open.relay-hub.net'
    })
    expect(provider.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_RESPONSES]).toEqual({
      adapterFamily: 'newapi',
      baseUrl: 'https://open.relay-hub.net'
    })
    // End to end: the resolver no longer falls through to openai-compatible.
    expect(resolveAiSdkProviderId(provider, ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT)).not.toBe('openai-compatible')
    expect(resolveAiSdkProviderId(provider, ENDPOINT_TYPE.OPENAI_RESPONSES)).toBe('newapi')
  })

  it('keeps the user-owned baseUrl while refreshing registry-owned fields', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://proxy.corp.example/v1', // user override
          adapterFamily: 'stale-family' // stale registry snapshot
        }
      },
      orderKey: 'a0'
    })

    const config = providerService.getByProviderId('relay-hub').endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]

    expect(config).toEqual({
      baseUrl: 'https://proxy.corp.example/v1', // row wins
      adapterFamily: 'newapi', // registry wins
      modelsApiUrls: { default: 'https://open.relay-hub.net/v1/models' } // registry wins
    })
  })

  it('keeps explicit custom provenance when a future registry entry reuses the provider id', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'my-relay',
      presetProviderId: null,
      name: 'My Relay',
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://relay.example/v1',
          adapterFamily: 'newapi' // migrator-written hint must survive
        },
        [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]: {
          baseUrl: 'https://relay.example' // no family → endpoint-type inference
        }
      },
      orderKey: 'a0'
    })

    const provider = providerService.getByProviderId('my-relay')
    const configs = provider.endpointConfigs

    expect(provider.description).toBeUndefined()
    expect(provider.defaultChatEndpoint).toBeUndefined()
    expect(configs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]).toEqual({
      baseUrl: 'https://relay.example/v1',
      adapterFamily: 'newapi'
    })
    expect(configs?.[ENDPOINT_TYPE.ANTHROPIC_MESSAGES]).toEqual({
      baseUrl: 'https://relay.example',
      adapterFamily: 'anthropic'
    })
  })

  it('resolves registry-owned request metadata when the row stores no delta', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      orderKey: 'a0'
    })

    const provider = providerService.getByProviderId('relay-hub')

    // Registry baseline over app defaults; nothing frozen in the row.
    expect(provider.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.dialect).toBeUndefined()
    expect(provider.defaultChatEndpoint).toBe(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS)
    expect(provider.reportedCostCurrency).toBe('USD')
    expect(provider.availableInEditions).toEqual(['global', 'cn'])
  })

  it('resolves transaction reasoning contexts without decoding unrelated provider fields', () => {
    dbh.db
      .insert(userProviderTable)
      .values({
        providerId: 'relay-hub',
        presetProviderId: 'relay-hub',
        name: 'RelayHub',
        defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
        orderKey: 'a0'
      })
      .run()
    dbh.sqlite.prepare("UPDATE user_provider SET api_keys = 'invalid-json' WHERE provider_id = ?").run('relay-hub')

    const context = dbh.db.transaction((tx) =>
      providerService.getReasoningContextsByProviderIdsTx(tx, ['relay-hub']).get('relay-hub')
    )

    expect(context).toMatchObject({
      id: 'relay-hub',
      presetProviderId: 'relay-hub',
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    })
    expect(context?.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]).toEqual({
      adapterFamily: 'newapi',
      baseUrl: 'https://open.relay-hub.net',
      modelsApiUrls: { default: 'https://open.relay-hub.net/v1/models' }
    })
  })

  it('keeps providers absent from the current registry edition-neutral', async () => {
    await dbh.db.insert(userProviderTable).values([
      {
        providerId: 'hyperbolic',
        presetProviderId: 'hyperbolic',
        name: 'Hyperbolic',
        orderKey: 'a0'
      },
      {
        providerId: 'custom-provider',
        presetProviderId: null,
        name: 'Custom Provider',
        orderKey: 'a1'
      }
    ])

    expect(providerService.getByProviderId('hyperbolic').availableInEditions).toBeUndefined()
    expect(providerService.getByProviderId('custom-provider').availableInEditions).toBeUndefined()
  })

  it('persists an endpoint dialect as a delta: deviations stick, registry echoes vanish', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      orderKey: 'a0'
    })
    const chat = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS

    // A deviation from the registry (which declares no dialect, so developerRole defaults false).
    providerService.update('relay-hub', { endpointConfigs: { [chat]: { dialect: { developerRole: true } } } })
    let [row] = await dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, 'relay-hub'))
    expect(row.endpointConfigs?.[chat]?.dialect).toEqual({ developerRole: true })
    expect(providerService.getByProviderId('relay-hub').endpointConfigs?.[chat]?.dialect).toEqual({
      developerRole: true
    })

    // Echoing the registry's own value is not an override — the row keeps no dialect.
    providerService.update('relay-hub', { endpointConfigs: { [chat]: { dialect: { developerRole: false } } } })
    ;[row] = await dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, 'relay-hub'))
    expect(row.endpointConfigs?.[chat]?.dialect).toBeUndefined()
  })

  it('drops a defaultChatEndpoint echo that matches the registry baseline', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      orderKey: 'a0'
    })

    // The provider editor echoes the current runtime endpoint while renaming.
    // That baseline value must not become a stored override.
    providerService.update('relay-hub', {
      name: 'Renamed RelayHub',
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    })
    let [row] = await dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, 'relay-hub'))
    expect(row.defaultChatEndpoint).toBeNull()

    // A real user override persists, then disappears again when reset to the
    // registry baseline.
    providerService.update('relay-hub', {
      defaultChatEndpoint: ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT
    })
    ;[row] = await dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, 'relay-hub'))
    expect(row.defaultChatEndpoint).toBe(ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT)

    providerService.update('relay-hub', {
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    })
    ;[row] = await dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, 'relay-hub'))
    expect(row.defaultChatEndpoint).toBeNull()
  })

  it('drops endpoint baseUrls that match the registry default on write', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      orderKey: 'a0'
    })

    // Renderer echo of the merged snapshot: one registry-default baseUrl, one
    // genuine user override.
    providerService.update('relay-hub', {
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://open.relay-hub.net' },
        [ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]: { baseUrl: 'https://proxy.corp.example' }
      }
    })

    const [row] = await dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, 'relay-hub'))
    expect(row.endpointConfigs).toEqual({
      [ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]: { baseUrl: 'https://proxy.corp.example' }
    })
    // The runtime still sees both endpoints — the dropped one from the registry.
    const runtime = providerService.getByProviderId('relay-hub')
    expect(runtime.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.baseUrl).toBe('https://open.relay-hub.net')
    expect(runtime.endpointConfigs?.[ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]?.baseUrl).toBe('https://proxy.corp.example')
  })

  it('strips legacy registry-only fields before merging', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'relay-hub',
      presetProviderId: 'relay-hub',
      name: 'RelayHub',
      endpointConfigs: {
        [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
          baseUrl: 'https://open.relay-hub.net',
          adapterFamily: 'newapi',
          reasoningFormatType: 'openai-responses'
        }
      } as never,
      orderKey: 'a0'
    })

    const config = providerService.getByProviderId('relay-hub').endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
    expect(config).not.toHaveProperty('reasoningFormatType')
  })
})

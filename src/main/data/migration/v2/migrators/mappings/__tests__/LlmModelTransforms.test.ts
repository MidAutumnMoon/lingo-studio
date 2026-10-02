import { mockMainLoggerService } from '@test-mocks/MainLoggerService'
import { beforeEach, describe, expect, it } from 'vitest'

import { transformLlmModelIds } from '../LlmModelTransforms'

describe('LlmModelTransforms', () => {
  beforeEach(() => {
    mockMainLoggerService.warn.mockClear()
  })

  describe('transformLlmModelIds', () => {
    it('transforms model fields to UniqueModelIds', () => {
      const sources = {
        defaultModel: { id: 'gpt-4', provider: 'openai', name: 'GPT-4' },
        translateModel: { id: 'qwen-max', provider: 'qwen', name: 'Qwen Max' }
      }

      const result = transformLlmModelIds(sources)

      expect(result).toEqual({
        'chat.default_model_id': 'openai::gpt-4',
        'feature.translate.model_id': 'qwen::qwen-max'
      })
    })

    it('migrates missing model objects to no default model', () => {
      const result = transformLlmModelIds({})

      expect(result).toEqual({
        'chat.default_model_id': null,
        'feature.translate.model_id': null
      })
    })

    it('handles mix of valid and missing models', () => {
      const sources = {
        defaultModel: { id: 'gpt-4', provider: 'openai' }
        // translateModel not present
      }

      const result = transformLlmModelIds(sources)

      expect(result['chat.default_model_id']).toBe('openai::gpt-4')
      expect(result['feature.translate.model_id']).toBeNull()
    })

    it('handles model with incomplete data (missing provider)', () => {
      const sources = {
        defaultModel: { id: 'gpt-4' } // no provider
      }

      const result = transformLlmModelIds(sources)

      expect(result['chat.default_model_id']).toBeNull()
    })

    it('uses shared model conversion behavior for passthrough, trimming, and invalid providers', () => {
      const result = transformLlmModelIds({
        defaultModel: { id: ' openai::gpt-4 ', provider: 'openai' },
        translateModel: 'not-an-object'
      })

      expect(result).toEqual({
        'chat.default_model_id': 'openai::gpt-4',
        'feature.translate.model_id': null
      })
      expect(mockMainLoggerService.warn).toHaveBeenCalledWith(
        'Legacy model preference could not be parsed; migrating to no default model',
        {
          preferenceKey: 'feature.translate.model_id',
          valueType: 'string'
        }
      )
    })

    it('migrates legacy managed-provider model references to no default model', () => {
      // v1 'cherryai' references have no v2 counterpart (the managed provider is
      // retired); the preference lands on null and onboarding asks the user.
      const result = transformLlmModelIds({
        defaultModel: { id: 'old-default', provider: 'cherryai' },
        translateModel: { id: 'old-translate', provider: 'cherryai' }
      })

      expect(result).toEqual({
        'chat.default_model_id': null,
        'feature.translate.model_id': null
      })
    })
  })
})

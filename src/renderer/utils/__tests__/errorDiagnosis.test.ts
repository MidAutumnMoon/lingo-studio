import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n/resolver', () => ({
  default: { t: () => 'Diagnosis model is unavailable' }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}))

const { mockDataApiGet, mockPreferenceGet, mockFetchGenerate } = vi.hoisted(() => ({
  mockDataApiGet: vi.fn(),
  mockPreferenceGet: vi.fn(),
  mockFetchGenerate: vi.fn()
}))

vi.mock('@data/DataApiService', () => ({ dataApiService: { get: mockDataApiGet } }))
vi.mock('@data/PreferenceService', () => ({ preferenceService: { get: mockPreferenceGet } }))
vi.mock('@renderer/utils/aiGeneration', () => ({ fetchGenerate: mockFetchGenerate }))

import { classifyErrorByAI, diagnoseError, type DiagnosisContext } from '../errorDiagnosis'

const diagnosisModel = {
  id: 'openai::gpt-4o-mini',
  providerId: 'openai',
  name: 'GPT-4o mini',
  capabilities: []
}

function configureModel(id: string | null): void {
  mockPreferenceGet.mockResolvedValue(id)
  mockDataApiGet.mockImplementation(async (path: string) => (path === `/models/${id}` ? diagnosisModel : undefined))
}

describe('errorDiagnosis (explicit diagnosis model)', () => {
  const error = { name: 'Error', message: 'test error', stack: null }
  const context: DiagnosisContext = { errorSource: 'chat', providerId: 'openai', modelId: 'gpt-4' }

  it('rejects with the unavailable message while no diagnosis model is configured', async () => {
    configureModel(null)
    await expect(diagnoseError(error, 'en')).rejects.toThrow('Diagnosis model is unavailable')
    expect(mockFetchGenerate).not.toHaveBeenCalled()
  })

  it('rejects when the configured diagnosis model no longer exists', async () => {
    configureModel('openai::gone')
    mockDataApiGet.mockResolvedValueOnce(undefined)

    await expect(diagnoseError(error, 'en', context)).rejects.toThrow('Diagnosis model is unavailable')
    expect(mockFetchGenerate).not.toHaveBeenCalled()
  })

  it('diagnoses through the configured model and parses the JSON result', async () => {
    configureModel('openai::gpt-4o-mini')
    mockFetchGenerate.mockResolvedValueOnce(
      '{"summary":"Key rejected","category":"auth","explanation":"The key is invalid.","steps":[{"text":"Check the key"}]}'
    )

    const result = await diagnoseError(error, 'en', context)

    expect(mockFetchGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ model: diagnosisModel, throwOnError: true })
    )
    expect(result.summary).toBe('Key rejected')
    expect(result.steps).toEqual([{ text: 'Check the key' }])
  })

  it('classifyErrorByAI returns the trimmed one-line summary', async () => {
    configureModel('openai::gpt-4o-mini')
    mockFetchGenerate.mockResolvedValueOnce('  Rate limited.  ')

    await expect(classifyErrorByAI(error, 'en')).resolves.toBe('Rate limited.')
  })

  it('classifyErrorByAI degrades to an empty summary on failure', async () => {
    configureModel('openai::gpt-4o-mini')
    mockFetchGenerate.mockRejectedValueOnce(new Error('boom'))

    await expect(classifyErrorByAI(error, 'en')).resolves.toBe('')
  })
})

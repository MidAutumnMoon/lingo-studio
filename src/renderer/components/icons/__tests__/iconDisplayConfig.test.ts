import { describe, expect, it } from 'vitest'

import { resolveProviderIconRef } from '@cherrystudio/ui/icons'

import { getIconDisplayConfig } from '../iconDisplayConfig'

describe('getIconDisplayConfig', () => {
  it.each(['cherryin', 'aihubmix', 'lmstudio', 'anthropic', 'yi', 'groq', 'aws-bedrock', 'tokendance'])(
    'contains the %s provider logo',
    (providerId) => {
      const icon = resolveProviderIconRef(providerId)
      expect(icon).toBeDefined()
      expect(getIconDisplayConfig(icon?.meta.id)).toEqual({ scale: 5 / 7, borderRadius: 5 })
    }
  )

  it('enlarges provider logos outside the contained-icon list', () => {
    expect(getIconDisplayConfig('openai')).toEqual({ scale: 1.2 })
  })

  it('returns undefined without an icon id', () => {
    expect(getIconDisplayConfig(undefined)).toBeUndefined()
  })
})

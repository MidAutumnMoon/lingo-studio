import { defineCreator } from './types'

export default defineCreator({
  id: 'vercel',
  name: 'Vercel',
  modelsDevProviders: ['vercel'],
  idPrefixes: ['v0'],
  reasoningFamilies: [
    { pattern: '^muse-spark' },
    { pattern: '^interfaze' },
    { pattern: '^laguna-s' },
    // Reasoning SKUs served through Vercel's gateway: Vercel's Arrow 2 line and Sakana AI's fugu/namazu.
    { pattern: '^arrow-2', effort: ['low', 'medium', 'high', 'xhigh'] },
    { pattern: '^fugu-', effort: ['high', 'xhigh'] },
    { pattern: '^namazu', effort: ['none', 'low', 'medium', 'high'] },
    { pattern: '^ember-', effort: ['none', 'low', 'medium', 'high'] }
  ]
})

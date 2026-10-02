import { definePlugin } from '@cherrystudio/ai-core'
import { ENDPOINT_TYPE } from '@shared/data/types/model'

import { getReasoningTagName } from '../../../../utils/reasoning'
import type { RequestFeature } from '../feature'
import { createAnchoredReasoningExtraction } from './reasoningExtractionMiddleware'

/**
 * Reasoning Extraction Plugin — moves the leading inline `<tag>…</tag>` block
 * of the openai-style `text` channel into `reasoning-delta` chunks.
 */
const createReasoningExtractionPlugin = (options: { tagName?: string } = {}) =>
  definePlugin({
    name: 'reasoning-extraction',
    enforce: 'pre',

    configureContext: (context) => {
      context.middlewares = context.middlewares || []
      context.middlewares.push(createAnchoredReasoningExtraction(options.tagName || 'thinking'))
    }
  })

/**
 * Applies to `openai-chat-completions`. Chat-completions has no native reasoning field, so
 * custom model templates that emit inline `<tag>…</tag>` text need it lifted out. Other
 * native-reasoning endpoints (anthropic-messages / google / openai-responses) are left
 * untouched, so literal tags stay content.
 *
 * The extraction itself is anchored (see `reasoningExtractionMiddleware`): a tag that is not the
 * start of the reply, or a reply whose wire already streamed structured reasoning, stays content.
 */
export const reasoningExtractionFeature: RequestFeature = {
  name: 'reasoning-extraction',
  applies: (scope) => scope.endpointType === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
  contributeModelAdapters: (scope) => [
    createReasoningExtractionPlugin({ tagName: getReasoningTagName(scope.model.id.toLowerCase()) })
  ]
}

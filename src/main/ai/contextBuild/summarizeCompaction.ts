/**
 * Durable-compaction summarize: aiCore's shaping pipeline (attachment
 * stripping, tool-result stub escalation, input-budget clamp, instruction
 * assembly, `<summary>` extraction — `summarizeHistory`) with the final LLM
 * call on the pi one-shot lane. Successor of aiCore's
 * `summarizeModelMessages`, which needed an AI SDK `LanguageModel`.
 *
 * Throws when the provider call fails — the compaction caller owns the
 * fail-open contract (serve un-compacted history, settle the anchor as
 * skipped), same as it did for `summarizeModelMessages`.
 */
import {
  compactHistory,
  type ContextMessage,
  fromModelMessages,
  type PlanCompactionOptions,
  summarizeHistory,
  type SummarizeHistoryOptions,
  toModelMessages
} from '@cherrystudio/ai-core'

import { type PiOneShotTurnMessage, runPiOneShotText } from '../runtime/pi/piOneShot'
import type { CompressionModelDescriptor } from './resolveCompressionModel'

/** The served-history input `fromModelMessages` converts (typed without importing `ai`). */
type CompactionMessages = Parameters<typeof fromModelMessages>[0]

/**
 * In-loop compaction's compact: aiCore's split/rebuild pipeline
 * (`compactHistory` — turn-boundary split, `system` preserved verbatim,
 * `[...system, <summary>, ...recent turns]` result) with the summarize call on
 * the pi one-shot lane. Successor of aiCore's `compactModelMessages`, which
 * needed an AI SDK `LanguageModel`. Returns the input reference on a no-op
 * (nothing old enough / no summary text), like `compactModelMessages` did.
 */
export async function compactCompactionMessages(
  messages: CompactionMessages,
  compressionModel: CompressionModelDescriptor,
  options: PlanCompactionOptions & { maxOutputTokens?: number; maxInputTokens?: number }
): Promise<CompactionMessages> {
  const { maxOutputTokens, ...compactOptions } = options
  const ir = fromModelMessages(messages)
  const result = await compactHistory(
    ir,
    (assembled) => runCompressionCall(assembled, compressionModel, maxOutputTokens),
    compactOptions
  )
  return result === ir ? messages : toModelMessages(result)
}

export async function summarizeCompaction(
  messages: CompactionMessages,
  compressionModel: CompressionModelDescriptor,
  opts: { maxOutputTokens?: number; maxInputTokens?: number } = {}
): Promise<string> {
  // System rows are standing instructions, not conversation — drop them like
  // `summarizeModelMessages` did before handing the slice to the pipeline.
  const ir = fromModelMessages(messages).filter((m) => m.role !== 'system')
  return summarizeHistory(ir, (assembled) => runCompressionCall(assembled, compressionModel, opts.maxOutputTokens), {
    ...(opts.maxInputTokens !== undefined && { maxInputTokens: opts.maxInputTokens })
  } satisfies SummarizeHistoryOptions)
}

async function runCompressionCall(
  assembled: ContextMessage[],
  compressionModel: CompressionModelDescriptor,
  maxOutputTokens: number | undefined
): Promise<string> {
  const result = await runPiOneShotText({
    provider: compressionModel.provider,
    model: compressionModel.model,
    sessionId: compressionModel.conversationId,
    messages: toOneShotMessages(assembled),
    ...(maxOutputTokens !== undefined && { requestOptions: { maxTokens: maxOutputTokens } })
  })
  // Verbatim, an empty string included — callers fail open on empty, and a
  // placeholder here would defeat their "no summary → no fold" guards.
  return result.text
}

/**
 * IR → one-shot turn messages, mirroring the tool folding aiCore's compression
 * adapter performed: tool interactions become described text under a role the
 * one-shot lane accepts, never native tool blocks.
 */
function toOneShotMessages(messages: readonly ContextMessage[]): PiOneShotTurnMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: `[Tool result${message.tool_call_id ? ` (${message.tool_call_id})` : ''}: ${message.content}]`
      }
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const toolCallsDesc = message.tool_calls
        .map((tc) => `[Called tool: ${tc.function.name}(${tc.function.arguments})]`)
        .join('\n')
      return { role: 'assistant', content: message.content ? `${message.content}\n${toolCallsDesc}` : toolCallsDesc }
    }
    return { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }
  })
}

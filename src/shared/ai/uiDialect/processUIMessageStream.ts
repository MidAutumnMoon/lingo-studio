import type { JSONObject } from '@ai-sdk/provider'
/**
 * Vendored from ai@6.0.185 `dist/index.mjs` (src/ui/process-ui-message-stream.ts) — Phase-2 D3
 * (docs/plans/2026-09-pi-unification.md); part mutations go through `as any` casts exactly where
 * upstream's compiled output does. The upstream `ai` dep still serves aiCore.
 */
import type { FlexibleSchema } from '@ai-sdk/provider-utils'
import { validateTypes } from '@ai-sdk/provider-utils'

import { UIMessageStreamError } from './errors'
import { mergeObjects } from './mergeObjects'
import { parsePartialJson } from './partialJson'
import type { ProviderMetadata } from './types'
import type { StreamingUIMessageState, UIMessage, UIMessageChunk, UIMessageStreamJobExecutor } from './types'
import { getStaticToolName, isStaticToolUIPart, isToolUIPart } from './uiParts'

function isDataUIMessageChunk(chunk: UIMessageChunk): boolean {
  return chunk.type.startsWith('data-')
}

export function createStreamingUIMessageState<UI_MESSAGE extends UIMessage>({
  lastMessage,
  messageId
}: {
  lastMessage: UI_MESSAGE | undefined
  messageId: string
}): StreamingUIMessageState<UI_MESSAGE> {
  return {
    message:
      lastMessage?.role === 'assistant'
        ? lastMessage
        : ({
            id: messageId,
            metadata: undefined,
            role: 'assistant',
            parts: []
          } as unknown as UI_MESSAGE),
    activeTextParts: {},
    activeReasoningParts: {},
    partialToolCalls: {}
  }
}

interface UpdateToolPartOptions {
  toolCallId: string
  toolName: string
  state:
    | 'input-streaming'
    | 'input-available'
    | 'approval-requested'
    | 'approval-responded'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
  input?: unknown
  rawInput?: unknown
  output?: unknown
  errorText?: string
  providerExecuted?: boolean
  title?: string
  toolMetadata?: JSONObject
  preliminary?: boolean
  providerMetadata?: ProviderMetadata
}

export function processUIMessageStream({
  stream,
  messageMetadataSchema,
  dataPartSchemas,
  runUpdateMessageJob,
  onError,
  onToolCall,
  onData
}: {
  stream: ReadableStream<UIMessageChunk>
  messageMetadataSchema?: FlexibleSchema
  dataPartSchemas?: Record<string, FlexibleSchema>
  runUpdateMessageJob: UIMessageStreamJobExecutor
  onError?: (error: unknown) => void
  onToolCall?: (event: { toolCall: any }) => PromiseLike<void> | void
  onData?: (dataPart: any) => void
}): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      async transform(chunk, controller) {
        await runUpdateMessageJob(async ({ state, write }) => {
          function getToolInvocation(toolCallId: string): any {
            const toolInvocations = state.message.parts.filter(isToolUIPart)
            const toolInvocation = toolInvocations.find((invocation) => invocation.toolCallId === toolCallId)
            if (toolInvocation == null) {
              throw new UIMessageStreamError({
                chunkType: 'tool-invocation',
                chunkId: toolCallId,
                message: `No tool invocation found for tool call ID "${toolCallId}".`
              })
            }
            return toolInvocation
          }

          function updateToolPart(options: UpdateToolPartOptions) {
            const part = state.message.parts.find(
              (part) => isStaticToolUIPart(part) && part.toolCallId === options.toolCallId
            ) as any
            const anyOptions = options as any

            if (part != null) {
              part.state = options.state
              part.input = anyOptions.input
              part.output = anyOptions.output
              part.errorText = anyOptions.errorText
              part.rawInput = anyOptions.rawInput
              part.preliminary = anyOptions.preliminary
              if (options.title !== undefined) {
                part.title = options.title
              }
              if (options.toolMetadata !== undefined) {
                part.toolMetadata = options.toolMetadata
              }
              part.providerExecuted = anyOptions.providerExecuted ?? part.providerExecuted

              const providerMetadata = anyOptions.providerMetadata
              if (providerMetadata != null) {
                if (options.state === 'output-available' || options.state === 'output-error') {
                  part.resultProviderMetadata = providerMetadata
                } else {
                  part.callProviderMetadata = providerMetadata
                }
              }
            } else {
              state.message.parts.push({
                type: `tool-${options.toolName}`,
                toolCallId: options.toolCallId,
                state: options.state,
                title: options.title,
                ...(options.toolMetadata !== undefined ? { toolMetadata: options.toolMetadata } : {}),
                input: anyOptions.input,
                output: anyOptions.output,
                rawInput: anyOptions.rawInput,
                errorText: anyOptions.errorText,
                providerExecuted: anyOptions.providerExecuted,
                preliminary: anyOptions.preliminary,
                ...(anyOptions.providerMetadata != null &&
                (options.state === 'output-available' || options.state === 'output-error')
                  ? { resultProviderMetadata: anyOptions.providerMetadata }
                  : {}),
                ...(anyOptions.providerMetadata != null &&
                !(options.state === 'output-available' || options.state === 'output-error')
                  ? { callProviderMetadata: anyOptions.providerMetadata }
                  : {})
              } as any)
            }
          }

          function updateDynamicToolPart(options: UpdateToolPartOptions) {
            const part = state.message.parts.find(
              (part) => part.type === 'dynamic-tool' && part.toolCallId === options.toolCallId
            ) as any
            const anyOptions = options as any

            if (part != null) {
              part.state = options.state
              part.toolName = options.toolName
              part.input = anyOptions.input
              part.output = anyOptions.output
              part.errorText = anyOptions.errorText
              part.rawInput = anyOptions.rawInput ?? part.rawInput
              part.preliminary = anyOptions.preliminary
              if (options.title !== undefined) {
                part.title = options.title
              }
              if (options.toolMetadata !== undefined) {
                part.toolMetadata = options.toolMetadata
              }
              part.providerExecuted = anyOptions.providerExecuted ?? part.providerExecuted

              const providerMetadata = anyOptions.providerMetadata
              if (providerMetadata != null) {
                if (options.state === 'output-available' || options.state === 'output-error') {
                  part.resultProviderMetadata = providerMetadata
                } else {
                  part.callProviderMetadata = providerMetadata
                }
              }
            } else {
              state.message.parts.push({
                type: 'dynamic-tool',
                toolName: options.toolName,
                toolCallId: options.toolCallId,
                state: options.state,
                input: anyOptions.input,
                output: anyOptions.output,
                errorText: anyOptions.errorText,
                preliminary: anyOptions.preliminary,
                providerExecuted: anyOptions.providerExecuted,
                title: options.title,
                ...(options.toolMetadata !== undefined ? { toolMetadata: options.toolMetadata } : {}),
                ...(anyOptions.providerMetadata != null &&
                (options.state === 'output-available' || options.state === 'output-error')
                  ? { resultProviderMetadata: anyOptions.providerMetadata }
                  : {}),
                ...(anyOptions.providerMetadata != null &&
                !(options.state === 'output-available' || options.state === 'output-error')
                  ? { callProviderMetadata: anyOptions.providerMetadata }
                  : {})
              } as any)
            }
          }

          async function updateMessageMetadata(metadata: unknown) {
            if (metadata != null) {
              const mergedMetadata =
                state.message.metadata != null ? mergeObjects(state.message.metadata, metadata) : metadata
              if (messageMetadataSchema != null) {
                await validateTypes({
                  value: mergedMetadata,
                  schema: messageMetadataSchema,
                  context: {
                    field: 'message.metadata',
                    entityId: state.message.id
                  }
                })
              }
              state.message.metadata = mergedMetadata
            }
          }

          switch (chunk.type) {
            case 'text-start': {
              const textPart = {
                type: 'text',
                text: '',
                providerMetadata: chunk.providerMetadata,
                state: 'streaming'
              } as any
              state.activeTextParts[chunk.id] = textPart
              state.message.parts.push(textPart)
              write()
              break
            }
            case 'text-delta': {
              const textPart = state.activeTextParts[chunk.id]
              if (textPart == null) {
                throw new UIMessageStreamError({
                  chunkType: 'text-delta',
                  chunkId: chunk.id,
                  message: `Received text-delta for missing text part with ID "${chunk.id}". Ensure a "text-start" chunk is sent before any "text-delta" chunks.`
                })
              }
              ;(textPart as any).text += chunk.delta
              ;(textPart as any).providerMetadata = chunk.providerMetadata ?? textPart.providerMetadata
              write()
              break
            }
            case 'text-end': {
              const textPart = state.activeTextParts[chunk.id]
              if (textPart == null) {
                throw new UIMessageStreamError({
                  chunkType: 'text-end',
                  chunkId: chunk.id,
                  message: `Received text-end for missing text part with ID "${chunk.id}". Ensure a "text-start" chunk is sent before any "text-end" chunks.`
                })
              }
              ;(textPart as any).state = 'done'
              ;(textPart as any).providerMetadata = chunk.providerMetadata ?? textPart.providerMetadata
              delete state.activeTextParts[chunk.id]
              write()
              break
            }
            case 'reasoning-start': {
              const reasoningPart = {
                type: 'reasoning',
                text: '',
                providerMetadata: chunk.providerMetadata,
                state: 'streaming'
              } as any
              state.activeReasoningParts[chunk.id] = reasoningPart
              state.message.parts.push(reasoningPart)
              write()
              break
            }
            case 'reasoning-delta': {
              const reasoningPart = state.activeReasoningParts[chunk.id]
              if (reasoningPart == null) {
                throw new UIMessageStreamError({
                  chunkType: 'reasoning-delta',
                  chunkId: chunk.id,
                  message: `Received reasoning-delta for missing reasoning part with ID "${chunk.id}". Ensure a "reasoning-start" chunk is sent before any "reasoning-delta" chunks.`
                })
              }
              ;(reasoningPart as any).text += chunk.delta
              ;(reasoningPart as any).providerMetadata = chunk.providerMetadata ?? reasoningPart.providerMetadata
              write()
              break
            }
            case 'reasoning-end': {
              const reasoningPart = state.activeReasoningParts[chunk.id]
              if (reasoningPart == null) {
                throw new UIMessageStreamError({
                  chunkType: 'reasoning-end',
                  chunkId: chunk.id,
                  message: `Received reasoning-end for missing reasoning part with ID "${chunk.id}". Ensure a "reasoning-start" chunk is sent before any "reasoning-end" chunks.`
                })
              }
              ;(reasoningPart as any).providerMetadata = chunk.providerMetadata ?? reasoningPart.providerMetadata
              ;(reasoningPart as any).state = 'done'
              delete state.activeReasoningParts[chunk.id]
              write()
              break
            }
            case 'file': {
              state.message.parts.push({
                type: 'file',
                mediaType: chunk.mediaType,
                url: chunk.url,
                ...(chunk.providerMetadata != null ? { providerMetadata: chunk.providerMetadata } : {})
              } as any)
              write()
              break
            }
            case 'source-url': {
              state.message.parts.push({
                type: 'source-url',
                sourceId: chunk.sourceId,
                url: chunk.url,
                title: chunk.title,
                providerMetadata: chunk.providerMetadata
              } as any)
              write()
              break
            }
            case 'source-document': {
              state.message.parts.push({
                type: 'source-document',
                sourceId: chunk.sourceId,
                mediaType: chunk.mediaType,
                title: chunk.title,
                filename: chunk.filename,
                providerMetadata: chunk.providerMetadata
              } as any)
              write()
              break
            }
            case 'tool-input-start': {
              const toolInvocations = state.message.parts.filter(isStaticToolUIPart)
              state.partialToolCalls[chunk.toolCallId] = {
                text: '',
                toolName: chunk.toolName,
                index: toolInvocations.length,
                dynamic: chunk.dynamic,
                title: chunk.title,
                toolMetadata: chunk.toolMetadata
              }

              if (chunk.dynamic) {
                updateDynamicToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  state: 'input-streaming',
                  input: undefined,
                  providerExecuted: chunk.providerExecuted,
                  title: chunk.title,
                  toolMetadata: chunk.toolMetadata,
                  providerMetadata: chunk.providerMetadata
                })
              } else {
                updateToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  state: 'input-streaming',
                  input: undefined,
                  providerExecuted: chunk.providerExecuted,
                  title: chunk.title,
                  toolMetadata: chunk.toolMetadata,
                  providerMetadata: chunk.providerMetadata
                })
              }
              write()
              break
            }
            case 'tool-input-delta': {
              const partialToolCall = state.partialToolCalls[chunk.toolCallId]
              if (partialToolCall == null) {
                throw new UIMessageStreamError({
                  chunkType: 'tool-input-delta',
                  chunkId: chunk.toolCallId,
                  message: `Received tool-input-delta for missing tool call with ID "${chunk.toolCallId}". Ensure a "tool-input-start" chunk is sent before any "tool-input-delta" chunks.`
                })
              }
              partialToolCall.text += chunk.inputTextDelta

              const { value: partialArgs } = await parsePartialJson(partialToolCall.text)

              if (partialToolCall.dynamic) {
                updateDynamicToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: partialToolCall.toolName,
                  state: 'input-streaming',
                  input: partialArgs,
                  title: partialToolCall.title,
                  toolMetadata: partialToolCall.toolMetadata
                })
              } else {
                updateToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: partialToolCall.toolName,
                  state: 'input-streaming',
                  input: partialArgs,
                  title: partialToolCall.title,
                  toolMetadata: partialToolCall.toolMetadata
                })
              }
              write()
              break
            }
            case 'tool-input-available': {
              if (chunk.dynamic) {
                updateDynamicToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  state: 'input-available',
                  input: chunk.input,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  title: chunk.title,
                  toolMetadata: chunk.toolMetadata
                })
              } else {
                updateToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  state: 'input-available',
                  input: chunk.input,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  title: chunk.title,
                  toolMetadata: chunk.toolMetadata
                })
              }
              write()

              if (onToolCall && !chunk.providerExecuted) {
                await onToolCall({
                  toolCall: chunk
                })
              }
              break
            }
            case 'tool-input-error': {
              const existingPart = state.message.parts
                .filter(isToolUIPart)
                .find((p) => p.toolCallId === chunk.toolCallId)
              const isDynamic = existingPart != null ? existingPart.type === 'dynamic-tool' : !!chunk.dynamic
              if (isDynamic) {
                updateDynamicToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  state: 'output-error',
                  input: chunk.input,
                  errorText: chunk.errorText,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  toolMetadata: chunk.toolMetadata
                })
              } else {
                updateToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  state: 'output-error',
                  input: undefined,
                  rawInput: chunk.input,
                  errorText: chunk.errorText,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  toolMetadata: chunk.toolMetadata
                })
              }
              write()
              break
            }
            case 'tool-approval-request': {
              const toolInvocation = getToolInvocation(chunk.toolCallId)
              toolInvocation.state = 'approval-requested'
              toolInvocation.approval = { id: chunk.approvalId }
              write()
              break
            }
            case 'tool-output-denied': {
              const toolInvocation = getToolInvocation(chunk.toolCallId)
              toolInvocation.state = 'output-denied'
              write()
              break
            }
            case 'tool-output-available': {
              const toolInvocation = getToolInvocation(chunk.toolCallId)
              if (toolInvocation.type === 'dynamic-tool') {
                updateDynamicToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: toolInvocation.toolName,
                  state: 'output-available',
                  input: toolInvocation.input,
                  output: chunk.output,
                  preliminary: chunk.preliminary,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  title: toolInvocation.title,
                  toolMetadata: toolInvocation.toolMetadata
                })
              } else {
                updateToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: getStaticToolName(toolInvocation),
                  state: 'output-available',
                  input: toolInvocation.input,
                  output: chunk.output,
                  providerExecuted: chunk.providerExecuted,
                  preliminary: chunk.preliminary,
                  providerMetadata: chunk.providerMetadata,
                  title: toolInvocation.title,
                  toolMetadata: toolInvocation.toolMetadata
                })
              }
              write()
              break
            }
            case 'tool-output-error': {
              const toolInvocation = getToolInvocation(chunk.toolCallId)
              if (toolInvocation.type === 'dynamic-tool') {
                updateDynamicToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: toolInvocation.toolName,
                  state: 'output-error',
                  input: toolInvocation.input,
                  errorText: chunk.errorText,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  title: toolInvocation.title,
                  toolMetadata: toolInvocation.toolMetadata
                })
              } else {
                updateToolPart({
                  toolCallId: chunk.toolCallId,
                  toolName: getStaticToolName(toolInvocation),
                  state: 'output-error',
                  input: toolInvocation.input,
                  rawInput: toolInvocation.rawInput,
                  errorText: chunk.errorText,
                  providerExecuted: chunk.providerExecuted,
                  providerMetadata: chunk.providerMetadata,
                  title: toolInvocation.title,
                  toolMetadata: toolInvocation.toolMetadata
                })
              }
              write()
              break
            }
            case 'start-step': {
              state.message.parts.push({ type: 'step-start' })
              break
            }
            case 'finish-step': {
              state.activeTextParts = {}
              state.activeReasoningParts = {}
              break
            }
            case 'start': {
              if (chunk.messageId != null) {
                ;(state.message as any).id = chunk.messageId
              }
              await updateMessageMetadata(chunk.messageMetadata)
              if (chunk.messageId != null || chunk.messageMetadata != null) {
                write()
              }
              break
            }
            case 'finish': {
              if (chunk.finishReason != null) {
                state.finishReason = chunk.finishReason
              }
              await updateMessageMetadata(chunk.messageMetadata)
              if (chunk.messageMetadata != null) {
                write()
              }
              break
            }
            case 'message-metadata': {
              await updateMessageMetadata(chunk.messageMetadata)
              if (chunk.messageMetadata != null) {
                write()
              }
              break
            }
            case 'error': {
              onError?.(new Error(chunk.errorText))
              break
            }
            default: {
              if (isDataUIMessageChunk(chunk)) {
                if (dataPartSchemas?.[chunk.type] != null) {
                  const partIdx = state.message.parts.findIndex(
                    (p) => 'id' in p && 'data' in p && (p as any).id === (chunk as any).id && p.type === chunk.type
                  )
                  const actualPartIdx = partIdx >= 0 ? partIdx : state.message.parts.length

                  await validateTypes({
                    value: (chunk as any).data,
                    schema: dataPartSchemas[chunk.type],
                    context: {
                      field: `message.parts[${actualPartIdx}].data`,
                      entityName: chunk.type,
                      entityId: (chunk as any).id
                    }
                  })
                }
                const dataChunk = chunk as any
                if (dataChunk.transient) {
                  onData?.(dataChunk)
                  break
                }

                const existingUIPart =
                  dataChunk.id != null
                    ? state.message.parts.find(
                        (chunkArg) => dataChunk.type === chunkArg.type && dataChunk.id === (chunkArg as any).id
                      )
                    : undefined

                if (existingUIPart != null) {
                  ;(existingUIPart as any).data = dataChunk.data
                } else {
                  state.message.parts.push(dataChunk)
                }
                onData?.(dataChunk)
                write()
              }
            }
          }

          controller.enqueue(chunk)
        })
      }
    })
  )
}

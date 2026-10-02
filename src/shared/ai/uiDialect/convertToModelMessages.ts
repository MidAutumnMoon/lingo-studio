/**
 * Vendored from ai@6.0.185 `dist/index.mjs` (src/ui/convert-to-model-messages.ts +
 * src/util/to-json-value.ts) — Phase-2 D3 (docs/plans/2026-09-pi-unification.md). The upstream
 * `ai` dep still serves aiCore.
 */
import { getErrorMessage, type JSONObject, type JSONValue } from '@ai-sdk/provider'
import {
  isNonNullable,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type Tool,
  type ToolResultOutput
} from '@ai-sdk/provider-utils'

import { MessageConversionError } from './errors'
import type { DataUIPart, DynamicToolUIPart, InferUIMessageData, ToolSet, ToolUIPart, UIMessage } from './types'
import { getToolName, isDataUIPart, isFileUIPart, isReasoningUIPart, isTextUIPart, isToolUIPart } from './uiParts'

function toJSONValue(value: unknown): JSONValue {
  return value === undefined ? null : (value as JSONValue)
}

async function createToolModelOutput({
  toolCallId,
  input,
  output,
  tool,
  errorMode
}: {
  toolCallId: string
  input?: unknown
  output: unknown
  tool?: Tool | undefined
  errorMode: 'text' | 'json' | 'none'
}): Promise<ToolResultOutput> {
  if (errorMode === 'text') {
    return { type: 'error-text', value: getErrorMessage(output) }
  } else if (errorMode === 'json') {
    return { type: 'error-json', value: toJSONValue(output) }
  }

  if (tool?.toModelOutput) {
    return await tool.toModelOutput({ toolCallId, input, output })
  }

  return typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: toJSONValue(output) }
}

/**
 * Converts a list of UI messages to a list of model messages.
 */
export async function convertToModelMessages<UI_MESSAGE extends UIMessage>(
  messagesInput: Array<Omit<UI_MESSAGE, 'id'>>,
  options?: {
    tools?: ToolSet
    ignoreIncompleteToolCalls?: boolean
    convertDataPart?: (part: DataUIPart<InferUIMessageData<UI_MESSAGE>>) => TextPart | FilePart | undefined
  }
): Promise<ModelMessage[]> {
  let messages = messagesInput as Array<UI_MESSAGE>

  const modelMessages: ModelMessage[] = []

  if (options?.ignoreIncompleteToolCalls) {
    messages = messages.map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) => !isToolUIPart(part) || (part.state !== 'input-streaming' && part.state !== 'input-available')
      )
    }))
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const textParts = message.parts.filter(isTextUIPart)
        const providerMetadata = textParts.reduce((acc: JSONObject, part) => {
          if (part.providerMetadata != null) {
            return { ...acc, ...part.providerMetadata }
          }
          return acc
        }, {})

        modelMessages.push({
          role: 'system',
          content: textParts.map((part) => part.text).join(''),
          ...(Object.keys(providerMetadata).length > 0
            ? { providerOptions: providerMetadata as Record<string, Record<string, JSONValue>> }
            : {})
        })
        break
      }
      case 'user': {
        modelMessages.push({
          role: 'user',
          content: message.parts
            .map((part): TextPart | FilePart | undefined => {
              if (isTextUIPart(part)) {
                return {
                  type: 'text',
                  text: part.text,
                  ...(part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {})
                }
              }
              if (isFileUIPart(part)) {
                return {
                  type: 'file',
                  mediaType: part.mediaType,
                  filename: part.filename,
                  data: part.url,
                  ...(part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {})
                }
              }
              if (isDataUIPart(part)) {
                return options?.convertDataPart?.(part as DataUIPart<InferUIMessageData<UI_MESSAGE>>)
              }
              return undefined
            })
            .filter(isNonNullable)
        })
        break
      }
      case 'assistant': {
        if (message.parts != null) {
          let block: Array<any> = []

          async function processBlock() {
            if (block.length === 0) {
              return
            }

            const content: Array<any> = []

            for (const part of block) {
              if (isTextUIPart(part)) {
                content.push({
                  type: 'text',
                  text: part.text,
                  ...(part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {})
                })
              } else if (isFileUIPart(part)) {
                content.push({
                  type: 'file',
                  mediaType: part.mediaType,
                  filename: part.filename,
                  data: part.url,
                  ...(part.providerMetadata != null ? { providerOptions: part.providerMetadata } : {})
                })
              } else if (isReasoningUIPart(part)) {
                content.push({
                  type: 'reasoning',
                  text: part.text,
                  providerOptions: part.providerMetadata
                })
              } else if (isToolUIPart(part)) {
                const toolName = getToolName(part)

                if (part.state !== 'input-streaming') {
                  content.push({
                    type: 'tool-call',
                    toolCallId: part.toolCallId,
                    toolName,
                    input:
                      part.state === 'output-error'
                        ? (part.input ?? ('rawInput' in part ? part.rawInput : undefined))
                        : part.input,
                    providerExecuted: part.providerExecuted,
                    ...(part.callProviderMetadata != null ? { providerOptions: part.callProviderMetadata } : {})
                  })

                  if (part.approval != null) {
                    content.push({
                      type: 'tool-approval-request',
                      approvalId: part.approval.id,
                      toolCallId: part.toolCallId
                    })
                  }

                  if (
                    part.providerExecuted === true &&
                    part.state !== 'approval-responded' &&
                    (part.state === 'output-available' || part.state === 'output-error')
                  ) {
                    const resultProviderMetadata = part.resultProviderMetadata ?? part.callProviderMetadata

                    content.push({
                      type: 'tool-result',
                      toolCallId: part.toolCallId,
                      toolName,
                      output: await createToolModelOutput({
                        toolCallId: part.toolCallId,
                        input: part.input,
                        output: part.state === 'output-error' ? part.errorText : part.output,
                        tool: options?.tools?.[toolName] as Tool | undefined,
                        errorMode: part.state === 'output-error' ? 'json' : 'none'
                      }),
                      ...(resultProviderMetadata != null ? { providerOptions: resultProviderMetadata } : {})
                    })
                  }
                }
              } else if (isDataUIPart(part)) {
                const dataPart = options?.convertDataPart?.(part as DataUIPart<InferUIMessageData<UI_MESSAGE>>)
                if (dataPart != null) {
                  content.push(dataPart)
                }
              } else {
                const _exhaustiveCheck = part
                throw new Error(`Unsupported part: ${_exhaustiveCheck}`)
              }
            }

            modelMessages.push({
              role: 'assistant',
              content
            })

            const toolParts = block.filter((part) => {
              return isToolUIPart(part) && (part.providerExecuted !== true || part.approval?.approved != null)
            })

            if (toolParts.length > 0) {
              const toolContent: Array<any> = []

              for (const toolPart of toolParts as Array<ToolUIPart | DynamicToolUIPart>) {
                if (toolPart.approval?.approved != null) {
                  toolContent.push({
                    type: 'tool-approval-response',
                    approvalId: toolPart.approval.id,
                    approved: toolPart.approval.approved,
                    reason: toolPart.approval.reason,
                    providerExecuted: toolPart.providerExecuted
                  })
                }

                if (toolPart.providerExecuted === true) {
                  continue
                }

                switch (toolPart.state) {
                  case 'output-denied': {
                    toolContent.push({
                      type: 'tool-result',
                      toolCallId: toolPart.toolCallId,
                      toolName: getToolName(toolPart),
                      output: {
                        type: 'error-text',
                        value: toolPart.approval?.reason ?? 'Tool execution denied.'
                      },
                      ...(toolPart.callProviderMetadata != null
                        ? { providerOptions: toolPart.callProviderMetadata }
                        : {})
                    })
                    break
                  }
                  case 'output-error':
                  case 'output-available': {
                    const toolName = getToolName(toolPart)
                    toolContent.push({
                      type: 'tool-result',
                      toolCallId: toolPart.toolCallId,
                      toolName,
                      output: await createToolModelOutput({
                        toolCallId: toolPart.toolCallId,
                        input: toolPart.input,
                        output: toolPart.state === 'output-error' ? toolPart.errorText : toolPart.output,
                        tool: options?.tools?.[toolName] as Tool | undefined,
                        errorMode: toolPart.state === 'output-error' ? 'text' : 'none'
                      }),
                      ...(toolPart.callProviderMetadata != null
                        ? { providerOptions: toolPart.callProviderMetadata }
                        : {})
                    })
                    break
                  }
                }
              }

              if (toolContent.length > 0) {
                modelMessages.push({
                  role: 'tool',
                  content: toolContent
                })
              }
            }

            block = []
          }

          for (const part of message.parts) {
            if (
              isTextUIPart(part) ||
              isReasoningUIPart(part) ||
              isFileUIPart(part) ||
              isToolUIPart(part) ||
              isDataUIPart(part)
            ) {
              block.push(part)
            } else if (part.type === 'step-start') {
              await processBlock()
            }
          }
          await processBlock()
        }
        break
      }
      default: {
        const _exhaustiveCheck = message.role
        throw new MessageConversionError({
          originalMessage: message,
          message: `Unsupported role: ${_exhaustiveCheck}`
        })
      }
    }
  }

  return modelMessages
}

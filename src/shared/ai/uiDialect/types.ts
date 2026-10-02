/**
 * Vendored from ai@6.0.185 `dist/index.d.ts` (UIMessage/UIMessageChunk families) — Phase-2 D3
 * (docs/plans/2026-09-pi-unification.md): the wire format of `ai.stream.*`, the DB column and the
 * gateway SSE keeps its exact structural shape; the upstream `ai` dep still serves aiCore.
 */
import type { JSONObject, SharedV3ProviderMetadata } from '@ai-sdk/provider'
import type { FlexibleSchema, InferSchema, InferToolInput, InferToolOutput, Tool } from '@ai-sdk/provider-utils'

/**
 * Additional provider-specific metadata. The structure is provider-dependent.
 */
export type ProviderMetadata = SharedV3ProviderMetadata

/**
 * Reasons why a model response finished.
 */
export type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'

/**
 * Create a type from an object with all keys and nested keys set to optional.
 * The helper supports normal objects and schemas (which are resolved automatically).
 * It always recurses into arrays.
 */
type DeepPartial<T> = T extends FlexibleSchema ? DeepPartialInternal<InferSchema<T>> : DeepPartialInternal<T>
type DeepPartialInternal<T> = T extends
  | null
  | undefined
  | string
  | number
  | boolean
  | symbol
  | bigint
  | void
  | Date
  | RegExp
  | ((...arguments_: any[]) => unknown)
  | (new (...arguments_: any[]) => unknown)
  ? T
  : T extends Map<infer KeyType, infer ValueType>
    ? PartialMap<KeyType, ValueType>
    : T extends Set<infer ItemType>
      ? PartialSet<ItemType>
      : T extends ReadonlyMap<infer KeyType, infer ValueType>
        ? PartialReadonlyMap<KeyType, ValueType>
        : T extends ReadonlySet<infer ItemType>
          ? PartialReadonlySet<ItemType>
          : T extends object
            ? T extends ReadonlyArray<infer ItemType>
              ? ItemType[] extends T
                ? readonly ItemType[] extends T
                  ? ReadonlyArray<DeepPartialInternal<ItemType | undefined>>
                  : Array<DeepPartialInternal<ItemType | undefined>>
                : PartialObject<T>
              : PartialObject<T>
            : unknown
type PartialMap<KeyType, ValueType> = {} & Map<DeepPartialInternal<KeyType>, DeepPartialInternal<ValueType>>
type PartialSet<T> = {} & Set<DeepPartialInternal<T>>
type PartialReadonlyMap<KeyType, ValueType> = {} & ReadonlyMap<
  DeepPartialInternal<KeyType>,
  DeepPartialInternal<ValueType>
>
type PartialReadonlySet<T> = {} & ReadonlySet<DeepPartialInternal<T>>
type PartialObject<ObjectType extends object> = {
  [KeyType in keyof ObjectType]?: DeepPartialInternal<ObjectType[KeyType]>
}

type ValueOf<ObjectType, ValueType extends keyof ObjectType = keyof ObjectType> = ObjectType[ValueType]

/**
 * The data types that can be used in the UI message for the UI message data parts.
 */
export type UIDataTypes = Record<string, unknown>

export type UITool = {
  input: unknown
  output: unknown | undefined
}

/**
 * Infer the input and output types of a tool so it can be used as a UI tool.
 */
type InferUITool<TOOL extends Tool> = {
  input: InferToolInput<TOOL>
  output: InferToolOutput<TOOL>
}

/**
 * Infer the input and output types of a tool set so it can be used as a UI tool set.
 */
type InferUITools<TOOLS extends ToolSet> = {
  [NAME in keyof TOOLS & string]: InferUITool<TOOLS[NAME]>
}

export type UITools = Record<string, UITool>

/**
 * AI SDK UI Messages. They are used in the client and to communicate between the frontend and the API routes.
 */
export interface UIMessage<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools
> {
  /**
   * A unique identifier for the message.
   */
  id: string
  /**
   * The role of the message.
   */
  role: 'system' | 'user' | 'assistant'
  /**
   * The metadata of the message.
   */
  metadata?: METADATA
  /**
   * The parts of the message. Use this for rendering the message in the UI.
   *
   * System messages should be avoided (set the system prompt on the server instead).
   * They can have text parts.
   *
   * User messages can have text parts and file parts.
   *
   * Assistant messages can have text, reasoning, tool invocation, and file parts.
   */
  parts: Array<UIMessagePart<DATA_PARTS, TOOLS>>
}

export type UIMessagePart<DATA_TYPES extends UIDataTypes, TOOLS extends UITools> =
  | TextUIPart
  | ReasoningUIPart
  | ToolUIPart<TOOLS>
  | DynamicToolUIPart
  | SourceUrlUIPart
  | SourceDocumentUIPart
  | FileUIPart
  | DataUIPart<DATA_TYPES>
  | StepStartUIPart

/**
 * A text part of a message.
 */
export type TextUIPart = {
  type: 'text'
  /**
   * The text content.
   */
  text: string
  /**
   * The state of the text part.
   */
  state?: 'streaming' | 'done'
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata
}

/**
 * A reasoning part of a message.
 */
export type ReasoningUIPart = {
  type: 'reasoning'
  /**
   * The reasoning text.
   */
  text: string
  /**
   * The state of the reasoning part.
   */
  state?: 'streaming' | 'done'
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata
}

/**
 * A source part of a message.
 */
export type SourceUrlUIPart = {
  type: 'source-url'
  sourceId: string
  url: string
  title?: string
  providerMetadata?: ProviderMetadata
}

/**
 * A document source part of a message.
 */
export type SourceDocumentUIPart = {
  type: 'source-document'
  sourceId: string
  mediaType: string
  title: string
  filename?: string
  providerMetadata?: ProviderMetadata
}

/**
 * A file part of a message.
 */
export type FileUIPart = {
  type: 'file'
  /**
   * IANA media type of the file.
   *
   * @see https://www.iana.org/assignments/media-types/media-types.xhtml
   */
  mediaType: string
  /**
   * Optional filename of the file.
   */
  filename?: string
  /**
   * The URL of the file.
   * It can either be a URL to a hosted file or a [Data URL](https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/Data_URLs).
   */
  url: string
  /**
   * The provider metadata.
   */
  providerMetadata?: ProviderMetadata
}

/**
 * A step boundary part of a message.
 */
export type StepStartUIPart = {
  type: 'step-start'
}

export type DataUIPart<DATA_TYPES extends UIDataTypes> = ValueOf<{
  [NAME in keyof DATA_TYPES & string]: {
    type: `data-${NAME}`
    id?: string
    data: DATA_TYPES[NAME]
  }
}>

type asUITool<TOOL extends UITool | Tool> = TOOL extends Tool ? InferUITool<TOOL> : TOOL

/**
 * A UI tool invocation contains all the information needed to render a tool invocation in the UI.
 * It can be derived from a tool without knowing the tool name, and can be used to define
 * UI components for the tool.
 */
export type UIToolInvocation<TOOL extends UITool | Tool> = {
  /**
   * ID of the tool call.
   */
  toolCallId: string
  title?: string
  toolMetadata?: JSONObject
  /**
   * Whether the tool call was executed by the provider.
   */
  providerExecuted?: boolean
} & (
  | {
      state: 'input-streaming'
      input: DeepPartial<asUITool<TOOL>['input']> | undefined
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval?: never
    }
  | {
      state: 'input-available'
      input: asUITool<TOOL>['input']
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval?: never
    }
  | {
      state: 'approval-requested'
      input: asUITool<TOOL>['input']
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval: {
        id: string
        approved?: never
        reason?: never
      }
    }
  | {
      state: 'approval-responded'
      input: asUITool<TOOL>['input']
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval: {
        id: string
        approved: boolean
        reason?: string
      }
    }
  | {
      state: 'output-available'
      input: asUITool<TOOL>['input']
      output: asUITool<TOOL>['output']
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      resultProviderMetadata?: ProviderMetadata
      preliminary?: boolean
      approval?: {
        id: string
        approved: true
        reason?: string
      }
    }
  | {
      state: 'output-error'
      input: asUITool<TOOL>['input'] | undefined
      rawInput?: unknown
      output?: never
      errorText: string
      callProviderMetadata?: ProviderMetadata
      resultProviderMetadata?: ProviderMetadata
      approval?: {
        id: string
        approved: true
        reason?: string
      }
    }
  | {
      state: 'output-denied'
      input: asUITool<TOOL>['input']
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval: {
        id: string
        approved: false
        reason?: string
      }
    }
)

export type ToolUIPart<TOOLS extends UITools = UITools> = ValueOf<{
  [NAME in keyof TOOLS & string]: {
    type: `tool-${NAME}`
  } & UIToolInvocation<TOOLS[NAME]>
}>

export type DynamicToolUIPart = {
  type: 'dynamic-tool'
  /**
   * Name of the tool that is being called.
   */
  toolName: string
  /**
   * ID of the tool call.
   */
  toolCallId: string
  title?: string
  toolMetadata?: JSONObject
  /**
   * Whether the tool call was executed by the provider.
   */
  providerExecuted?: boolean
} & (
  | {
      state: 'input-streaming'
      input: unknown | undefined
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval?: never
    }
  | {
      state: 'input-available'
      input: unknown
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval?: never
    }
  | {
      state: 'approval-requested'
      input: unknown
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval: {
        id: string
        approved?: never
        reason?: never
      }
    }
  | {
      state: 'approval-responded'
      input: unknown
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval: {
        id: string
        approved: boolean
        reason?: string
      }
    }
  | {
      state: 'output-available'
      input: unknown
      output: unknown
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      resultProviderMetadata?: ProviderMetadata
      preliminary?: boolean
      approval?: {
        id: string
        approved: true
        reason?: string
      }
    }
  | {
      state: 'output-error'
      input: unknown
      output?: never
      errorText: string
      callProviderMetadata?: ProviderMetadata
      resultProviderMetadata?: ProviderMetadata
      approval?: {
        id: string
        approved: true
        reason?: string
      }
    }
  | {
      state: 'output-denied'
      input: unknown
      output?: never
      errorText?: never
      callProviderMetadata?: ProviderMetadata
      approval: {
        id: string
        approved: false
        reason?: string
      }
    }
)

export type InferUIMessageMetadata<T extends UIMessage> = T extends UIMessage<infer METADATA> ? METADATA : unknown
export type InferUIMessageData<T extends UIMessage> =
  T extends UIMessage<unknown, infer DATA_TYPES> ? DATA_TYPES : UIDataTypes
export type InferUIMessageTools<T extends UIMessage> =
  T extends UIMessage<unknown, UIDataTypes, infer TOOLS> ? TOOLS : UITools

export type DataUIMessageChunk<DATA_TYPES extends UIDataTypes> = ValueOf<{
  [NAME in keyof DATA_TYPES & string]: {
    type: `data-${NAME}`
    id?: string
    data: DATA_TYPES[NAME]
    transient?: boolean
  }
}>

export type UIMessageChunk<METADATA = unknown, DATA_TYPES extends UIDataTypes = UIDataTypes> =
  | {
      type: 'text-start'
      id: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'text-delta'
      delta: string
      id: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'text-end'
      id: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'reasoning-start'
      id: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'reasoning-delta'
      id: string
      delta: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'reasoning-end'
      id: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'error'
      errorText: string
    }
  | {
      type: 'tool-input-available'
      toolCallId: string
      toolName: string
      input: unknown
      providerExecuted?: boolean
      providerMetadata?: ProviderMetadata
      toolMetadata?: JSONObject
      dynamic?: boolean
      title?: string
    }
  | {
      type: 'tool-input-error'
      toolCallId: string
      toolName: string
      input: unknown
      providerExecuted?: boolean
      providerMetadata?: ProviderMetadata
      toolMetadata?: JSONObject
      dynamic?: boolean
      errorText: string
      title?: string
    }
  | {
      type: 'tool-approval-request'
      approvalId: string
      toolCallId: string
    }
  | {
      type: 'tool-output-available'
      toolCallId: string
      output: unknown
      providerExecuted?: boolean
      providerMetadata?: ProviderMetadata
      toolMetadata?: JSONObject
      dynamic?: boolean
      preliminary?: boolean
    }
  | {
      type: 'tool-output-error'
      toolCallId: string
      errorText: string
      providerExecuted?: boolean
      providerMetadata?: ProviderMetadata
      toolMetadata?: JSONObject
      dynamic?: boolean
    }
  | {
      type: 'tool-output-denied'
      toolCallId: string
    }
  | {
      type: 'tool-input-start'
      toolCallId: string
      toolName: string
      providerExecuted?: boolean
      providerMetadata?: ProviderMetadata
      toolMetadata?: JSONObject
      dynamic?: boolean
      title?: string
    }
  | {
      type: 'tool-input-delta'
      toolCallId: string
      inputTextDelta: string
    }
  | {
      type: 'source-url'
      sourceId: string
      url: string
      title?: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'source-document'
      sourceId: string
      mediaType: string
      title: string
      filename?: string
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'file'
      url: string
      mediaType: string
      providerMetadata?: ProviderMetadata
    }
  | DataUIMessageChunk<DATA_TYPES>
  | {
      type: 'start-step'
    }
  | {
      type: 'finish-step'
    }
  | {
      type: 'start'
      messageId?: string
      messageMetadata?: METADATA
    }
  | {
      type: 'finish'
      finishReason?: FinishReason
      messageMetadata?: METADATA
    }
  | {
      type: 'abort'
      reason?: string
    }
  | {
      type: 'message-metadata'
      messageMetadata: METADATA
    }

export type InferUIMessageChunk<T extends UIMessage> = UIMessageChunk<InferUIMessageMetadata<T>, InferUIMessageData<T>>

/**
 * A chunk of a UI message stream. Used by the accumulator's transform pass-through.
 */
export type UIMessageStreamJobExecutor = <RESULT>(
  job: (options: { state: StreamingUIMessageState; write: () => void }) => PromiseLike<RESULT> | RESULT
) => PromiseLike<RESULT> | RESULT

/**
 * Mutable accumulator state for a streaming assistant message.
 */
export interface StreamingUIMessageState<UI_MESSAGE extends UIMessage = UIMessage> {
  message: UI_MESSAGE
  activeTextParts: Record<string, TextUIPart>
  activeReasoningParts: Record<string, ReasoningUIPart>
  partialToolCalls: Record<
    string,
    {
      text: string
      toolName: string
      index: number
      dynamic: boolean | undefined
      title: string | undefined
      toolMetadata: JSONObject | undefined
    }
  >
  finishReason?: FinishReason
}

/**
 * A tool set. Used by `convertToModelMessages` options and `InferUITools`.
 */
export type ToolSet = Record<
  string,
  (Tool<never, never> | Tool<any, any> | Tool<any, never> | Tool<never, any>) &
    Pick<Tool<any, any>, 'execute' | 'onInputAvailable' | 'onInputStart' | 'onInputDelta' | 'needsApproval'>
>

export type { InferUITool, InferUITools }

/**
 * A `ReadableStream` that is also an `AsyncIterable`.
 */
export type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>

// ── ai@6 usage/metadata aliases (`ai` defines these V3-era names itself; the
// provider packages only export the V2 shapes) ──

export type LanguageModelUsage = {
  inputTokens: number | undefined
  inputTokenDetails: {
    noCacheTokens: number | undefined
    cacheReadTokens: number | undefined
    cacheWriteTokens: number | undefined
  }
  outputTokens: number | undefined
  outputTokenDetails: {
    textTokens: number | undefined
    reasoningTokens: number | undefined
  }
  totalTokens: number | undefined
  /** @deprecated Use outputTokenDetails.reasoningTokens instead. */
  reasoningTokens?: number | undefined
  /** @deprecated Use inputTokenDetails.cacheReadTokens instead. */
  cachedInputTokens?: number | undefined
  /** Raw usage in the shape the provider returned. */
  raw?: JSONObject
}

export type EmbeddingModelUsage = {
  tokens: number
}

export type LanguageModelResponseMetadata = {
  id: string
  timestamp: Date
  modelId: string
  /** Response headers (available only for providers that use HTTP requests). */
  headers?: Record<string, string>
}

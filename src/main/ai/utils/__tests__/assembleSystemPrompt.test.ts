import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolEntry } from '@main/ai/tools/adapters/aiSdk/types'
import type { NeutralTool } from '@main/ai/tools/neutralTool'
import type { ToolSet } from '@shared/ai/uiDialect'
import type { Assistant } from '@shared/data/types/assistant'
import type { Model, UniqueModelId } from '@shared/data/types/model'

vi.mock('@main/utils/prompt', () => ({
  replacePromptVariables: vi.fn(async (input: string) => input.replace('{{date}}', '2026-04-20'))
}))

import { assembleSystemPrompt, getDeferredToolsSystemPrompt } from '../assembleSystemPrompt'

function makeAssistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    prompt: 'hello',
    mcpServerIds: [],
    settings: {
      temperature: 1,
      enableTemperature: false,
      topP: 1,
      enableTopP: false,
      maxTokens: 4096,
      enableMaxTokens: false,
      reasoning_effort: 'default',
      mcpMode: 'auto',
      maxToolCalls: 20,
      enableMaxToolCalls: true,
      enableWebSearch: false,
      customParameters: []
    },
    ...overrides
  } as Assistant
}

const model = { id: 'openai::gpt-4' as UniqueModelId, providerId: 'openai', name: 'GPT-4' } as Model

describe('assembleSystemPrompt', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined when no section contributes text', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: '' }),
      model
    })
    expect(out).toBeUndefined()
  })

  it('returns undefined when no assistant is supplied and tools are absent', async () => {
    expect(await assembleSystemPrompt({ model })).toBeUndefined()
  })

  it('resolves template variables in assistant.prompt', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'Today is {{date}}' }),
      model
    })
    expect(out).toBe('Today is 2026-04-20')
  })

  it('returns just the assistant prompt when no tool_search is present, regardless of mcpMode', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base', settings: { ...makeAssistant().settings, mcpMode: 'auto' } }),
      model
    })
    expect(out).toBe('base')
  })

  it('appends deferred-tools workflow guidance when tools includes tool_search', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { tool_search: {} } as unknown as ToolSet
    })
    expect(out).toContain('base')
    expect(out).toContain('<deferred-tools>')
    expect(out).toContain('</deferred-tools>')
    expect(out).toContain('tool_invoke')
    // tool_exec is intentionally NOT advertised to the model (privilege-escalation surface).
    expect(out).not.toContain('tool_exec')
  })

  it('lists deferred namespaces with counts when deferredEntries is supplied', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { tool_search: {} } as unknown as ToolSet,
      deferredEntries: [
        { name: 'mcp__gh__a', namespace: 'mcp:gh' },
        { name: 'mcp__gh__b', namespace: 'mcp:gh' },
        { name: 'mcp__gmail__c', namespace: 'mcp:gmail' }
      ] as never
    })
    expect(out).toContain('<namespaces>')
    expect(out).toContain('<namespace name="mcp:gh" count="2"/>')
    expect(out).toContain('<namespace name="mcp:gmail" count="1"/>')
  })

  it('does not append deferred-tools guidance when tool_search is absent', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { other_tool: {} } as unknown as ToolSet
    })
    expect(out).toBe('base')
  })

  it('appends citation guidance when web_search is an inline tool', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { web_search: {} } as unknown as ToolSet,
      hasCitableTools: true
    })
    expect(out).toContain('<citations>')
    expect(out).toContain('[cite:ID]')
  })

  it('appends citation guidance when kb_search is the only citable tool', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { kb_search: {} } as unknown as ToolSet,
      hasCitableTools: true
    })
    expect(out).toContain('<citations>')
  })

  it('appends citation guidance when kb_read is the only citable tool', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { kb_read: {} } as unknown as ToolSet,
      hasCitableTools: true
    })
    expect(out).toContain('<citations>')
  })

  it('appends citation guidance when web tools are only available deferred', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { tool_search: {} } as unknown as ToolSet,
      deferredEntries: [{ name: 'web_search', namespace: 'web' }] as never,
      hasCitableTools: true
    })
    expect(out).toContain('<citations>')
  })

  it('does not append citation guidance without a citable tool', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { other_tool: {}, kb_list: {} } as unknown as ToolSet
    })
    expect(out).toBe('base')
  })

  it('does not infer citation capability from a same-named final tool', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      tools: { web_search: {} } as unknown as ToolSet,
      hasCitableTools: false
    })
    expect(out).toBe('base')
  })

  it('anchors relative dates to the runtime local date when web search is enabled', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      webSearchEnabled: true,
      now: new Date(2026, 7, 20, 23, 59)
    })

    expect(out).toContain('<current-date>2026-08-20</current-date>')
    expect(out).toContain('this month')
    expect(out).toContain('Do not substitute dates remembered from training')
  })

  it('does not add volatile date context when web search is unavailable', async () => {
    const out = await assembleSystemPrompt({
      assistant: makeAssistant({ prompt: 'base' }),
      model,
      webSearchEnabled: false,
      now: new Date(2026, 7, 20)
    })

    expect(out).toBe('base')
  })
})

describe('getDeferredToolsSystemPrompt', () => {
  const entry = (overrides: Partial<ToolEntry>): ToolEntry => ({
    name: 'mcp__gmail__send_0123456789abcdef0123',
    namespace: 'mcp:11111111-2222-3333-4444-555555555555',
    description: 'send mail',
    defer: 'auto',
    tool: {} as NeutralTool,
    ...overrides
  })

  it('lists the namespace label instead of the opaque ownership key', () => {
    const prompt = getDeferredToolsSystemPrompt([entry({ namespaceLabel: 'mcp:Gmail' })])

    expect(prompt).toContain('<namespace name="mcp:Gmail" count="1"/>')
    expect(prompt).not.toContain('11111111-2222-3333-4444-555555555555')
  })

  it('falls back to the namespace when no label is set', () => {
    const prompt = getDeferredToolsSystemPrompt([entry({ name: 'web_search', namespace: 'web' })])

    expect(prompt).toContain('<namespace name="web" count="1"/>')
  })
})

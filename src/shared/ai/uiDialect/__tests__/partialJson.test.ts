import { parsePartialJson as aiParsePartialJson } from 'ai'
import { describe, expect, it } from 'vitest'

import { parsePartialJson } from '../partialJson'

/**
 * Contract: the vendored partial-JSON repair (upstream src/util/fix-json.ts) behaves exactly like
 * the `ai` package's — it feeds tool-input-delta accumulation, so divergence here would change
 * tool input snapshots mid-stream.
 */
describe('parsePartialJson — vendored parity with ai@6.0.185', () => {
  const fragments = [
    '',
    '{',
    '{"query"',
    '{"query": "cats", "limit',
    '{"query": "cats", "limit": 3, "nested": {"a": [1, 2, tru',
    '{"query": "ca',
    '[1, 2, {"a": "b",',
    '[{"x": 1}, {"y": fals',
    '{"a": {"b": {"c": ["deeper',
    'true',
    'null',
    '"just a string',
    '42',
    '-12.5e',
    '{"a": 1} trailing',
    '{"esc\\"aped": "val\\',
    '{"unicode": "\\u00e9\\u00e8',
    '{,}',
    '[,]'
  ]

  it.each(fragments)('fragment %j parses identically to the ai package', async (text) => {
    const ours = await parsePartialJson(text)
    const theirs = await aiParsePartialJson(text)
    expect(ours).toEqual(theirs)
  })

  it('returns repaired objects for streaming tool args', async () => {
    const { value, state } = await parsePartialJson('{"query": "cats", "limit')
    expect(state).toBe('repaired-parse')
    expect(value).toEqual({ query: 'cats' })
  })

  it('reports failed-parse for garbage', async () => {
    const { value, state } = await parsePartialJson('{,}')
    expect(state).toBe('failed-parse')
    expect(value).toBeUndefined()
  })
})

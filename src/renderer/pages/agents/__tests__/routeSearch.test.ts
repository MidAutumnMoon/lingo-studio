import { describe, expect, it } from 'vitest'

import { parseAgentRouteSearch } from '../routeSearch'

describe('parseAgentRouteSearch', () => {
  it('parses the sidebar agentId for pinned entity entries', () => {
    expect(parseAgentRouteSearch({ agentId: 'agent-1' })).toEqual({
      agentId: 'agent-1',
      sessionId: undefined
    })
  })

  it('keeps agentId alongside an explicit session', () => {
    expect(parseAgentRouteSearch({ agentId: 'agent-1', sessionId: 'session-1', forkReturnSessionId: 'child' })).toEqual(
      {
        agentId: 'agent-1',
        sessionId: 'session-1',
        forkReturnSessionId: 'child'
      }
    )
  })

  it('keeps the session of a tab restored with the legacy message-only view param', () => {
    expect(parseAgentRouteSearch({ sessionId: 'session-1', view: 'message' })).toEqual({
      agentId: undefined,
      sessionId: 'session-1'
    })
  })

  it('drops non-string agentId values', () => {
    expect(parseAgentRouteSearch({ agentId: 7 })).toEqual({
      agentId: undefined,
      sessionId: undefined
    })
  })
})

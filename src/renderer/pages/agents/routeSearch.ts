export type AgentRouteSearch = {
  agentId?: string
  sessionId?: string
  forkReturnSessionId?: string
}

export function parseAgentRouteSearch(search: Record<string, unknown>): AgentRouteSearch {
  const agentId = typeof search.agentId === 'string' ? search.agentId : undefined
  const sessionId = typeof search.sessionId === 'string' ? search.sessionId : undefined
  const forkReturnSessionId = typeof search.forkReturnSessionId === 'string' ? search.forkReturnSessionId : undefined

  return {
    agentId,
    sessionId,
    ...(forkReturnSessionId ? { forkReturnSessionId } : {})
  }
}

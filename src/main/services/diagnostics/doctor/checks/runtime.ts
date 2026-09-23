import { application } from '@application'
import { agentService } from '@main/data/services/AgentService'
import { providerService } from '@main/data/services/ProviderService'
import { parseUniqueModelId } from '@shared/data/types/model'
import { isExternalCliProvider } from '@shared/utils/provider'

import { defineDoctorCheck } from '../types'

export const claudeLogin = defineDoctorCheck({
  id: 'runtime-claude-login',
  timeoutMs: 20_000,
  async run({ signal }) {
    const needsClaudeLogin = agentService.listAgents().agents.some((agent) => {
      if (agent.type !== 'claude-code' || !agent.model) return false
      const { providerId } = parseUniqueModelId(agent.model)
      return isExternalCliProvider(providerService.getByProviderId(providerId))
    })
    if (!needsClaudeLogin) return { status: 'pass' }
    const cli = application.get('CodeCliService')
    if (!cli.isReady) throw new Error('Code CLI service is not ready')
    if (await cli.checkClaudeLogin(signal)) return { status: 'pass' }

    return {
      status: 'warn',
      attribution: 'user-fixable',
      detail: { variant: 'not_logged_in' },
      actions: [{ kind: 'navigate', target: '/settings/provider?id=claude-code' }],
      devMessage: 'A Claude Code agent is configured but the Claude CLI is not logged in'
    }
  },
  fixes: {}
})

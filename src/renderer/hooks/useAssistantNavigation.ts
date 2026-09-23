import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import { useSidebarActivationGateway } from '@renderer/components/app/sidebarShortcuts'
import { useOwnerResourceActivation } from '@renderer/components/chat/resourceList/useOwnerResourceActivation'
import { useMutation } from '@renderer/data/hooks/useDataApi'
import { toast } from '@renderer/services/toast'
import { resolveChatEntryTopicIdForAssistant } from '@renderer/utils/conversationEntry'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { getSidebarApp } from '@renderer/utils/sidebar'

const logger = loggerService.withContext('useAssistantNavigation')

export type AssistantEntryTarget = {
  id: string
  name: string
  /** Open beside the current tab instead of replacing it. */
  newTab?: boolean
}

/**
 * Opening an assistant means opening its conversation: the most recent topic, or a reusable
 * placeholder when it has none yet (the same rule the chat page applies on a bare entry).
 *
 * This is the one path for callers outside the chat page — the sidebar's assistant list and the
 * sidebar shortcuts — because they cannot reach the page's selection state. The tab URL stays the
 * single identity channel: this only navigates to `?topicId=`, and the chat page reacts to the route.
 */
export function useAssistantNavigation() {
  const { t } = useTranslation()
  const gateway = useSidebarActivationGateway()
  const { trigger: reuseOrCreateTopic } = useMutation('POST', '/topics/reusable-placeholder', {
    refresh: ['/topics']
  })
  // The activation callback only receives the resolved topic id, so the in-flight target keeps the
  // label the tab shows until the chat page titles itself from the topic.
  const requestedTargetRef = useRef<AssistantEntryTarget | null>(null)

  const loadEntryTopicId = useCallback((target: AssistantEntryTarget) => {
    requestedTargetRef.current = target
    return resolveChatEntryTopicIdForAssistant(target.id)
  }, [])

  const createEntryTopicId = useCallback(
    async (target: AssistantEntryTarget) => {
      requestedTargetRef.current = target
      const result = await reuseOrCreateTopic({ body: { assistantId: target.id } })
      return result.topic.id
    },
    [reuseOrCreateTopic]
  )

  const openEntryTopic = useCallback(
    (topicId: string) => {
      const target = requestedTargetRef.current
      gateway.openWorkspace(
        {
          url: getSidebarApp('assistants')!.conversationRoute!.urlForKey(topicId),
          conversation: { conversationType: 'assistant', conversationId: topicId },
          title: target?.name ?? topicId
        },
        { inNewTab: target?.newTab }
      )
    },
    [gateway]
  )

  const handleError = useCallback(
    (error: unknown) => {
      logger.error('Failed to open an assistant conversation', { error })
      toast.error(formatErrorMessageWithPrefix(error, t('common.error')))
    },
    [t]
  )

  const { activateOwnerResource, cancelOwnerResourceActivation } = useOwnerResourceActivation({
    loadResourceForOwner: loadEntryTopicId,
    createResourceForOwner: createEntryTopicId,
    onActivateResource: openEntryTopic,
    onError: handleError
  })

  const openAssistant = useCallback(
    (target: AssistantEntryTarget) => activateOwnerResource(target),
    [activateOwnerResource]
  )

  return { openAssistant, cancelOpenAssistant: cancelOwnerResourceActivation }
}

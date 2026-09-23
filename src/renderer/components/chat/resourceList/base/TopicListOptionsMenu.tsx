import { Bot, History } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ConversationListOptionsMenu } from './ConversationListOptionsMenu'

type TopicListOptionsMenuProps = {
  historyRecordsActive?: boolean
  manageAssistantsActive?: boolean
  onOpenHistoryRecords?: () => void
  /** The assistant library — the only way into it now that the sidebar lists assistants directly. */
  onManageAssistants?: () => void | Promise<void>
}

/**
 * Options for the chat list. The list has one reading order (time buckets scoped to one assistant),
 * so this menu carries only the actions that are not already on the rows themselves.
 */
export function TopicListOptionsMenu({
  historyRecordsActive,
  manageAssistantsActive,
  onOpenHistoryRecords,
  onManageAssistants
}: TopicListOptionsMenuProps) {
  const { t } = useTranslation()

  return (
    <ConversationListOptionsMenu
      title={t('common.more')}
      historyAction={
        onOpenHistoryRecords
          ? {
              active: historyRecordsActive,
              icon: <History size={16} />,
              label: t('history.records.shortTitle'),
              onSelect: onOpenHistoryRecords
            }
          : undefined
      }
      manageAction={
        onManageAssistants
          ? {
              active: manageAssistantsActive,
              icon: <Bot size={16} />,
              label: t('assistants.presets.title'),
              onSelect: onManageAssistants
            }
          : undefined
      }
    />
  )
}

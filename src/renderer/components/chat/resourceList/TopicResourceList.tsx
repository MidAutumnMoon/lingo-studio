import type { ReactNode } from 'react'

import { ResourceList, type ResourceListItemBase } from './base'

type TopicResourceListProps<T extends ResourceListItemBase> = Omit<
  Parameters<typeof ResourceList.Provider<T>>[0],
  'variant'
> & {
  children: ReactNode
}

/** The chat page's conversation list. It lives in the left navigation pane, and nowhere else. */
export function TopicResourceList<T extends ResourceListItemBase>({ children, ...props }: TopicResourceListProps<T>) {
  const Provider = ResourceList.Provider<T>
  const Frame = ResourceList.Frame

  return (
    <Provider {...props} variant="topic">
      <Frame data-ui="chat.topic-list" data-testid="resource-list-topic" presentation="left-panel">
        {children}
      </Frame>
    </Provider>
  )
}

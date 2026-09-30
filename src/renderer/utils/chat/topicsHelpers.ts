import type { Topic } from '@renderer/types/topic'
import {
  compareResourceOrderKey,
  compareResourceRecency,
  composeResourceListGroupResolvers,
  createPinnedGroupResolver,
  createTimeGroupResolver,
  resolveResourceTimeGroup,
  type ResourceListGroup,
  type ResourceListGroupResolver,
  type ResourceListTimeGroupLabels,
  sortRankedResourceItems,
  withResourceListGroupIdPrefix
} from '@renderer/utils/chat/resourceListBase'

/** How the history surfaces read the same topic list: by recency, or grouped under its assistant. */
export type TopicSortMode = 'time' | 'assistant'

export type TopicDisplayGroupLabels = {
  pinned: string
} & ResourceListTimeGroupLabels

export type TopicDisplayTimeGroupOptions = {
  labels: TopicDisplayGroupLabels
  now?: Parameters<typeof resolveResourceTimeGroup>[1]
}

export type TopicDisplaySortOptions = {
  assistantRankById?: ReadonlyMap<string, number>
  mode: TopicSortMode
  now?: Parameters<typeof resolveResourceTimeGroup>[1]
}

export const TOPIC_PINNED_GROUP_ID = 'topic:pinned'

function withTopicGroupIdPrefix<T>(resolver: ResourceListGroupResolver<T>): ResourceListGroupResolver<T> {
  return withResourceListGroupIdPrefix('topic:', resolver)
}

/** Pinned first, then the time ladder the history list reads in. */
export function createTopicTimeGroupResolver<T extends Pick<Topic, 'lastActivityAt' | 'pinned'>>({
  labels,
  now
}: TopicDisplayTimeGroupOptions): ResourceListGroupResolver<T> {
  const pinnedResolver = createPinnedGroupResolver<T>({
    isPinned: (topic) => topic.pinned === true,
    group: { id: 'pinned', label: labels.pinned } satisfies ResourceListGroup
  })

  return withTopicGroupIdPrefix(
    composeResourceListGroupResolvers(
      pinnedResolver,
      createTimeGroupResolver<T>({
        getTimestamp: (topic) => topic.lastActivityAt,
        labels,
        now
      })
    )
  )
}

function getAssistantGroupRank<T extends Pick<Topic, 'assistantId'>>(
  topic: T,
  assistantRankById?: ReadonlyMap<string, number>
) {
  const assistantRank = topic.assistantId ? assistantRankById?.get(topic.assistantId) : undefined
  if (assistantRank !== undefined) {
    return assistantRank
  }

  return Number.MAX_SAFE_INTEGER
}

function readOptionalOrderKey<T extends object>(item: T): string | undefined {
  return 'orderKey' in item && typeof item.orderKey === 'string' ? item.orderKey : undefined
}

export function sortTopicsForDisplayGroups<T extends Pick<Topic, 'assistantId' | 'lastActivityAt' | 'pinned'>>(
  topics: readonly T[],
  options: TopicDisplaySortOptions
): T[] {
  const isPinned = (topic: T) => topic.pinned === true

  if (options.mode === 'assistant') {
    return topics
      .map((topic, index) => ({ topic, index, rank: getAssistantGroupRank(topic, options.assistantRankById) }))
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        if (a.topic.pinned !== b.topic.pinned) return a.topic.pinned ? -1 : 1
        if (a.topic.pinned && b.topic.pinned) return a.index - b.index
        return (
          compareResourceOrderKey(readOptionalOrderKey(a.topic), readOptionalOrderKey(b.topic)) || a.index - b.index
        )
      })
      .map(({ topic }) => topic)
  }

  return sortRankedResourceItems(topics, {
    getRank: (topic) => (topic.pinned === true ? 0 : resolveResourceTimeGroup(topic.lastActivityAt, options.now).rank),
    isPinned,
    compareWithinGroup: compareResourceRecency((topic) => topic.lastActivityAt)
  })
}

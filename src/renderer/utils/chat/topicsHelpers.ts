import type { Topic } from '@renderer/types/topic'
import {
  compareResourceOrderKey,
  compareResourceRecency,
  composeResourceListGroupResolvers,
  createPinnedGroupResolver,
  createTimeGroupResolver,
  getResourceTimeBucket,
  type ResourceListGroup,
  type ResourceListGroupResolver,
  type ResourceListTimeBucket,
  sortRankedResourceItems,
  withResourceListGroupIdPrefix
} from '@renderer/utils/chat/resourceListBase'

/** How the history surfaces read the same topic list: by recency, or grouped under its assistant. */
export type TopicSortMode = 'time' | 'assistant'

export type TopicListGroupKind = 'pinned' | 'time'

export type TopicDisplayGroupLabels = {
  pinned: string
  time: Record<ResourceListTimeBucket, string>
}

export type TopicDisplayTimeGroupOptions = {
  labels: TopicDisplayGroupLabels
  now?: Parameters<typeof getResourceTimeBucket>[1]
}

export type TopicDisplaySortOptions = {
  assistantRankById?: ReadonlyMap<string, number>
  mode: TopicSortMode
  now?: Parameters<typeof getResourceTimeBucket>[1]
}

export type TopicListItem = Topic & {
  name: string
  orderKey?: string
}

const TOPIC_TIME_BUCKET_RANK: Record<ResourceListTimeBucket, number> = {
  today: 1,
  yesterday: 2,
  'this-week': 3,
  earlier: 4
}

export const TOPIC_PINNED_GROUP_ID = 'topic:pinned'
export const TOPIC_UNLINKED_ASSISTANT_GROUP_ID = 'topic:assistant:unknown'

const TOPIC_ASSISTANT_GROUP_ID_PREFIX = 'topic:assistant:'
const TOPIC_UNLINKED_ASSISTANT_RANK = Number.MAX_SAFE_INTEGER

export function groupTopicByPinned(topic: Pick<Topic, 'pinned'>, pinnedLabel: string, topicLabel: string) {
  if (topic.pinned) {
    return { id: 'pinned', label: pinnedLabel }
  }

  return { id: 'topics', label: topicLabel }
}

export function getTopicTimeBucket(
  lastActivityAt: string,
  now?: Parameters<typeof getResourceTimeBucket>[1]
): ResourceListTimeBucket {
  return getResourceTimeBucket(lastActivityAt, now)
}

function withTopicGroupIdPrefix<T>(resolver: ResourceListGroupResolver<T>): ResourceListGroupResolver<T> {
  return withResourceListGroupIdPrefix('topic:', resolver)
}

export function getAssistantIdFromTopicGroupId(groupId: string): string | undefined {
  if (groupId === TOPIC_UNLINKED_ASSISTANT_GROUP_ID || !groupId.startsWith(TOPIC_ASSISTANT_GROUP_ID_PREFIX)) {
    return undefined
  }

  return groupId.slice(TOPIC_ASSISTANT_GROUP_ID_PREFIX.length)
}

/** Pinned first, then the time buckets the history list reads in. */
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
        labels: labels.time,
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

  return TOPIC_UNLINKED_ASSISTANT_RANK
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
    getRank: (topic) =>
      topic.pinned === true ? 0 : TOPIC_TIME_BUCKET_RANK[getTopicTimeBucket(topic.lastActivityAt, options.now)],
    isPinned,
    compareWithinGroup: compareResourceRecency((topic) => topic.lastActivityAt)
  })
}

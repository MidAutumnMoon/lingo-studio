import { describe, expect, it } from 'vitest'

import type { Topic } from '@renderer/types/topic'

import {
  createTopicTimeGroupResolver,
  getTopicTimeBucket,
  groupTopicByPinned,
  sortTopicsForDisplayGroups
} from '../topicsHelpers'

const TOPIC_GROUP_LABELS = {
  pinned: 'Pinned',
  time: {
    today: 'Today',
    yesterday: 'Yesterday',
    'this-week': 'This week',
    earlier: 'Earlier'
  }
}

function localIso(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour).toISOString()
}

function createTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic-1',
    assistantId: 'assistant-1',
    name: 'Topic one',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    pinned: false,
    ...overrides
  }
}

describe('Topics helpers', () => {
  it('groups pinned topics separately for ResourceList rendering', () => {
    expect(groupTopicByPinned(createTopic({ pinned: true }), 'Pinned', 'Topics')).toEqual({
      id: 'pinned',
      label: 'Pinned'
    })
    expect(groupTopicByPinned(createTopic({ pinned: false }), 'Pinned', 'Topics')).toEqual({
      id: 'topics',
      label: 'Topics'
    })
  })

  it('classifies topic lastActivityAt values into reusable time buckets', () => {
    const now = new Date(2026, 4, 15, 12)

    expect(getTopicTimeBucket(localIso(2026, 5, 15, 9), now)).toBe('today')
    expect(getTopicTimeBucket(localIso(2026, 5, 14, 9), now)).toBe('yesterday')
    expect(getTopicTimeBucket(localIso(2026, 5, 13, 9), now)).toBe('this-week')
    expect(getTopicTimeBucket(localIso(2026, 5, 8, 23), now)).toBe('earlier')
  })

  it('builds the history resolver as pinned first, then the named time buckets', () => {
    const now = new Date(2026, 4, 15, 12)
    const groupTopic = createTopicTimeGroupResolver({ labels: TOPIC_GROUP_LABELS, now })

    // Pinned wins over the bucket the topic would otherwise fall into.
    expect(groupTopic(createTopic({ id: 'pinned', pinned: true, lastActivityAt: localIso(2026, 5, 15, 9) }))).toEqual({
      id: 'topic:pinned',
      label: 'Pinned'
    })
    expect(groupTopic(createTopic({ id: 'today', lastActivityAt: localIso(2026, 5, 15, 9) }))).toEqual({
      id: 'topic:time:today',
      label: 'Today'
    })
    expect(groupTopic(createTopic({ id: 'yesterday', lastActivityAt: localIso(2026, 5, 14, 9) }))).toEqual({
      id: 'topic:time:yesterday',
      label: 'Yesterday'
    })
    expect(groupTopic(createTopic({ id: 'week', lastActivityAt: localIso(2026, 5, 13, 9) }))).toEqual({
      id: 'topic:time:this-week',
      label: 'This week'
    })
    expect(groupTopic(createTopic({ id: 'earlier', lastActivityAt: localIso(2026, 5, 8, 23) }))).toEqual({
      id: 'topic:time:earlier',
      label: 'Earlier'
    })
  })

  it('keeps pinned topics stable and sorts time buckets by lastActivityAt descending', () => {
    const now = new Date(2026, 4, 15, 12)
    const topics = [
      createTopic({ id: 'today-old', lastActivityAt: localIso(2026, 5, 15, 8) }),
      createTopic({ id: 'week', lastActivityAt: localIso(2026, 5, 13, 9) }),
      createTopic({ id: 'pinned-old', pinned: true, lastActivityAt: localIso(2026, 5, 8, 23) }),
      createTopic({ id: 'today-new', lastActivityAt: localIso(2026, 5, 15, 9) }),
      createTopic({ id: 'pinned-new', pinned: true, lastActivityAt: localIso(2026, 5, 15, 9) })
    ]

    expect(sortTopicsForDisplayGroups(topics, { mode: 'time', now }).map((topic) => topic.id)).toEqual([
      'pinned-old',
      'pinned-new',
      'today-new',
      'today-old',
      'week'
    ])
  })

  it('sorts assistant groups by rank with pinned topics first inside each assistant', () => {
    const topics = [
      createTopic({ id: 'assistant-b-1', assistantId: 'assistant-b' }),
      createTopic({ id: 'unknown-1', assistantId: 'missing-assistant' }),
      createTopic({ id: 'default-1', assistantId: undefined }),
      createTopic({ id: 'assistant-a-1', assistantId: 'assistant-a' }),
      createTopic({ id: 'pinned-a', assistantId: 'assistant-a', pinned: true }),
      createTopic({ id: 'pinned-b', assistantId: 'assistant-b', pinned: true }),
      createTopic({ id: 'pinned-unknown', assistantId: 'missing-assistant', pinned: true }),
      createTopic({ id: 'assistant-b-2', assistantId: 'assistant-b' })
    ]

    expect(
      sortTopicsForDisplayGroups(topics, {
        assistantRankById: new Map([
          ['assistant-a', 0],
          ['assistant-b', 1]
        ]),
        mode: 'assistant'
      }).map((topic) => topic.id)
    ).toEqual([
      'pinned-a',
      'assistant-a-1',
      'pinned-b',
      'assistant-b-1',
      'assistant-b-2',
      'pinned-unknown',
      'unknown-1',
      'default-1'
    ])
  })

  it('sorts assistant group topics by raw persisted orderKey ascending when available', () => {
    const topics = [
      createTopic({ id: 'first-created', assistantId: 'assistant-a', orderKey: 'a0' }),
      createTopic({ id: 'inserted-before-first', assistantId: 'assistant-a', orderKey: 'Zz' }),
      createTopic({ id: 'inserted-before-that', assistantId: 'assistant-a', orderKey: 'Zy' })
    ]

    expect(
      sortTopicsForDisplayGroups(topics, {
        assistantRankById: new Map([['assistant-a', 0]]),
        mode: 'assistant'
      }).map((topic) => topic.id)
    ).toEqual(['inserted-before-that', 'inserted-before-first', 'first-created'])
  })
})

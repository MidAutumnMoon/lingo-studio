import { describe, expect, it } from 'vitest'

import type { Topic } from '@renderer/types/topic'

import { createTopicTimeGroupResolver, sortTopicsForDisplayGroups } from '../topicsHelpers'

const TOPIC_GROUP_LABELS = {
  pinned: 'Pinned',
  tiers: {
    today: 'Today',
    yesterday: 'Yesterday',
    'seven-days': '7 Days',
    'thirty-days': '30 Days'
  },
  invalid: 'Earlier'
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
  it('builds the history resolver as pinned first, then the time ladder with literal month labels', () => {
    const now = new Date(2026, 8, 30, 12)
    const groupTopic = createTopicTimeGroupResolver({ labels: TOPIC_GROUP_LABELS, now })

    // Pinned wins over the rung the topic would otherwise fall into.
    expect(groupTopic(createTopic({ id: 'pinned', pinned: true, lastActivityAt: localIso(2026, 9, 30, 9) }))).toEqual({
      id: 'topic:pinned',
      label: 'Pinned'
    })
    expect(groupTopic(createTopic({ id: 'today', lastActivityAt: localIso(2026, 9, 30, 9) }))).toEqual({
      id: 'topic:time:today',
      label: 'Today'
    })
    expect(groupTopic(createTopic({ id: 'yesterday', lastActivityAt: localIso(2026, 9, 29, 9) }))).toEqual({
      id: 'topic:time:yesterday',
      label: 'Yesterday'
    })
    expect(groupTopic(createTopic({ id: 'week', lastActivityAt: localIso(2026, 9, 26, 9) }))).toEqual({
      id: 'topic:time:seven-days',
      label: '7 Days'
    })
    expect(groupTopic(createTopic({ id: 'month', lastActivityAt: localIso(2026, 8, 16, 9) }))).toEqual({
      id: 'topic:time:2026-08',
      label: '2026-08'
    })
  })

  it('keeps pinned topics stable and sorts the ladder newest rung first, months newest month first', () => {
    const now = new Date(2026, 8, 30, 12)
    const topics = [
      createTopic({ id: 'today-old', lastActivityAt: localIso(2026, 9, 30, 8) }),
      createTopic({ id: 'week', lastActivityAt: localIso(2026, 9, 26, 9) }),
      createTopic({ id: 'august', lastActivityAt: localIso(2026, 8, 20, 9) }),
      createTopic({ id: 'july', lastActivityAt: localIso(2026, 7, 2, 9) }),
      createTopic({ id: 'pinned-old', pinned: true, lastActivityAt: localIso(2026, 7, 2, 23) }),
      createTopic({ id: 'today-new', lastActivityAt: localIso(2026, 9, 30, 9) }),
      createTopic({ id: 'pinned-new', pinned: true, lastActivityAt: localIso(2026, 9, 30, 9) })
    ]

    expect(sortTopicsForDisplayGroups(topics, { mode: 'time', now }).map((topic) => topic.id)).toEqual([
      'pinned-old',
      'pinned-new',
      'today-new',
      'today-old',
      'week',
      'august',
      'july'
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

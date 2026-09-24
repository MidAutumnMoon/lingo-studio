import { describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_AVATAR, getAgentAvatar, getAgentDescriptionForDisplay, getPermissionModeCards } from '../agent'

describe('agent utilities', () => {
  it('normalizes blank stored avatars to the default agent avatar', () => {
    expect(getAgentAvatar()).toBe(DEFAULT_AGENT_AVATAR)
    expect(getAgentAvatar(null)).toBe(DEFAULT_AGENT_AVATAR)
    expect(getAgentAvatar('')).toBe(DEFAULT_AGENT_AVATAR)
    expect(getAgentAvatar('   ')).toBe(DEFAULT_AGENT_AVATAR)
  })

  it('preserves non-blank stored avatars after trimming', () => {
    expect(getAgentAvatar('  🦞  ')).toBe('🦞')
  })

  it('returns the stored description, falling back to an empty string', () => {
    expect(getAgentDescriptionForDisplay({ description: 'User description' })).toBe('User description')
    expect(getAgentDescriptionForDisplay({ description: null })).toBe('')
    expect(getAgentDescriptionForDisplay({})).toBe('')
  })
})

describe('getPermissionModeCards', () => {
  it('offers the full mode set (including plan and auto) for unknown types', () => {
    const modes = getPermissionModeCards('not-a-runtime').map((card) => card.mode)
    expect(modes).toContain('plan')
    expect(modes).toContain('auto')
    expect(getPermissionModeCards(undefined).map((c) => c.mode)).toContain('plan')
  })

  it('drops the unsupported plan mode for pi agents but keeps auto', () => {
    const modes = getPermissionModeCards('pi').map((card) => card.mode)
    expect(modes).not.toContain('plan')
    expect(modes).toEqual(expect.arrayContaining(['default', 'acceptEdits', 'auto', 'bypassPermissions']))
  })

  it("describes pi's auto and bypass modes by what they actually do, not by another runtime's mechanism", () => {
    const genericAuto = getPermissionModeCards(undefined).find((card) => card.mode === 'auto')
    const piAuto = getPermissionModeCards('pi').find((card) => card.mode === 'auto')
    const piBypass = getPermissionModeCards('pi').find((card) => card.mode === 'bypassPermissions')
    const genericBypass = getPermissionModeCards(undefined).find((card) => card.mode === 'bypassPermissions')

    // pi's auto is deterministic, so it carries its own caveat (recognition is best-effort) rather
    // than the generic "depends on the model" one.
    expect(genericAuto?.warningKey).toBeTruthy()
    expect(piAuto?.warningKey).toBeTruthy()
    expect(piAuto?.warningKey).not.toBe(genericAuto?.warningKey)
    expect(piAuto?.descriptionKey).not.toBe(genericAuto?.descriptionKey)
    // bypass now means the same thing on every runtime — approvals lifted, explicit safety blocks
    // (disabled tools, global installs) still apply — so pi shares the generic copy.
    expect(piBypass?.warningKey).toBe(genericBypass?.warningKey)
  })
})

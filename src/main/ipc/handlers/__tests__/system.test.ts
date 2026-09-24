import { createMockApplication } from '@test-mocks/main/application'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetMock,
  getDeviceTypeMock,
  getCountryMock,
  getFontsMock,
  openPathMock,
  openExternalMock,
  isSafeMock,
  nativeThemeMock
} = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  getDeviceTypeMock: vi.fn(),
  getCountryMock: vi.fn(),
  getFontsMock: vi.fn(),
  openPathMock: vi.fn(),
  openExternalMock: vi.fn(),
  isSafeMock: vi.fn(),
  nativeThemeMock: { shouldUseDarkColors: false }
}))

vi.mock('@application', () => ({ application: { get: appGetMock } }))
vi.mock('@main/utils/system', () => ({ getDeviceType: getDeviceTypeMock }))
vi.mock('@main/services/RegionService', () => ({ regionService: { getCountry: getCountryMock } }))
vi.mock('@main/utils/externalUrlSafety', () => ({ isSafeExternalUrl: isSafeMock }))
vi.mock('electron', () => ({
  nativeTheme: nativeThemeMock,
  shell: { openPath: openPathMock, openExternal: openExternalMock }
}))
vi.mock('font-list', () => ({ default: { getFonts: getFontsMock } }))

import { systemHandlers } from '../system'

const navigation = createMockApplication().get('MainWindowService') as { openWebsite: (url: string) => Promise<void> }
const toggleDevTools = vi.fn()
const windowManager = { getWindow: vi.fn(() => ({ webContents: { toggleDevTools } })) }

const ctx = (senderId: string | null) => ({ senderId })

beforeEach(() => {
  vi.clearAllMocks()
  nativeThemeMock.shouldUseDarkColors = false
  appGetMock.mockImplementation((name: string) => {
    if (name === 'WindowManager') return windowManager
    if (name === 'MainWindowService') return navigation
    throw new Error(`Unexpected application.get(${name})`)
  })
})

describe('systemHandlers', () => {
  it('get_device_type delegates to the platform util', async () => {
    getDeviceTypeMock.mockReturnValue('mac')
    expect(await systemHandlers['system.get_device_type'](undefined, ctx('w1'))).toBe('mac')
  })

  it('get_native_theme returns Electron resolved theme', async () => {
    expect(await systemHandlers['system.get_native_theme'](undefined, ctx('w1'))).toBe('light')

    nativeThemeMock.shouldUseDarkColors = true
    expect(await systemHandlers['system.get_native_theme'](undefined, ctx('w1'))).toBe('dark')
  })

  it('get_ip_country delegates to RegionService', async () => {
    getCountryMock.mockResolvedValue('US')
    expect(await systemHandlers['system.get_ip_country'](undefined, ctx('w1'))).toBe('US')
  })

  it('get_fonts strips wrapping quotes and drops empties', async () => {
    getFontsMock.mockResolvedValue(['"Arial"', 'Menlo', ''])
    expect(await systemHandlers['system.get_fonts'](undefined, ctx('w1'))).toEqual(['Arial', 'Menlo'])
  })

  it('get_fonts returns [] and never throws when font-list fails', async () => {
    getFontsMock.mockRejectedValue(new Error('boom'))
    expect(await systemHandlers['system.get_fonts'](undefined, ctx('w1'))).toEqual([])
  })

  it('toggle_dev_tools toggles the caller window resolved from senderId', async () => {
    await systemHandlers['system.toggle_dev_tools'](undefined, ctx('w1'))
    expect(windowManager.getWindow).toHaveBeenCalledWith('w1')
    expect(toggleDevTools).toHaveBeenCalledOnce()
  })

  it('toggle_dev_tools is a no-op when the caller is not a tracked window', async () => {
    await systemHandlers['system.toggle_dev_tools'](undefined, ctx(null))
    expect(windowManager.getWindow).not.toHaveBeenCalled()
  })

  it('shell.open_path delegates straight to shell.openPath', async () => {
    await systemHandlers['system.shell.open_path']('/tmp/foo', ctx('w1'))
    expect(openPathMock).toHaveBeenCalledWith('/tmp/foo')
  })

  it('shell.open_website opens a URL that passes the scheme guard', async () => {
    isSafeMock.mockReturnValue(true)
    await systemHandlers['system.shell.open_website']('https://example.com', ctx('w1'))
    expect(navigation.openWebsite).toHaveBeenCalledWith('https://example.com')
  })

  it('shell.open_website drops an unsafe URL without calling shell.openExternal', async () => {
    isSafeMock.mockReturnValue(false)
    await systemHandlers['system.shell.open_website']('javascript:alert(1)', ctx('w1'))
    expect(openExternalMock).not.toHaveBeenCalled()
  })
})

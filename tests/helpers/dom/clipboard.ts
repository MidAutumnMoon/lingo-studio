// happy-dom defines navigator.clipboard as a getter-only prototype accessor, so
// defineProperty (jsdom-compatible) replaces it instead of Object.assign.
export function stubNavigatorClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
}

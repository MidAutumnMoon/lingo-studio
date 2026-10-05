// happy-dom defines navigator.clipboard as a getter-only prototype accessor, so
// defineProperty works across DOM environments; Object.assign does not.
export function stubNavigatorClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
}

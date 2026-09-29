/**
 * Public barrel for the generic markdown composites.
 *
 * - `<Markdown>` — paste-once content (settings descriptions, release notes).
 * - `<StreamingMarkdown>` — token-by-token output with AST-stable block
 *   memoization so already-rendered text is not re-parsed mid-stream.
 * - Plugin presets are exported from `@cherrystudio/ui` so math / Mermaid
 *   dependencies remain opt-in at the call site.
 * - rehype plugins + sanitize schema — used by chat to ship its own
 *   pre-processing layer on top.
 * Side-effect styles: `import '@cherrystudio/ui/components/composites/markdown/styles'`
 * once at app entry to pick up Streamdown / KaTeX / remark-alert CSS.
 */

export { MarkdownBlockContext, type MarkdownBlockContextValue, useMarkdownBlockContext } from './context'
export { Markdown, type MarkdownProps } from './markdown'
export * from './plugins'
export { defaultMarkdownPlugins, withChatPlugins, withFullMarkdown, withMath, withMermaid } from './presets'
export { StreamingMarkdown, type StreamingMarkdownProps } from './streaming-markdown'
export type { MarkdownSource, MarkdownStatus } from './types'
export * from './utils'

import { type ReactElement } from 'react'
import type { Components, PluginConfig } from 'streamdown'
import type { Pluggable } from 'unified'

import { MarkdownCore } from './internal'

export interface StreamingMarkdownProps {
  /** Stable identity used as heading-ID prefix. */
  id: string
  /** Markdown source (the streaming tail). */
  children: string
  components?: Partial<Components>
  plugins?: PluginConfig
  rehypePlugins?: Pluggable[]
  remarkPlugins?: Pluggable[]
  disallowedElements?: readonly string[]
  className?: string
  footnoteLabel?: string
  parseIncompleteMarkdown?: boolean
  /** Animate newly rendered words with a CSS reveal; only while streaming. */
  animated?: boolean
  /** Keep custom syntax intact when splitting the stream into renderable blocks. */
  parseMarkdownIntoBlocksFn?: (source: string) => string[]
  /** Preserve local file hrefs for a custom anchor while retaining URL hardening. */
  preserveFileLinkHrefs?: boolean
}

export function StreamingMarkdown({
  id,
  children,
  components,
  plugins,
  rehypePlugins,
  remarkPlugins,
  disallowedElements,
  className,
  footnoteLabel,
  parseIncompleteMarkdown = true,
  animated,
  parseMarkdownIntoBlocksFn,
  preserveFileLinkHrefs
}: StreamingMarkdownProps): ReactElement {
  return (
    <MarkdownCore
      id={id}
      mode="streaming"
      parseIncompleteMarkdown={parseIncompleteMarkdown}
      animated={animated}
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocksFn}
      components={components}
      plugins={plugins}
      extraRehypePlugins={rehypePlugins}
      extraRemarkPlugins={remarkPlugins}
      disallowedElements={disallowedElements}
      className={className}
      footnoteLabel={footnoteLabel}
      preserveFileLinkHrefs={preserveFileLinkHrefs}>
      {children}
    </MarkdownCore>
  )
}

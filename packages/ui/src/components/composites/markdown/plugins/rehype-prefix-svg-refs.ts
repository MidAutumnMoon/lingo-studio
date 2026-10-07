/**
 * Rehype plugin: prefix SVG IDs and rewrite intra-SVG references.
 *
 * Pairs with the sanitize plugin's `clobberPrefix` so that an SVG's
 * `id="foo"` becomes `id="user-content-foo"` (clobbered to avoid colliding
 * with the host page), and all `url(#foo)` references inside the same SVG
 * follow suit.
 */

import type { Element, Properties, Root } from 'hast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

const rewriteSvgReference = (value: string, idMap: Map<string, string>) => {
  let rewritten = value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (match, quote, id) => {
    const prefixedId = idMap.get(id)
    return prefixedId ? `url(${quote}#${prefixedId}${quote})` : match
  })

  if (rewritten.startsWith('#')) {
    const id = rewritten.slice(1)
    const prefixedId = idMap.get(id)
    if (prefixedId) {
      rewritten = `#${prefixedId}`
    }
  }

  return rewritten
}

const rewriteSvgProperty = (value: Properties[string], idMap: Map<string, string>): Properties[string] => {
  if (typeof value === 'string') {
    return rewriteSvgReference(value, idMap)
  }

  return value
}

export const rehypePrefixSvgReferences: Plugin<[string | undefined], Root> = (clobberPrefix = 'user-content-') => {
  return (tree) => {
    if (!clobberPrefix) return

    visit(tree, 'element', (svgNode: Element) => {
      if (svgNode.tagName !== 'svg') return

      const idMap = new Map<string, string>()
      visit(svgNode, 'element', (node: Element) => {
        const id = node.properties.id
        if (typeof id === 'string' && id.startsWith(clobberPrefix)) {
          idMap.set(id.slice(clobberPrefix.length), id)
        }
      })

      if (idMap.size === 0) return

      visit(svgNode, 'element', (node: Element) => {
        for (const key of Object.keys(node.properties)) {
          node.properties[key] = rewriteSvgProperty(node.properties[key], idMap)
        }
      })
    })
  }
}

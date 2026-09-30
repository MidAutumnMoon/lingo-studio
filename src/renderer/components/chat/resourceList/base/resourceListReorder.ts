/**
 * Reorder helpers live in `@renderer/utils/chat/resourceListBase`; this module keeps the base
 * barrel's public API stable.
 */
export type { ResourceListOrderAnchor } from '@renderer/utils/chat/resourceListBase'
export {
  buildResourceListGroupDropAnchor,
  buildResourceListItemDropAnchor,
  compareResourceOrderKey,
  moveResourceListStringGroupAfterDrop,
  withResourceListGroupIdPrefix
} from '@renderer/utils/chat/resourceListBase'

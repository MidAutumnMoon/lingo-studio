/**
 * Grouping logic lives in `@renderer/utils/chat/resourceListBase` (utils may not import from
 * components, components may import from utils — so the implementation sits one layer down). This
 * module keeps the base barrel's public API stable.
 */
export type {
  ResourceListGroupResolver,
  ResourceListTimeGroup,
  ResourceListTimeGroupLabels,
  ResourceListTimeTier
} from '@renderer/utils/chat/resourceListBase'
export {
  compareResourceRecency,
  composeResourceListGroupResolvers,
  createPinnedFirstSorter,
  createPinnedGroupResolver,
  createTimeGroupResolver,
  resolveResourceTimeGroup,
  sortByResourceGroupRank,
  sortRankedResourceItems
} from '@renderer/utils/chat/resourceListBase'

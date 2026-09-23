import * as z from 'zod'

import { TOOL_NAME_RE } from '@shared/data/presets/binaryTools'
import type { BinaryAvailability, BinaryToolSnapshot } from '@shared/types/binary'

import { defineRoute } from '../define'

/**
 * PATH-tool observation schemas. This fork ships and installs no binaries: the
 * only surface left is read-only probing of what already exists on the user's
 * login-shell PATH (the Dependencies dashboard and CLI availability checks).
 */

/** A tool name used to address an existing entry; reject malformed names at the boundary. */
const toolNameSchema = z.string().regex(TOOL_NAME_RE)

const binaryAvailabilitySchema: z.ZodType<BinaryAvailability> = z.discriminatedUnion('source', [
  z.object({ source: z.literal('system'), path: z.string() }),
  z.object({ source: z.literal('none') })
])

const binaryToolSnapshotSchema: z.ZodType<BinaryToolSnapshot> = z.object({
  name: z.string(),
  availability: binaryAvailabilitySchema
})

// ── Request: renderer→main calls (zod values, always parsed) ──
export const binaryRequestSchemas = {
  'binary.get_tool_snapshots': defineRoute({
    input: z.array(toolNameSchema),
    output: z.record(z.string(), binaryToolSnapshotSchema)
  })
}

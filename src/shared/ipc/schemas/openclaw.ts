import * as z from 'zod'

import { UniqueModelIdSchema } from '@shared/data/types/model'

import { defineRoute } from '../define'
import { operationResultSchema } from './common'

/**
 * OpenClaw gateway runtime schemas. The gateway binary is the user's own
 * installation, resolved from PATH.
 */

// ── Request schemas ──
const openclawStatusSchema = z.enum(['stopped', 'starting', 'running', 'error'])

export const openclawRequestSchemas = {
  'openclaw.start_gateway': defineRoute({
    input: z.object({ port: z.number().int().min(1).max(65535).optional() }),
    output: operationResultSchema
  }),
  'openclaw.stop_gateway': defineRoute({
    input: z.void(),
    output: operationResultSchema
  }),
  'openclaw.get_status': defineRoute({
    input: z.void(),
    output: z.object({ status: openclawStatusSchema })
  }),
  'openclaw.get_dashboard_url': defineRoute({
    input: z.void(),
    output: z.string()
  }),
  'openclaw.sync_config': defineRoute({
    input: z.object({ uniqueModelId: UniqueModelIdSchema, port: z.number().optional() }),
    output: operationResultSchema
  })
}

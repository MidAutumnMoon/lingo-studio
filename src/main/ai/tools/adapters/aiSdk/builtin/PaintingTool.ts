/**
 * Image generation tool — agentic.
 *
 * The model supplies a prompt, model-supported canonical parameters, and optional image references.
 * The actual generation/editing (painting-model resolution, vendor
 * mapping, persistence) lives in the shared `painting` core so the agent
 * MCP bridge runs the exact same logic; this file is just the registry's
 * neutral dynamic-tool wrapper.
 */

import { GENERATE_IMAGE_TOOL_NAME } from '@shared/ai/builtinTools'

import { buildGenerateImageToolSchema, type GenerateImageToolInput } from '../../../generateImageTool'
import { zodToolSchema, type NeutralTool } from '../../../neutralTool'
import {
  type ConfiguredPaintingModel,
  GENERATE_IMAGE_DESCRIPTION,
  generateImageFromPrompt,
  paintingModelOutput,
  type PaintingResult
} from '../../../painting'
import { getToolCallContext } from '../context'
import type { ToolEntry } from '../types'

export { GENERATE_IMAGE_TOOL_NAME }

function buildGenerateImageTool(configuredModel?: ConfiguredPaintingModel): NeutralTool {
  const inputSchema = buildGenerateImageToolSchema(configuredModel?.support)
  return {
    type: 'dynamic',
    description: GENERATE_IMAGE_DESCRIPTION,
    inputSchema: zodToolSchema(inputSchema),
    execute: async (input, options) => {
      const parsed = inputSchema.parse(input) as GenerateImageToolInput
      return configuredModel === undefined
        ? generateImageFromPrompt(parsed, getToolCallContext(options).request.abortSignal)
        : generateImageFromPrompt(parsed, getToolCallContext(options).request.abortSignal, configuredModel)
    },
    toModelOutput: ({ output }) => paintingModelOutput(output as PaintingResult)
  }
}

const fallbackGenerateImageTool = buildGenerateImageTool()

export function createGenerateImageToolEntry(): ToolEntry {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    namespace: 'media',
    description: 'Generate an image from a text prompt',
    defer: 'auto',
    tool: fallbackGenerateImageTool,
    buildTool: (scope) => buildGenerateImageTool(scope.paintingModel),
    // Two gates: the composer toggle (`assistant.settings.enableGenerateImage`) is the user's per-assistant
    // opt-in, and a global painting model (Settings > Default Model) is what the tool actually generates with.
    // Both are required — without a model there is nothing to generate; without the opt-in the model
    // shouldn't be offered image generation at all.
    applies: (scope) => Boolean(scope.paintingModel) && Boolean(scope.assistant?.settings?.enableGenerateImage)
  }
}

export type { GenerateImageToolInput }
export type GenerateImageToolOutput = PaintingResult

import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { JSONSchema7 } from 'json-schema'

import type { ToolSchema } from '../../neutralTool'

const jsonSchemaValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })

export function createMcpJsonSchemaValidator<T = unknown>(schema: JSONSchema7) {
  const validate = jsonSchemaValidator.getValidator(schema as never)

  return (value: unknown) => {
    const result = validate(value)
    return result.valid
      ? { success: true as const, value: result.data as T }
      : { success: false as const, error: new Error(result.errorMessage) }
  }
}

/** MCP input schema in the registry's neutral form: the raw wire schema plus its validator. */
export function createMcpInputSchema(schema: JSONSchema7): ToolSchema {
  return {
    jsonSchema: schema,
    validate: createMcpJsonSchemaValidator<Record<string, unknown>>(schema)
  }
}

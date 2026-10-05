// port https://github.com/zcaceres/fetch-mcp/blob/main/src/index.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { applyTableRules } from '@main/utils/htmlToMarkdown'
import { fetchRemoteText } from '@main/utils/remoteFetch'

export const RequestPayloadSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional()
})

export type RequestPayload = z.infer<typeof RequestPayloadSchema>

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function buildHeaders(headers: RequestPayload['headers']): Headers {
  const resolvedHeaders = new Headers(headers)

  if (!resolvedHeaders.has('User-Agent')) {
    resolvedHeaders.set('User-Agent', DEFAULT_USER_AGENT)
  }

  return resolvedHeaders
}

export class Fetcher {
  private static async _fetchText({ url, headers }: RequestPayload): Promise<string> {
    try {
      // The URL is model-supplied and this tool is auto-callable, so direct
      // main-process fetches must bind the connection to validated DNS results.
      return await fetchRemoteText(url, { headers: buildHeaders(headers), maxRedirects: 5 })
    } catch (e: unknown) {
      if (e instanceof Error) {
        throw new Error(`Failed to fetch ${url}: ${e.message}`)
      } else {
        throw new Error(`Failed to fetch ${url}: Unknown error`)
      }
    }
  }

  static async html(requestPayload: RequestPayload) {
    try {
      const html = await this._fetchText(requestPayload)
      return { content: [{ type: 'text', text: html }], isError: false }
    } catch (error) {
      return {
        content: [{ type: 'text', text: (error as Error).message }],
        isError: true
      }
    }
  }

  static async json(requestPayload: RequestPayload) {
    try {
      const text = await this._fetchText(requestPayload)
      const json = JSON.parse(text)
      return {
        content: [{ type: 'text', text: JSON.stringify(json) }],
        isError: false
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: (error as Error).message }],
        isError: true
      }
    }
  }

  static async markdown(requestPayload: RequestPayload) {
    try {
      const html = await this._fetchText(requestPayload)
      const { default: TurndownService } = await import('turndown')
      const turndownService = applyTableRules(new TurndownService())
      const markdown = turndownService.turndown(html)
      return { content: [{ type: 'text', text: markdown }], isError: false }
    } catch (error) {
      return {
        content: [{ type: 'text', text: (error as Error).message }],
        isError: true
      }
    }
  }
}

const server = new Server(
  {
    name: 'zcaceres/fetch',
    version: '0.1.0'
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'fetch_html',
        description: 'Fetch a website and return the content as HTML',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL of the website to fetch'
            },
            headers: {
              type: 'object',
              description: 'Optional headers to include in the request'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'fetch_markdown',
        description: 'Fetch a website and return the content as Markdown',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL of the website to fetch'
            },
            headers: {
              type: 'object',
              description: 'Optional headers to include in the request'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'fetch_json',
        description: 'Fetch a JSON file from a URL',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL of the JSON to fetch'
            },
            headers: {
              type: 'object',
              description: 'Optional headers to include in the request'
            }
          },
          required: ['url']
        }
      }
    ]
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { arguments: args } = request.params

  const validatedArgs = RequestPayloadSchema.parse(args)

  if (request.params.name === 'fetch_html') {
    return await Fetcher.html(validatedArgs)
  }
  if (request.params.name === 'fetch_json') {
    return await Fetcher.json(validatedArgs)
  }
  if (request.params.name === 'fetch_markdown') {
    return await Fetcher.markdown(validatedArgs)
  }
  throw new Error('Tool not found')
})

class FetchServer {
  public server: Server
  constructor() {
    this.server = server
  }
}
export default FetchServer

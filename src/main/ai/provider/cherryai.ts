/**
 * CherryAI request signature module.
 *
 * Retained for diagnostics upload only (POST /diagnostics, see
 * CherryDiagnosticUploadClient.ts); the keyless chat-completions signing path
 * was removed with the cherryai provider.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'

const CLIENT_SECRET = import.meta.env.MAIN_VITE_CHERRYAI_CLIENT_SECRET
const CLIENT_ID = 'cherry-studio'
const CLIENT_SECRET_SUFFIX = 'GvI6I5ZrEHcGOWjO5AKhJKGmnwwGfM62XKpWqkjhvzRU2NZIinM77aTGIqhqys0g'

function getClientSecret(): string {
  if (!CLIENT_SECRET) {
    throw new Error('CherryAI client secret is not configured')
  }
  return CLIENT_SECRET + '.' + CLIENT_SECRET_SUFFIX
}

function requireClientSecret(clientSecret: string): string {
  if (!clientSecret) {
    throw new Error('CherryAI client secret is not configured')
  }
  return clientSecret
}

export interface DiagnosticUploadSignatureOptions {
  readonly description?: string
  readonly fileSha256: string
  readonly fileSize: number
  readonly requestId?: string
}

export interface DiagnosticUploadSignatureHeaders {
  readonly 'X-Signature-Version': '2'
  readonly 'X-Client-ID': string
  readonly 'X-Timestamp': string
  readonly 'X-Request-ID': string
  readonly 'X-File-Size': string
  readonly 'X-File-SHA256': string
  readonly 'X-Description-SHA256': string
  readonly 'X-Signature': string
}

export class SignatureClient {
  private clientId: string
  private clientSecret: string

  constructor(clientId?: string, clientSecret?: string) {
    this.clientId = clientId || CLIENT_ID
    this.clientSecret = clientSecret === undefined ? getClientSecret() : requireClientSecret(clientSecret)
    this.generateDiagnosticUploadHeaders = this.generateDiagnosticUploadHeaders.bind(this)
  }

  /**
   * Generate streaming-safe signature headers for POST /diagnostics.
   * The caller must hash the ZIP before creating the multipart body.
   */
  generateDiagnosticUploadHeaders(options: DiagnosticUploadSignatureOptions): DiagnosticUploadSignatureHeaders {
    const { description = '', fileSha256, fileSize, requestId = randomUUID() } = options
    const normalizedFileSha256 = String(fileSha256).toLowerCase()

    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw new Error('fileSize must be a positive safe integer')
    }
    if (!/^[0-9a-f]{64}$/.test(normalizedFileSha256)) {
      throw new Error('fileSha256 must be a 64-character hexadecimal digest')
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
      throw new Error('requestId must be a lowercase UUID v4')
    }

    const timestamp = Math.floor(Date.now() / 1000).toString()
    const descriptionSha256 = createHash('sha256').update(description, 'utf8').digest('hex')
    const signatureString = [
      'v2',
      'POST',
      '/diagnostics',
      '',
      this.clientId,
      timestamp,
      requestId,
      fileSize.toString(),
      normalizedFileSha256,
      descriptionSha256
    ].join('\n')
    const signature = createHmac('sha256', this.clientSecret).update(signatureString).digest('hex')

    return {
      'X-Signature-Version': '2',
      'X-Client-ID': this.clientId,
      'X-Timestamp': timestamp,
      'X-Request-ID': requestId,
      'X-File-Size': fileSize.toString(),
      'X-File-SHA256': normalizedFileSha256,
      'X-Description-SHA256': descriptionSha256,
      'X-Signature': signature
    }
  }
}

let signatureClient: SignatureClient | null = null

export function generateDiagnosticUploadHeaders(
  options: DiagnosticUploadSignatureOptions
): DiagnosticUploadSignatureHeaders {
  if (!signatureClient) {
    signatureClient = new SignatureClient()
  }
  return signatureClient.generateDiagnosticUploadHeaders(options)
}

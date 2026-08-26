import { randomUUID } from 'node:crypto'

export const PRODUCT_DIAGNOSTIC_PREFIX = 'AI_GAME_HARNESS_DIAGNOSTIC '

export type ProductDiagnosticKind = 'game-agent.latency' | 'voice.latency' | 'voice.failed'

export interface ProductDiagnosticRecord {
  schemaVersion: 1
  id: string
  kind: ProductDiagnosticKind
  createdAt: string
  sessionId?: string
  gameId?: string
  interactionId?: string
  detail: Record<string, string | number | boolean>
}

/** Publish measurement facts only. Prompts, transcripts and model reasoning are forbidden here. */
export function publishProductDiagnostic(
  input: Omit<ProductDiagnosticRecord, 'schemaVersion' | 'id' | 'createdAt'>,
): ProductDiagnosticRecord {
  const record: ProductDiagnosticRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input,
  }
  process.stdout.write(`${PRODUCT_DIAGNOSTIC_PREFIX}${JSON.stringify(record)}\n`)
  return record
}

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

const HISTORY_WINDOW_MARKER = '[Earlier companion conversation omitted from the model context to keep replies fast.]'

export interface HistoricalImagePruneResult {
  messages: number
  images: number
  bytes: number
}

export interface HistoricalTurnPruneResult {
  turns: number
  messages: number
}

function isHistoryWindowMarker(event: Session['events'][number]): boolean {
  if (event.type !== 'user/message') return false
  return event.data.content.some(block => block.type === 'text' && block.text === HISTORY_WINDOW_MARKER)
}

/**
 * Keep only the newest completed player turns on the model-visible surface.
 *
 * The append-only event log remains intact for the Desktop transcript and
 * diagnostics. The next live player message is appended after this function,
 * so keeping two completed turns makes the actual request contain at most the
 * current turn plus two preceding turns (three player turns total).
 */
export function keepRecentConversationTurns(session: Session, completedTurns = 2): HistoricalTurnPruneResult {
  const nodes = [...session.surface.nodes]
  const playerNodes = nodes.filter(seq => {
    const event = session.events[seq]
    return event?.type === 'user/message' && !isHistoryWindowMarker(event)
  })
  if (playerNodes.length <= completedTurns) return { turns: 0, messages: 0 }

  const firstKeptPlayer = playerNodes[playerNodes.length - completedTurns]
  const firstKeptIndex = nodes.indexOf(firstKeptPlayer!)
  if (firstKeptIndex <= 0) return { turns: 0, messages: 0 }
  const replacedNodes = nodes.slice(0, firstKeptIndex)
  const removedTurns = replacedNodes.filter(seq => session.events[seq]?.type === 'user/message' && !isHistoryWindowMarker(session.events[seq]!)).length

  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: HISTORY_WINDOW_MARKER }],
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', start: replacedNodes[0]!, end: replacedNodes.at(-1)! },
    sourceEventSeqs: replacedNodes,
  })

  return { turns: removedTurns, messages: replacedNodes.length }
}

/**
 * Keep screenshots as current-turn context without deleting their durable audit events.
 *
 * A game screenshot is appended beside every player message so it remains available
 * throughout that agent turn. Before the next turn starts, replace every image-bearing
 * user message on the model-visible surface with the same message minus image blocks.
 * The append-only log still contains the original image reference for diagnostics, while
 * Session.deriveMessages() and subsequent model requests retain only the text.
 */
export function pruneHistoricalImages(session: Session): HistoricalImagePruneResult {
  const result: HistoricalImagePruneResult = { messages: 0, images: 0, bytes: 0 }
  const events = session.events
  const nodes = [...session.surface.nodes]

  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    const images = event.data.content.filter(block => block.type === 'image')
    if (images.length === 0) continue

    const content = event.data.content.filter(block => block.type !== 'image')
    if (content.length === 0) continue

    session.append('user/message', {
      ...event.data,
      content,
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })

    result.messages += 1
    result.images += images.length
    result.bytes += images.reduce((total, block) => total + block.attachment.bytes, 0)
  }

  return result
}

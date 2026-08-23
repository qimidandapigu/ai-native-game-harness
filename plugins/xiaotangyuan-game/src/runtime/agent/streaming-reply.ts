export interface StreamingReplyUpdate {
  interactionId: string
  delta: string
  text: string
  elapsedMs: number
}

export type StreamingReplySink = (update: StreamingReplyUpdate) => void

/**
 * Coalesces provider text deltas so game bridges receive genuine streaming
 * without being flooded by one WebSocket message per token.
 */
export class StreamingReplyAccumulator {
  private step?: number
  private text = ''
  private pending = ''
  private lastEmitAt = 0
  private timer?: ReturnType<typeof setTimeout>
  private firstTextAt?: number

  constructor(
    private readonly interactionId: string,
    private readonly startedAt: number,
    private readonly sink?: StreamingReplySink,
    private readonly now: () => number = () => performance.now(),
    private readonly intervalMs = 80,
  ) {}

  append(step: number, delta: string): void {
    if (delta === '') return
    if (this.step !== step) {
      this.flush()
      this.step = step
      this.text = ''
      this.pending = ''
      this.lastEmitAt = 0
    }

    const current = this.now()
    this.firstTextAt ??= current
    this.text += delta
    this.pending += delta

    const shouldEmitNow = this.lastEmitAt === 0
      || current - this.lastEmitAt >= this.intervalMs
      || /[。！？!?\n]$/.test(delta)
    if (shouldEmitNow) {
      this.flush(current)
      return
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, Math.max(1, this.intervalMs - (current - this.lastEmitAt)))
    }
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.flush()
  }

  firstTextElapsedMs(): number | undefined {
    return this.firstTextAt === undefined ? undefined : this.firstTextAt - this.startedAt
  }

  private flush(at = this.now()): void {
    if (this.pending === '') return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const delta = this.pending
    this.pending = ''
    this.lastEmitAt = at
    this.sink?.({
      interactionId: this.interactionId,
      delta,
      text: this.text,
      elapsedMs: Math.max(0, at - this.startedAt),
    })
  }
}

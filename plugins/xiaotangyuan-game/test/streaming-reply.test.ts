import { describe, expect, it, vi } from 'vitest'
import { StreamingReplyAccumulator } from '../src/runtime/agent/streaming-reply.js'

describe('streaming reply accumulator', () => {
  it('emits the first text immediately and coalesces later token deltas', () => {
    vi.useFakeTimers()
    let now = 100
    const updates: Array<{ delta: string, text: string }> = []
    const stream = new StreamingReplyAccumulator(
      'interaction-1',
      90,
      update => updates.push({ delta: update.delta, text: update.text }),
      () => now,
      80,
    )

    stream.append(1, '你')
    now = 120
    stream.append(1, '好')
    expect(updates).toEqual([{ delta: '你', text: '你' }])

    now = 180
    vi.advanceTimersByTime(80)
    expect(updates).toEqual([
      { delta: '你', text: '你' },
      { delta: '好', text: '你好' },
    ])
    stream.close()
    vi.useRealTimers()
  })

  it('starts a replacement text when the model enters a later tool step', () => {
    const updates: Array<{ delta: string, text: string }> = []
    const stream = new StreamingReplyAccumulator(
      'interaction-2',
      0,
      update => updates.push({ delta: update.delta, text: update.text }),
      () => 100,
    )
    stream.append(1, '我先看看。')
    stream.append(2, '已经处理好了。')
    stream.close()

    expect(updates.at(-1)).toEqual({ delta: '已经处理好了。', text: '已经处理好了。' })
  })
})

import { describe, expect, it } from 'vitest'
import { buildDshChildEnvironment } from '../../apps/desktop/src/dsh-process-options.mjs'

describe('Desktop DSH child process options', () => {
  it('omits undefined values before passing the environment to Electron', () => {
    const environment = {
      PATH: '/usr/bin',
      DSH_DISABLE_HMR: undefined,
    }

    const result = buildDshChildEnvironment({
      environment,
      dshHome: '/tmp/desktop-dsh-home',
      packaged: false,
    })

    expect(result).toEqual({
      PATH: '/usr/bin',
      DSH_HOME: '/tmp/desktop-dsh-home',
    })
    expect(Object.values(result).every(value => typeof value === 'string')).toBe(true)
  })

  it('preserves an explicit development value and disables HMR in packaged builds', () => {
    expect(buildDshChildEnvironment({
      environment: { DSH_DISABLE_HMR: '0' },
      dshHome: '/tmp/dev-dsh-home',
      packaged: false,
    }).DSH_DISABLE_HMR).toBe('0')

    expect(buildDshChildEnvironment({
      environment: {},
      dshHome: '/tmp/packaged-dsh-home',
      packaged: true,
    }).DSH_DISABLE_HMR).toBe('1')
  })
})

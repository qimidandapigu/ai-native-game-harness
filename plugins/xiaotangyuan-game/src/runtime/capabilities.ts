export const REQUIRED_ENGINE_CAPABILITIES = [
  'vision.observe',
  'speech.transcribe',
  'speech.synthesize',
  'media.capture.microphone',
  'media.play.audio',
] as const

export type RequiredEngineCapability = typeof REQUIRED_ENGINE_CAPABILITIES[number]

export interface CapabilityStatus {
  capability: RequiredEngineCapability
  ready: boolean
  provider?: string
  reason?: string
}

export interface CapabilityProvider {
  readonly id: string
  isAvailable(): Promise<boolean>
}

/**
 * Provider-neutral capability registry.
 *
 * Providers are registered against what they can do, so one implementation may
 * provide several capabilities while ASR and TTS may also come from different
 * implementations. Secrets remain owned by DSH and are resolved by providers
 * only when an operation starts.
 */
export class CapabilityRegistry {
  private readonly providers = new Map<RequiredEngineCapability, CapabilityProvider[]>()

  register<T extends CapabilityProvider>(capability: RequiredEngineCapability, provider: T): () => void {
    const current = this.providers.get(capability) ?? []
    if (current.some(candidate => candidate.id === provider.id)) {
      throw new Error(`capability ${capability} already has provider ${provider.id}`)
    }
    current.push(provider)
    this.providers.set(capability, current)
    return () => {
      const registered = this.providers.get(capability)
      if (registered === undefined) return
      const next = registered.filter(candidate => candidate !== provider)
      if (next.length === 0) this.providers.delete(capability)
      else this.providers.set(capability, next)
    }
  }

  list<T extends CapabilityProvider>(capability: RequiredEngineCapability): readonly T[] {
    return (this.providers.get(capability) ?? []) as unknown as readonly T[]
  }

  async resolve<T extends CapabilityProvider>(
    capability: RequiredEngineCapability,
    preferred = 'auto',
  ): Promise<T | undefined> {
    const candidates = this.list<T>(capability)
      .filter(provider => preferred === 'auto' || provider.id === preferred)
    for (const provider of candidates) {
      try {
        if (await provider.isAvailable()) return provider
      } catch {
        // An unavailable provider must not prevent another implementation from serving the capability.
      }
    }
    return undefined
  }

  async describe(capability: RequiredEngineCapability, preferred = 'auto'): Promise<CapabilityStatus> {
    const provider = await this.resolve(capability, preferred)
    return provider === undefined
      ? { capability, ready: false, reason: preferred === 'auto' ? 'no-ready-provider' : 'preferred-provider-unavailable' }
      : { capability, ready: true, provider: provider.id }
  }
}

export function missingRequiredCapabilities(statuses: readonly CapabilityStatus[]): RequiredEngineCapability[] {
  const ready = new Set(
    statuses
      .filter(status => status.ready)
      .map(status => status.capability),
  )
  return REQUIRED_ENGINE_CAPABILITIES.filter(capability => !ready.has(capability))
}

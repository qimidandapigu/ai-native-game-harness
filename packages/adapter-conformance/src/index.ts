import { randomUUID } from 'node:crypto'
import {
  assertActionResult,
  assertAdapterHello,
  assertObservation,
  type GameAdapter,
  type JsonObject,
} from '@ai-native-game-harness/adapter-protocol'

export interface AdapterActionCase {
  capability: string
  arguments: JsonObject
  expectOk?: boolean
}

export interface AdapterConformanceOptions {
  expectedGameId?: string
  actionCases?: AdapterActionCase[]
}

export interface AdapterConformanceCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface AdapterConformanceReport {
  ok: boolean
  gameId?: string
  checks: AdapterConformanceCheck[]
}

export async function runAdapterConformance(
  adapter: GameAdapter,
  options: AdapterConformanceOptions = {},
): Promise<AdapterConformanceReport> {
  const checks: AdapterConformanceCheck[] = []
  let gameId: string | undefined
  let revision = 0
  const run = async (name: string, check: () => void | Promise<void>): Promise<void> => {
    try {
      await check()
      checks.push({ name, ok: true })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  let hello: Awaited<ReturnType<GameAdapter['hello']>> | undefined
  await run('hello', async () => {
    hello = await adapter.hello()
    assertAdapterHello(hello)
    gameId = hello.gameId
    if (options.expectedGameId && hello.gameId !== options.expectedGameId) {
      throw new Error(`Expected gameId ${options.expectedGameId}, received ${hello.gameId}`)
    }
    const names = hello.capabilities.map(capability => `${capability.kind}:${capability.name}`)
    if (new Set(names).size !== names.length) throw new Error('Adapter capabilities must be unique')
  })

  await run('observe', async () => {
    if (!gameId) throw new Error('hello did not produce a valid gameId')
    const observation = await adapter.observe()
    assertObservation(observation, gameId)
    revision = observation.revision
  })

  for (const [index, actionCase] of (options.actionCases ?? []).entries()) {
    await run(`action:${index}:${actionCase.capability}`, async () => {
      if (!gameId || !hello) throw new Error('hello did not produce a valid Adapter identity')
      const declared = hello.capabilities.some(capability => capability.kind === 'action' && capability.name === actionCase.capability)
      if (!declared) throw new Error(`Action is not declared: ${actionCase.capability}`)
      const request = {
        requestId: randomUUID(),
        gameId,
        capability: actionCase.capability,
        arguments: actionCase.arguments,
        expectedRevision: revision,
      }
      const result = await adapter.execute(request)
      assertActionResult(request, result)
      if (actionCase.expectOk !== undefined && result.ok !== actionCase.expectOk) {
        throw new Error(`Expected ok=${actionCase.expectOk}, received ok=${result.ok}`)
      }
      const observation = await adapter.observe()
      assertObservation(observation, gameId)
      if (observation.revision < result.revision) throw new Error('Observation revision is older than the action result')
      revision = observation.revision
    })
  }

  return { ok: checks.every(check => check.ok), gameId, checks }
}

export async function assertAdapterConformance(
  adapter: GameAdapter,
  options: AdapterConformanceOptions = {},
): Promise<AdapterConformanceReport> {
  const report = await runAdapterConformance(adapter, options)
  if (!report.ok) {
    const failures = report.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.detail}`).join('; ')
    throw new Error(`Adapter conformance failed: ${failures}`)
  }
  return report
}

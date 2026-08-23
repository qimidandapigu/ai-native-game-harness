import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

async function readScenario(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new Error('Each Promptfoo test must provide vars.fixture')
  }
  const path = resolve(process.cwd(), relativePath)
  return requireObject(JSON.parse(await readFile(path, 'utf8')), `Fixture ${relativePath}`)
}

function normalizeResponse(value) {
  const response = requireObject(value, 'Evaluator response')
  if (typeof response.output !== 'string' || response.output.trim() === '') {
    throw new Error('Evaluator response.output must be a non-empty string')
  }
  const metadata = requireObject(response.metadata, 'Evaluator response.metadata')
  if (!Array.isArray(metadata.toolCalls)) {
    throw new Error('Evaluator response.metadata.toolCalls must be an array')
  }
  return { output: response.output, metadata }
}

export default class XiaoTangYuanPromptfooProvider {
  constructor(options = {}) {
    this.providerId = options.id ?? 'xiaotangyuan-harness'
    this.config = options.config ?? {}
  }

  id() {
    return this.providerId
  }

  async callApi(prompt, context) {
    const fixturePath = context?.vars?.fixture
    const scenario = await readScenario(fixturePath)

    if (this.config.mode === 'contract-replay') {
      return normalizeResponse(scenario.replayResponse)
    }

    const endpoint = process.env.XTY_EVAL_URL?.trim()
    if (!endpoint) {
      return {
        error: 'XTY_EVAL_URL is required. Run eval:promptfoo:contract only to validate the local Promptfoo contract.',
      }
    }
    const endpointUrl = new URL(endpoint)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpointUrl.hostname)) {
      return { error: 'XTY_EVAL_URL must point to a loopback Harness evaluator.' }
    }

    const { replayResponse: _replayResponse, ...fixture } = scenario
    const started = performance.now()
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scenarioId: context?.test?.description,
        playerText: prompt,
        fixture,
      }),
      signal: AbortSignal.timeout(Number(this.config.timeoutMs ?? 90_000)),
    })
    if (!response.ok) {
      return { error: `Harness evaluator returned HTTP ${response.status}: ${await response.text()}` }
    }
    const result = normalizeResponse(await response.json())
    result.metadata.providerElapsedMs = Math.round(performance.now() - started)
    return result
  }
}

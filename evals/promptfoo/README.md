# XiaoTangYuan Promptfoo evals

This suite defines high-value ONI and Don't Starve Together scenarios and the response contract expected from a real XiaoTangYuan Harness evaluator.

## What the two commands mean

```powershell
pnpm eval:promptfoo:contract
```

Runs recorded responses through Promptfoo. It validates that fixtures, provider metadata, and assertions are wired correctly. A pass here is **not** evidence that a model or the live Harness passed the scenarios.

```powershell
$env:XTY_EVAL_URL = 'http://127.0.0.1:3181/v1/evaluate'
pnpm eval:promptfoo
```

Posts every scenario to a local Harness evaluator. The evaluator must invoke the real XiaoTangYuan `GameAgentSession`, expose the ONI tools through a fake game bridge, and return:

For safety, the provider rejects non-loopback evaluator URLs. Fixtures may contain local game state and must not be sent to a public endpoint.

```json
{
  "output": "final player-facing reply",
  "metadata": {
    "toolCalls": [
      {
        "name": "oni_build",
        "input": { "buildingKey": "ladder" },
        "output": { "success": true, "reply": "..." },
        "isError": false
      }
    ],
    "finalGameState": {}
  }
}
```

The request contains `scenarioId`, `playerText`, and `fixture`. `replayResponse` is removed before a live scenario is sent, so expected answers are never leaked to the agent under test.

Use `pnpm eval:promptfoo:view` after a run to open Promptfoo's local result viewer.

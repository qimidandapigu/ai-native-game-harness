# Oxygen Not Included Adapter

`bridge/` is the C# Mod loaded by Oxygen Not Included. It owns only game-native work:
observations, cursor/duplicant identity, native chore execution, and the in-game fairy UI.

The first companion growth loop is implemented in the Bridge: while following a
Duplicant, XiaoTangYuan learns Water Orb after physically touching water. The
learned skill can absorb water from the cursor cell or spray the stored water at
the cursor through natural-language requests. Its skill board is available from
the fairy panel and shows unlock state, stored element, and mass.

The TypeScript ONI Adapter lives in `adapter/` as its own installable Harness plugin. It
bridges this Mod to the local AIHarness Gateway and registers ONI-specific tools. The
generic Harness package does not depend on it, so other players do not download ONI code.

AI credentials, screenshot capture, ASR, TTS, memory, and model selection belong to
AIHarness, not to the Mod. The Bridge contains no direct model or speech client.

Current compatible versions are ONI Adapter `0.1.5`, C# Bridge `0.6.6`, and
Harness plugin `0.7.7`. The Harness sends the player text, current game-window
image, and validated `AI-Native Game Context v1` to one image-capable Agent. It
does not run a separate image-to-text model before the conversation model.

Build the bridge with:

```powershell
dotnet build games/oxygen-not-included/bridge/DoubaoAI.ONI.csproj -c Release
```

Build the versioned Bridge ZIP and refresh its signed-hash distribution manifest with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File games/oxygen-not-included/bridge/tools/PackageRelease.ps1
```

Build the separately installable Harness Adapter package with:

```powershell
pnpm --filter @qimidandapigu/oni-adapter pack --pack-destination .release/oni
```

After the resulting `.release/oni/dsh-xiaotangyuan-game-oni-<version>.zip` is
published under the matching `oni-v<version>` GitHub Release, players can ask
Harness to detect and install the Mod. The installer downloads only this C#
Bridge; the TypeScript Adapter remains a separately installed Harness plugin.

The Bridge is installed under the Klei user Mod directory rather than the Steam
game directory:

```text
%USERPROFILE%\Documents\Klei\OxygenNotIncluded\mods\Local\DoubaoAI
```

Pass `-p:GameManagedDir=<ONI managed directory>` if the local Steam installation is not at
the configured path. Do not package `bin/`, `obj/`, `dist/`, logs, or a local `config.json`.

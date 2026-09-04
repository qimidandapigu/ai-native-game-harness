import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Stardew migrated interaction regressions', () => {
  it('routes the in-game V key through the existing Gateway voice boundary', () => {
    const config = read('games/stardew-valley/adapter/ModConfig.cs')
    const client = read('games/stardew-valley/adapter/GameAgentClient.cs')
    const entry = read('games/stardew-valley/adapter/ModEntry.cs')

    expect(config).toContain('public SButton VoiceChatKey { get; set; } = SButton.V;')
    expect(client).toContain('Task StartVoiceAsync(')
    expect(client).toContain('"voice.start"')
    expect(client).toContain('Task StopVoiceAsync(')
    expect(client).toContain('"voice.stop"')
    expect(entry).toContain('helper.Events.Input.ButtonReleased += this.OnVoiceButtonReleased;')
    expect(entry).toContain('private void OnVoiceButtonPressed(')
    expect(entry).toContain('private void OnVoiceButtonReleased(')
    expect(entry).toContain('this.speechBubble.ShowStatus("正在听……")')

    const voicePressedHandler = entry.slice(
      entry.indexOf('private void OnVoiceButtonPressed('),
      entry.indexOf('private void OnVoiceButtonReleased('),
    )
    expect(voicePressedHandler).not.toContain('this.Helper.Input.Suppress(e.Button);')
  })

  it('routes harvest item flights through the presentation layer', () => {
    const actionResult = read('games/stardew-valley/adapter/Game/Actions/ICompanionAction.cs')
    const harvest = read('games/stardew-valley/adapter/Game/Actions/HarvestAllAction.cs')
    const actionModule = read('games/stardew-valley/adapter/Game/Actions/StardewActionModule.cs')
    const presentationContract = read('games/stardew-valley/adapter/Contracts/PresentationEvent.cs')
    const presentationSink = read('games/stardew-valley/adapter/Presentation/GamePresentationSink.cs')
    const effects = read('games/stardew-valley/adapter/Presentation/CompanionEffects.cs')
    const entry = read('games/stardew-valley/adapter/ModEntry.cs')

    expect(actionResult).toContain('IReadOnlyList<ActionItemFlight> ItemFlights')
    expect(harvest).toContain('ItemFlights = itemFlights')
    expect(harvest).not.toContain('class HarvestPerformance')
    expect(actionModule).toContain('new HarvestWhirlwindEffect(')
    expect(presentationContract).toContain('internal sealed record HarvestWhirlwindEffect(')
    expect(presentationSink).toContain('case HarvestWhirlwindEffect harvest:')
    expect(effects).toContain('HarvestWhirlwindAnimation')
    expect(entry).toContain('this.companionEffects.Draw(e.SpriteBatch)')
  })

  it('closes the NamingMenu before dispatching a submitted text turn', () => {
    const entry = read('games/stardew-valley/adapter/ModEntry.cs')
    const callback = entry.slice(
      entry.indexOf('private void OnChatSubmitted(string text)'),
      entry.indexOf('private async Task SendTextChatAsync'),
    )

    expect(callback).toContain('Game1.exitActiveMenu();')
    expect(callback.indexOf('Game1.exitActiveMenu();')).toBeLessThan(callback.indexOf('text = text.Trim();'))
  })

  it('keeps speech captions distinct from transient status text', () => {
    const client = read('games/stardew-valley/adapter/GameAgentClient.cs')
    const entry = read('games/stardew-valley/adapter/ModEntry.cs')

    expect(client).toContain('AssistantSpeechCaptionChanged')
    expect(client).toMatch(/case "assistant\.speech\.phrase":[\s\S]*AssistantSpeechCaptionChanged\?\.Invoke/)
    expect(entry).toMatch(/AssistantSpeechCaptionChanged \+= text =>[\s\S]*speechBubble\.Show\(text\)/)
    expect(entry).not.toContain('this.speechBubble.ShowStatus("正在回答……")')
  })

  it('uses SMAPI-safe save-data keys', () => {
    const life = read('games/stardew-valley/adapter/Game/Companion/CompanionLifeModule.cs')
    const match = life.match(/SaveDataKey = "([^"]+)"/)

    expect(match?.[1]).toBeDefined()
    expect(match?.[1]).toMatch(/^[A-Za-z0-9_.-]+$/)
  })

  it('keeps progression data intact while bypassing all ability gates in test mode', () => {
    const config = read('games/stardew-valley/adapter/ModConfig.cs')
    const abilities = read('games/stardew-valley/adapter/Game/Abilities/AbilityRegistry.cs')
    const entry = read('games/stardew-valley/adapter/ModEntry.cs')

    expect(config).toContain('public bool UnlockAllForTesting { get; set; } = true;')
    expect(abilities).toContain('Func<bool> unlockAllForTesting')
    expect(abilities).toContain('this.unlockAllForTesting()')
    expect(entry).toContain('() => this.config.UnlockAllForTesting')
  })

  it('services Harness requests that arrive before the handshake acknowledgement', () => {
    const protocol = read('games/stardew-valley/adapter/Harness/AdapterProtocolClient.cs')

    expect(protocol).toContain('HandleHostRequestAsync')
    expect(protocol).toContain('while (!timeout.IsCancellationRequested)')
    expect(protocol).toMatch(/HandshakeAsync[\s\S]*HandleHostRequestAsync/)
  })
})

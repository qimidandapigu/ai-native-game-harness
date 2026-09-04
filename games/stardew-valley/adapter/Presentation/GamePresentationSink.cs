using StardewAgentMod.Contracts;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentMod.Presentation;

internal sealed class GamePresentationSink : IPresentationSink
{
    private readonly SpeechBubble bubble;
    private readonly CompanionEffects effects;
    private readonly IMonitor monitor;

    public GamePresentationSink(SpeechBubble bubble, CompanionEffects effects, IMonitor monitor)
    {
        this.bubble = bubble;
        this.effects = effects;
        this.monitor = monitor;
    }

    public void Present(PresentationEvent presentation)
    {
        switch (presentation.Effect)
        {
            case HarvestWhirlwindEffect harvest:
                this.effects.Start(harvest);
                break;
            case ActionCastingEffect casting:
                this.effects.Start(casting);
                break;
            case IdlePulseEffect idle:
                this.effects.SpawnIdle(idle);
                try { Game1.playSound(idle.SoundCue); }
                catch (System.Exception ex) { this.monitor.Log($"[idle] playSound 失败: {ex.Message}", LogLevel.Trace); }
                break;
        }

        if (string.IsNullOrWhiteSpace(presentation.Text)) return;

        switch (presentation.Kind)
        {
            case "assistant.status":
                this.bubble.ShowStatus(presentation.Text);
                break;
            case "assistant.message":
            case "action.completed":
            case "action.rejected":
            case "companion.message":
            case "companion.alert":
                this.bubble.Show(presentation.Text);
                break;
        }

        if (Context.IsWorldReady && presentation.Kind is "action.rejected" or "companion.alert")
            Game1.addHUDMessage(new HUDMessage(presentation.Text, HUDMessage.error_type));
        else if (Context.IsWorldReady && presentation.Kind == "diary.updated")
            Game1.addHUDMessage(new HUDMessage(presentation.Text, HUDMessage.newQuest_type));

        this.monitor.Log($"[呈现] {presentation.Kind}: {presentation.Text}", LogLevel.Trace);
    }
}

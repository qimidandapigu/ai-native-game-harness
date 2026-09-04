using StardewModdingAPI;

namespace StardewAgentMod;

internal sealed class ModConfig
{
    public const int DefaultBubbleYOffset = 56;

    public const int LegacyBubbleYOffset = 220;

    public string GatewayUrl { get; set; } = "ws://127.0.0.1:33145";

    public string AdapterProtocolUrl { get; set; } = "ws://127.0.0.1:33245/adapter";

    public SButton TextChatKey { get; set; } = SButton.T;

    public SButton VoiceChatKey { get; set; } = SButton.V;

    public int BubbleYOffset { get; set; } = DefaultBubbleYOffset;

    public bool ShowCompanion { get; set; } = true;

    public bool RitualsEnabled { get; set; } = true;

    public bool ProactiveEnabled { get; set; } = true;

    public bool DiaryEnabled { get; set; } = true;

    public bool IdleEnabled { get; set; } = true;

    /// <summary>
    /// Temporary acceptance switch: expose every migrated action without
    /// rewriting the save's narrative or growth progress.
    /// </summary>
    public bool UnlockAllForTesting { get; set; } = true;
}

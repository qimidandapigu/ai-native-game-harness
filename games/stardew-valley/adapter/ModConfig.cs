using StardewModdingAPI;

namespace StardewAgentMod;

internal sealed class ModConfig
{
    public const int DefaultBubbleYOffset = 56;

    public const int LegacyBubbleYOffset = 220;

    public string GatewayUrl { get; set; } = "ws://127.0.0.1:33145";

    public SButton TextChatKey { get; set; } = SButton.T;

    public int BubbleYOffset { get; set; } = DefaultBubbleYOffset;

    public bool ShowCompanion { get; set; } = true;
}

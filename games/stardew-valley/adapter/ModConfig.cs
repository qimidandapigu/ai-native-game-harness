using StardewModdingAPI;

namespace StardewAgentMod;

internal sealed class ModConfig
{
    public string GatewayUrl { get; set; } = "ws://127.0.0.1:32145";

    public SButton TextChatKey { get; set; } = SButton.T;

    public int BubbleYOffset { get; set; } = 220;

    public bool ShowCompanion { get; set; } = true;
}

using System;
using StardewModdingAPI;
using StardewModdingAPI.Utilities;

namespace StardewAgentMod.Presentation;

/// <summary>
/// Optional Generic Mod Config Menu adapter. It exposes only game/UI settings;
/// Provider credentials, model selection and voice configuration remain owned by Harness.
/// </summary>
internal static class GameConfigMenu
{
    private const string GenericModConfigMenuId = "spacechase0.GenericModConfigMenu";

    public static void TryRegister(
        IModHelper helper,
        IManifest manifest,
        IMonitor monitor,
        Func<ModConfig> getConfig,
        Action<ModConfig> replaceConfig,
        Action configApplied)
    {
        IGenericModConfigMenuApi? api = helper.ModRegistry.GetApi<IGenericModConfigMenuApi>(GenericModConfigMenuId);
        if (api is null)
        {
            monitor.Log("Generic Mod Config Menu 未安装；继续使用 config.json。", LogLevel.Trace);
            return;
        }

        api.Register(
            manifest,
            reset: () =>
            {
                replaceConfig(new ModConfig());
                configApplied();
            },
            save: () =>
            {
                helper.WriteConfig(getConfig());
                configApplied();
            });

        api.AddParagraph(
            manifest,
            () => "这里只配置星露谷内的按键、显示和陪伴玩法。模型、语音、音色与凭据请在 Harness 中配置。");

        api.AddSectionTitle(manifest, () => "游戏内输入与显示");
        api.AddKeybindList(
            manifest,
            () => new KeybindList(getConfig().TextChatKey),
            value => getConfig().TextChatKey = FirstButtonOr(value, SButton.T),
            () => "文字对话键",
            () => "打开星露谷内的小汤圆文字输入框。");
        api.AddKeybindList(
            manifest,
            () => new KeybindList(getConfig().VoiceChatKey),
            value => getConfig().VoiceChatKey = FirstButtonOr(value, SButton.V),
            () => "按住说话键",
            () => "在游戏内按住说话，松开后交给 Harness 识别与回复。");
        api.AddNumberOption(
            manifest,
            () => getConfig().BubbleYOffset,
            value => getConfig().BubbleYOffset = value,
            () => "气泡高度",
            () => "气泡相对小汤圆向上的像素偏移。",
            min: 80,
            max: 500,
            interval: 10);
        api.AddBoolOption(
            manifest,
            () => getConfig().ShowCompanion,
            value => getConfig().ShowCompanion = value,
            () => "显示小汤圆同伴",
            () => "保存后立即应用；需要 Content Patcher 与 TrinketTinker。");

        api.AddSectionTitle(manifest, () => "陪伴生活");
        api.AddBoolOption(
            manifest,
            () => getConfig().RitualsEnabled,
            value => getConfig().RitualsEnabled = value,
            () => "仪式与问候",
            () => "早晚、深夜、天气和地点触发的陪伴台词。");
        api.AddBoolOption(
            manifest,
            () => getConfig().ProactiveEnabled,
            value => getConfig().ProactiveEnabled = value,
            () => "主动反应",
            () => "每日心愿、剧情/NPC、低状态和收入变化等主动反应。");
        api.AddBoolOption(
            manifest,
            () => getConfig().DiaryEnabled,
            value => getConfig().DiaryEnabled = value,
            () => "每日陪伴日记");
        api.AddBoolOption(
            manifest,
            () => getConfig().IdleEnabled,
            value => getConfig().IdleEnabled = value,
            () => "空闲提示",
            () => "连续沉默 30 秒后播放轻量提示动画和音效。");
        api.AddBoolOption(
            manifest,
            () => getConfig().UnlockAllForTesting,
            value => getConfig().UnlockAllForTesting = value,
            () => "测试期解锁全部能力",
            () => "仅绕过成长与剧情门禁，不改写存档进度，也不会绕过地点、体力和安全规则。");

        monitor.Log("已注册小汤圆星露谷 GMCM 配置页。", LogLevel.Debug);
    }

    private static SButton FirstButtonOr(KeybindList? value, SButton fallback)
    {
        if (value?.Keybinds is not { Length: > 0 } keybinds) return fallback;
        SButton[]? buttons = keybinds[0].Buttons;
        return buttons is { Length: > 0 } ? buttons[0] : fallback;
    }
}

/// <summary>GMCM API 的最小本地声明，避免让可选 UI Mod 成为编译依赖。</summary>
internal interface IGenericModConfigMenuApi
{
    void Register(IManifest mod, Action reset, Action save, bool titleScreenOnly = false);

    void AddSectionTitle(IManifest mod, Func<string> text, Func<string>? tooltip = null);

    void AddParagraph(IManifest mod, Func<string> text);

    void AddBoolOption(
        IManifest mod,
        Func<bool> getValue,
        Action<bool> setValue,
        Func<string> name,
        Func<string>? tooltip = null,
        string? fieldId = null);

    void AddNumberOption(
        IManifest mod,
        Func<int> getValue,
        Action<int> setValue,
        Func<string> name,
        Func<string>? tooltip = null,
        int? min = null,
        int? max = null,
        int? interval = null,
        Func<int, string>? formatValue = null,
        string? fieldId = null);

    void AddKeybindList(
        IManifest mod,
        Func<KeybindList> getValue,
        Action<KeybindList> setValue,
        Func<string> name,
        Func<string>? tooltip = null,
        string? fieldId = null);
}

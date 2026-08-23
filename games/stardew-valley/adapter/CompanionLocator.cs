using System;
using System.Reflection;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Delegates;
using StardewValley.Objects.Trinkets;
using StardewValley.Triggers;

namespace StardewAgentMod;

internal sealed class CompanionLocator
{
    private const string CompanionItemPrefix = "(TR)qimidandapigu.XiaoTangYuanCompanion_Companion";
    private const string EquipAction = "mushymato.TrinketTinker_EquipHiddenTrinket";
    private const string UnequipAction = "mushymato.TrinketTinker_UnequipHiddenTrinket";

    private readonly IModHelper helper;
    private readonly IMonitor monitor;
    private PropertyInfo? positionProperty;
    private Type? effectType;

    public CompanionLocator(IModHelper helper, IMonitor monitor)
    {
        this.helper = helper;
        this.monitor = monitor;
    }

    public void ApplyEnabled(bool enabled, CompanionForm form = CompanionForm.Seed)
    {
        if (!Context.IsWorldReady || Game1.player is null) return;
        if (!this.helper.ModRegistry.IsLoaded("mushymato.TrinketTinker"))
        {
            this.monitor.Log("TrinketTinker 未加载，无法创建小汤圆同伴。", LogLevel.Warn);
            return;
        }

        string desiredItemId = GetItemId(form);
        foreach (string itemId in GetAllItemIds())
        {
            if (enabled && itemId == desiredItemId) continue;
            for (int attempt = 0; attempt < 8 && this.IsEquipped(itemId); attempt++)
                this.RunAction($"{UnequipAction} {itemId}");
        }

        if (enabled && !this.IsEquipped(desiredItemId))
            this.RunAction($"{EquipAction} {desiredItemId} 0 0 -1 false");
    }

    public Vector2? TryGetWorldPosition()
    {
        try
        {
            foreach (Trinket? trinket in Game1.player?.trinketItems ?? [])
            {
                if (trinket is null || !IsCompanionItem(trinket.QualifiedItemId)) continue;
                object? effect = trinket.GetEffect();
                if (effect is null) continue;
                if (this.effectType != effect.GetType())
                {
                    this.effectType = effect.GetType();
                    this.positionProperty = this.effectType.GetProperty("CompanionPosOff")
                        ?? this.effectType.GetProperty("CompanionPosition");
                }
                if (this.positionProperty?.GetValue(effect) is Vector2 position) return position;
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    private bool IsEquipped(string itemId)
    {
        if (Game1.player?.trinketItems is null) return false;
        foreach (Trinket? trinket in Game1.player.trinketItems)
        {
            if (trinket?.QualifiedItemId == itemId) return true;
        }
        return false;
    }

    private static bool IsCompanionItem(string itemId)
    {
        foreach (string candidate in GetAllItemIds())
        {
            if (itemId == candidate) return true;
        }
        return false;
    }

    private static string GetItemId(CompanionForm form) => form switch
    {
        CompanionForm.Combat => CompanionItemPrefix + "_Combat",
        CompanionForm.Farming => CompanionItemPrefix + "_Farming",
        CompanionForm.Fishing => CompanionItemPrefix + "_Fishing",
        _ => CompanionItemPrefix
    };

    private static string[] GetAllItemIds() =>
    [
        CompanionItemPrefix,
        CompanionItemPrefix + "_Combat",
        CompanionItemPrefix + "_Farming",
        CompanionItemPrefix + "_Fishing"
    ];

    private void RunAction(string actionText)
    {
        try
        {
            CachedAction action = TriggerActionManager.ParseAction(actionText);
            TriggerActionContext context = new(
                "qimidandapigu.StardewAgent_Companion",
                [],
                null,
                []
            );
            if (!TriggerActionManager.TryRunAction(action, context, out string error, out Exception exception))
                this.monitor.Log($"小汤圆同伴组件操作失败：{error} {exception?.Message}", LogLevel.Warn);
        }
        catch (Exception ex)
        {
            this.monitor.Log($"小汤圆同伴组件操作失败：{ex.Message}", LogLevel.Warn);
        }
    }
}

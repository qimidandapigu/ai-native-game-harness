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
    private PropertyInfo? boundingBoxProperty;
    private Type? effectType;
    private object? appearanceEffect;
    private MethodInfo? setAltVariantMethod;
    private string? appliedAltVariant;
    private object? visibilityCompanion;
    private FieldInfo? companionField;
    private MethodInfo? setDisableCompanionMethod;
    private bool? appliedHidden;

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
                    this.boundingBoxProperty = this.effectType.GetProperty("CompanionBoundingBox");
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

    public Rectangle? TryGetWorldBoundingBox()
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
                    this.boundingBoxProperty = this.effectType.GetProperty("CompanionBoundingBox");
                }
                if (this.boundingBoxProperty?.GetValue(effect) is Rectangle bounds) return bounds;
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    public bool TrySetAltVariant(string key)
    {
        try
        {
            object? effect = this.TryGetEffect();
            if (effect is null) return false;
            if (!ReferenceEquals(effect, this.appearanceEffect))
            {
                this.appearanceEffect = effect;
                this.setAltVariantMethod = effect.GetType().GetMethod(
                    "SetAltVariant",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    binder: null,
                    types: new[] { typeof(string) },
                    modifiers: null);
                this.appliedAltVariant = null;
            }
            if (this.setAltVariantMethod is null) return false;
            if (string.Equals(this.appliedAltVariant, key, StringComparison.Ordinal)) return true;
            this.setAltVariantMethod.Invoke(effect, new object[] { key });
            this.appliedAltVariant = key;
            return true;
        }
        catch (Exception ex)
        {
            this.monitor.Log($"小汤圆外观切换失败：{ex.GetBaseException().Message}", LogLevel.Trace);
            return false;
        }
    }

    public bool TrySetCompanionHidden(bool hidden)
    {
        try
        {
            object? effect = this.TryGetEffect();
            if (effect is null) return false;
            this.companionField ??= effect.GetType().GetField(
                "Companion",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            object? companion = this.companionField?.GetValue(effect);
            if (companion is null) return false;
            if (!ReferenceEquals(companion, this.visibilityCompanion))
            {
                this.visibilityCompanion = companion;
                this.setDisableCompanionMethod = companion.GetType().GetMethod(
                    "SetDisableCompanion",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    binder: null,
                    types: new[] { typeof(bool), typeof(byte) },
                    modifiers: null);
                this.appliedHidden = null;
            }
            if (this.setDisableCompanionMethod is null) return false;
            if (this.appliedHidden == hidden) return true;
            this.setDisableCompanionMethod.Invoke(companion, new object[] { hidden, (byte)7 });
            this.appliedHidden = hidden;
            return true;
        }
        catch (Exception ex)
        {
            this.monitor.Log($"小汤圆显隐切换失败：{ex.GetBaseException().Message}", LogLevel.Trace);
            return false;
        }
    }

    public void ResetAppearanceCache()
    {
        this.appearanceEffect = null;
        this.setAltVariantMethod = null;
        this.appliedAltVariant = null;
        this.visibilityCompanion = null;
        this.companionField = null;
        this.setDisableCompanionMethod = null;
        this.appliedHidden = null;
    }

    private object? TryGetEffect()
    {
        foreach (Trinket? trinket in Game1.player?.trinketItems ?? [])
        {
            if (trinket is not null && IsCompanionItem(trinket.QualifiedItemId))
                return trinket.GetEffect();
        }
        return null;
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

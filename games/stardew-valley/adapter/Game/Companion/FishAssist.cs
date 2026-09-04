using System;
using System.Reflection;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentMod.Game.Companion
{
    /// <summary>
    /// 自助钓鱼:农夫开口请豆包帮忙(intent=fish_help)后"挂起"一次协助,
    /// 等下一次钓鱼小游戏(BobberBar)弹出时自动完美收杆,消耗 1 点体力。
    ///
    /// 设计:
    ///   - Arm() 只挂起(此刻可能还没在钓),20 秒内没开钓自动作废(不白扣体力)。
    ///   - 真正命中一次 BobberBar 时才 TrySpend(1);扣不到(理论上不会,Arm 前已 gate)则放弃。
    ///   - 一次请求只包一条鱼:鱼咬钩进入小游戏 → 完美拉满 → 收杆后解除挂起。
    ///   - distanceFromCatching 拉满 = 判定收杆成功;用反射兜底字段可见性差异。
    /// </summary>
    internal sealed class FishAssist
    {
        private const long ArmTimeoutTicks = 200_000_000L;  // ~20s 没开钓就作废

        private readonly IMonitor monitor;
        private readonly CompanionStamina stamina;
        private readonly Action speakNoStamina;
        private readonly Func<bool> getEnabled;

        private bool armed;
        private long armedAtTicks;
        private bool chargedThisArm;     // 本次挂起是否已扣过体力(= 已咬钩进小游戏)
        private bool sawBar;             // 本次挂起是否见过 BobberBar(用于检测收杆完成)

        private static readonly FieldInfo? DistField =
            typeof(BobberBar).GetField("distanceFromCatching",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

        public FishAssist(IMonitor monitor, CompanionStamina stamina, Action speakNoStamina, Func<bool> getEnabled)
        {
            this.monitor = monitor;
            this.stamina = stamina;
            this.speakNoStamina = speakNoStamina;
            this.getEnabled = getEnabled;
        }

        /// <summary>挂起一次钓鱼协助(由 ModEntry 在 intent=fish_help 且有体力时调用)。</summary>
        public void Arm()
        {
            this.armed = true;
            this.chargedThisArm = false;
            this.sawBar = false;
            this.armedAtTicks = Now();
            this.monitor.Log("[体力] 钓鱼协助已挂起,等下一杆", LogLevel.Info);
        }

        public void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (!this.armed) return;
            if (!Context.IsWorldReady || !this.getEnabled()) { this.Disarm(); return; }

            // 当前是不是在钓鱼小游戏里?
            if (Game1.activeClickableMenu is BobberBar bar)
            {
                this.sawBar = true;

                // 第一次进小游戏 → 扣体力(扣不到就放弃,不强行帮)
                if (!this.chargedThisArm)
                {
                    if (!this.stamina.TrySpend(1))
                    {
                        this.Disarm();
                        this.speakNoStamina();
                        return;
                    }
                    this.chargedThisArm = true;
                    this.monitor.Log("[体力] 自助钓鱼:完美收杆中", LogLevel.Info);
                }

                // 把"收杆进度"拉满 → 判定完美上鱼
                try { DistField?.SetValue(bar, 1f); }
                catch (Exception ex) { this.monitor.Log($"[体力] 钓鱼反射失败: {ex.Message}", LogLevel.Warn); }
                return;
            }

            // 已经钓完(小游戏关了)→ 解除挂起
            if (this.sawBar && this.chargedThisArm)
            {
                this.Disarm();
                return;
            }

            // 一直没开钓 → 超时作废(不扣体力)
            if (Now() - this.armedAtTicks > ArmTimeoutTicks)
            {
                this.monitor.Log("[体力] 钓鱼协助超时未开钓,作废", LogLevel.Trace);
                this.Disarm();
            }
        }

        private void Disarm()
        {
            this.armed = false;
            this.chargedThisArm = false;
            this.sawBar = false;
        }

        private static long Now() => Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
    }
}

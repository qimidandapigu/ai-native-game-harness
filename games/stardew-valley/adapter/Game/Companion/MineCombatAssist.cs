using System;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using Microsoft.Xna.Framework;
using StardewValley;

namespace StardewAgentMod.Game.Companion
{
    /// <summary>
    /// 矿洞打怪协助:农夫请豆包帮忙(intent=mine_combat)且有体力时,
    /// 开启一段限时协助窗口(~10 秒),期间每隔几帧自动对农夫附近的怪造成伤害。
    ///
    /// 设计(已与用户确认):1 点体力 = 一段限时协助窗口(不是逐怪扣)。
    ///   - 伤害挂在农夫名下(who=Game1.player),击杀/经验照常算农夫的。
    ///   - 半径约 3 格,中等伤害 + 击退,既帮得上忙又不至于让玩家躺平。
    ///   - 窗口靠 UpdateTicked 推进,到点自动结束。
    /// </summary>
    internal sealed class MineCombatAssist
    {
        private const long WindowTicks = 100_000_000L;  // ~10s
        private const int HitEveryTicks = 18;           // ~0.3s 一次 AOE
        private const int RadiusTiles = 3;
        private const int MinDamage = 20;
        private const int MaxDamage = 45;

        private readonly IMonitor monitor;
        private readonly Func<bool> getEnabled;

        private long activeUntilTicks;
        private int tickCounter;

        public MineCombatAssist(IMonitor monitor, Func<bool> getEnabled)
        {
            this.monitor = monitor;
            this.getEnabled = getEnabled;
        }

        public bool IsActive => Now() < this.activeUntilTicks;

        /// <summary>开启协助窗口(由 ModEntry 在 intent=mine_combat 且已扣体力后调用)。</summary>
        public void Activate()
        {
            this.activeUntilTicks = Now() + WindowTicks;
            this.tickCounter = 0;
            this.monitor.Log("[体力] 打怪协助窗口开启(~10s)", LogLevel.Info);
        }

        public void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (!this.IsActive) return;
            if (!Context.IsWorldReady || !this.getEnabled()) { this.activeUntilTicks = 0; return; }

            if (++this.tickCounter < HitEveryTicks) return;
            this.tickCounter = 0;

            try
            {
                var who = Game1.player;
                var location = who?.currentLocation;
                if (location == null) return;

                int r = RadiusTiles * Game1.tileSize;
                var box = who!.GetBoundingBox();
                var area = new Rectangle(box.Center.X - r, box.Center.Y - r, r * 2, r * 2);

                // 对范围内所有怪造成一次伤害(豆包替农夫出手,击杀算农夫的)
                location.damageMonster(area, MinDamage, MaxDamage, false, who);
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[体力] 打怪协助异常: {ex.Message}", LogLevel.Warn);
                this.activeUntilTicks = 0;  // 出错就收掉窗口,别每帧刷错
            }
        }

        private static long Now() => Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
    }
}

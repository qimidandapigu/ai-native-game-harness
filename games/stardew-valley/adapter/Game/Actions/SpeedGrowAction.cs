using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using StardewAgentMod.Game.Abilities;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>
    /// 把当前地图里已播种但未成熟的作物催到"只差一夜"。
    ///
    /// 玩家播完种后请求豆包催熟,当天不会立刻收,睡一觉后作物会在原版过夜成长里进入可收获阶段。
    /// 顺手把地设为 watered,避免忘浇水导致第二天没长。
    /// </summary>
    internal sealed class SpeedGrowAction : ICompanionAction
    {
        private readonly IMonitor monitor;

        public SpeedGrowAction(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        public string Intent => AbilityRegistry.SpeedGrow;

        public ActionResult Execute(GameLocation location)
        {
            var targets = new List<Vector2>();
            int count = 0;

            void PrepareIfGrowing(HoeDirt dirt, Vector2 tile, string source)
            {
                if (dirt.crop == null || dirt.readyForHarvest()) return;

                try
                {
                    if (!PrepareForTomorrow(dirt)) return;

                    dirt.state.Value = HoeDirt.watered;
                    targets.Add(new Vector2(
                        tile.X * Game1.tileSize + Game1.tileSize / 2,
                        tile.Y * Game1.tileSize + Game1.tileSize / 2));
                    count++;
                }
                catch (Exception ex)
                {
                    this.monitor.Log($"[催熟] {source} tile {tile} 失败: {ex.Message}", LogLevel.Trace);
                }
            }

            if (location?.terrainFeatures?.Pairs != null)
            {
                foreach (var pair in location.terrainFeatures.Pairs)
                {
                    if (pair.Value is HoeDirt dirt)
                        PrepareIfGrowing(dirt, pair.Key, "TF");
                }
            }

            if (location?.Objects?.Pairs != null)
            {
                foreach (var pair in location.Objects.Pairs)
                {
                    if (pair.Value is IndoorPot pot && pot.hoeDirt?.Value is HoeDirt potDirt)
                        PrepareIfGrowing(potDirt, pair.Key, "Pot");
                }
            }

            return new ActionResult
            {
                Count = count,
                ActionDescription = count > 0
                    ? $"我帮农夫把 {count} 株作物催到明天可收"
                    : "",
                Targets = targets,
                FxColor = new Color(120, 230, 120),
                DonePool = CannedLines.SpeedGrowDone,
                NothingPool = CannedLines.SpeedGrowNothing
            };
        }

        private static bool PrepareForTomorrow(HoeDirt dirt)
        {
            var crop = dirt.crop;
            if (crop == null || dirt.readyForHarvest()) return false;

            int finalPhase = crop.phaseDays.Count - 1;
            if (finalPhase <= 0)
            {
                crop.currentPhase.Value = Math.Max(0, finalPhase);
                crop.dayOfCurrentPhase.Value = 0;
                crop.fullyGrown.Value = true;
                return true;
            }

            // 初次成长:放到最后一个未成熟阶段的最后一天。过夜成长后进入最终成熟阶段。
            if (!crop.fullyGrown.Value && crop.currentPhase.Value < finalPhase)
            {
                int targetPhase = finalPhase - 1;
                crop.currentPhase.Value = targetPhase;
                int phaseLength = targetPhase >= 0 && targetPhase < crop.phaseDays.Count
                    ? crop.phaseDays[targetPhase]
                    : 1;
                crop.dayOfCurrentPhase.Value = Math.Max(0, phaseLength - 1);
                return true;
            }

            // 多次收获作物的再生期通常已经 fullyGrown,但 readyForHarvest=false。
            // 这时 dayOfCurrentPhase 多数是倒计时,压到 1 可让它第二天重新可收。
            crop.dayOfCurrentPhase.Value = 1;
            return true;
        }
    }
}

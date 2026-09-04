using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>
    /// 把当前 GameLocation 里所有 dry 的 HoeDirt 一次性浇遍。
    ///
    /// 范围 = 玩家当前所在的 location 里的所有 HoeDirt:
    ///   - terrainFeatures 里的(普通地上的田)
    ///   - Objects 里 IndoorPot 包着的(屋里/温室常见的花盆)
    /// </summary>
    internal sealed class WaterAllAction : ICompanionAction
    {
        public string Intent => "water_all";

        public ActionResult Execute(GameLocation location)
        {
            var targets = new List<Vector2>();
            int count = 0;

            void WaterIfDry(HoeDirt dirt, Vector2 tile)
            {
                if (dirt.state.Value != HoeDirt.dry) return;
                dirt.state.Value = HoeDirt.watered;
                targets.Add(new Vector2(
                    tile.X * Game1.tileSize + Game1.tileSize / 2,
                    tile.Y * Game1.tileSize + Game1.tileSize / 2));
                count++;
            }

            if (location?.terrainFeatures?.Pairs != null)
            {
                foreach (var pair in location.terrainFeatures.Pairs)
                {
                    if (pair.Value is HoeDirt dirt) WaterIfDry(dirt, pair.Key);
                }
            }
            if (location?.Objects?.Pairs != null)
            {
                foreach (var pair in location.Objects.Pairs)
                {
                    if (pair.Value is IndoorPot pot && pot.hoeDirt?.Value != null)
                        WaterIfDry(pot.hoeDirt.Value, pair.Key);
                }
            }

            return new ActionResult
            {
                Count = count,
                ActionDescription = count > 0
                    ? $"我帮农夫浇了 {count} 块田"
                    : "",  // 没活儿就不入 chatlist
                Targets = targets,
                FxColor = new Color(80, 170, 255),  // 蓝色水光
                DonePool = CannedLines.WaterDone,
                NothingPool = CannedLines.WaterNothing
            };
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.TerrainFeatures;
using StardewAgentMod.Game.Abilities;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>
    /// 把玩家当前选中的种子种到规划后的农田里。
    /// 农场室外会规划连续直边空地并统一开垦;其他地图仍只处理已经锄好的空地。
    /// 每次成功播种时优先消耗真实库存,库存耗尽后继续完成整片规划。
    /// </summary>
    internal sealed class PlantSeedsAction : ICompanionAction
    {
        private readonly IMonitor monitor;
        private readonly FieldPlanner fieldPlanner;

        public PlantSeedsAction(IMonitor monitor, FieldPlanner fieldPlanner)
        {
            this.monitor = monitor;
            this.fieldPlanner = fieldPlanner;
        }

        public string Intent => AbilityRegistry.PlantSeedsAll;

        /// <summary>兼容普通 action 调用的即时执行入口;演出路径使用 CreatePlan + PlantingPerformance。</summary>
        public ActionResult Execute(GameLocation location)
        {
            Farmer? player = Game1.player;
            PlantingPlan? plan = this.CreatePlan(location);
            if (player == null || plan == null || plan.Count <= 0) return Empty();

            var plantedTargets = new List<Vector2>();
            int consumedSeeds = 0;
            foreach (PlantingTarget target in plan.Targets)
            {
                try
                {
                    if (!TryPrepareTarget(target)) continue;
                    if (!TryPlant(target, plan.SeedItemId, player)) continue;
                    if (ConsumeOneSeedIfAvailable(player, plan.SeedQualifiedItemId))
                        consumedSeeds++;
                    plantedTargets.Add(target.WorldCenter);
                }
                catch (Exception ex)
                {
                    this.monitor.Log($"[播种] tile {target.Tile} 失败: {ex.Message}", LogLevel.Trace);
                }
            }

            this.monitor.Log(
                $"[播种] 完成 {plantedTargets.Count} 格,实际消耗种子 {consumedSeeds} 颗,"
                + $"免费续种 {plantedTargets.Count - consumedSeeds} 格。",
                LogLevel.Info);

            return BuildResult(plantedTargets.Count, plan.SeedName, plantedTargets);
        }

        /// <summary>所有地图先收集已有空耕地,农场再追加连续直边空地的开垦目标。</summary>
        public PlantingPlan? CreatePlan(GameLocation location)
        {
            Farmer? player = Game1.player;
            if (player == null || location == null) return null;

            if (!TryGetSelectedSeed(player, out string seedItemId, out string seedQualifiedId, out string seedName))
                return null;

            var targets = new List<PlantingTarget>();
            if (location.terrainFeatures?.Pairs != null)
            {
                foreach (var pair in location.terrainFeatures.Pairs)
                {
                    if (pair.Value is HoeDirt dirt
                        && dirt.crop == null
                        && !location.Objects.ContainsKey(pair.Key)
                        && CanPlantAt(location, pair.Key, seedItemId))
                        targets.Add(new PlantingTarget(location, pair.Key, requiresTilling: false));
                }
            }

            FieldAreaPlan areaPlan = this.fieldPlanner.CreateAreaPlan(location, seedItemId);
            if (areaPlan.AppliesToLocation)
            {
                targets.AddRange(areaPlan.TillingTiles.Select(tile =>
                    new PlantingTarget(location, tile, requiresTilling: true)));
            }

            if (targets.Count == 0) return null;

            IReadOnlyList<PlantingTarget> ordered = OrderSerpentine(
                targets
                    .GroupBy(target => target.Tile)
                    .Select(group => group.First())
                    .ToArray(),
                player.Tile);
            return ordered.Count > 0
                ? new PlantingPlan(location, ordered, seedItemId, seedQualifiedId, seedName)
                : null;
        }

        /// <summary>成功落种后尝试消耗一颗真实种子;库存为空时返回 false 但不阻断播种。</summary>
        internal static bool ConsumeOneSeedIfAvailable(Farmer player, string qualifiedItemId)
        {
            int selectedIndex = player.CurrentToolIndex;
            if (selectedIndex >= 0 && selectedIndex < player.Items.Count)
            {
                Item? selected = player.Items[selectedIndex];
                if (selected?.QualifiedItemId == qualifiedItemId && selected.Stack > 0)
                {
                    selected.Stack--;
                    if (selected.Stack <= 0)
                        player.Items[selectedIndex] = null;
                    return true;
                }
            }

            for (int i = 0; i < player.Items.Count; i++)
            {
                if (i == selectedIndex) continue;
                Item? item = player.Items[i];
                if (item?.QualifiedItemId != qualifiedItemId || item.Stack <= 0) continue;

                item.Stack--;
                if (item.Stack <= 0)
                    player.Items[i] = null;
                return true;
            }

            return false;
        }

        internal static bool TryPrepareTarget(PlantingTarget target)
        {
            if (target.TryGetDirt(out HoeDirt? existing) && existing != null)
                return existing.crop == null;
            if (!target.RequiresTilling)
                return false;

            bool created = target.Location.makeHoeDirt(target.Tile, ignoreChecks: false);
            return created
                && target.TryGetDirt(out HoeDirt? prepared)
                && prepared != null
                && prepared.crop == null;
        }

        internal static bool TryPlant(PlantingTarget target, string seedItemId, Farmer player)
        {
            if (!target.TryGetDirt(out HoeDirt? dirt) || dirt == null || dirt.crop != null) return false;
            return dirt.plant(seedItemId, player, false);
        }

        internal static ActionResult BuildResult(
            int count,
            string seedName,
            IReadOnlyList<Vector2> plantedTargets)
        {
            return new ActionResult
            {
                Count = count,
                ActionDescription = count > 0
                    ? $"我帮农夫种了 {count} 颗{seedName}"
                    : "",
                Targets = plantedTargets,
                FxColor = new Color(120, 210, 90),
                DonePool = CannedLines.PlantDone,
                DoneLine = count > 0 ? $"种好了,{seedName}排排站。顺手浇水去。" : null,
                NothingPool = CannedLines.PlantNothing
            };
        }

        private static ActionResult Empty()
        {
            return new ActionResult
            {
                Count = 0,
                NothingPool = CannedLines.PlantNothing
            };
        }

        private static bool TryGetSelectedSeed(
            Farmer player,
            out string itemId,
            out string qualifiedItemId,
            out string displayName)
        {
            itemId = "";
            qualifiedItemId = "";
            displayName = "";

            if (player.CurrentItem is not StardewValley.Object seed) return false;
            if (seed.Category != StardewValley.Object.SeedsCategory || seed.Stack <= 0) return false;

            itemId = seed.ItemId;
            qualifiedItemId = seed.QualifiedItemId;
            displayName = seed.DisplayName;
            return !string.IsNullOrWhiteSpace(itemId) && !string.IsNullOrWhiteSpace(qualifiedItemId);
        }

        private static bool CanPlantAt(GameLocation location, Vector2 tile, string seedItemId)
        {
            try
            {
                return location.CanPlantSeedsHere(
                    seedItemId,
                    (int)tile.X,
                    (int)tile.Y,
                    false,
                    out _);
            }
            catch
            {
                return false;
            }
        }

        private static IReadOnlyList<PlantingTarget> OrderSerpentine(
            IReadOnlyList<PlantingTarget> targets,
            Vector2 playerTile)
        {
            var rows = targets
                .GroupBy(target => (int)target.Tile.Y)
                .OrderBy(group => group.Key)
                .ToList();
            if (rows.Count == 0) return Array.Empty<PlantingTarget>();

            int minY = rows[0].Key;
            int maxY = rows[^1].Key;
            if (Math.Abs(playerTile.Y - maxY) < Math.Abs(playerTile.Y - minY))
                rows.Reverse();

            float minX = targets.Min(target => target.Tile.X);
            float maxX = targets.Max(target => target.Tile.X);
            bool leftToRight = Math.Abs(playerTile.X - minX) <= Math.Abs(playerTile.X - maxX);
            var result = new List<PlantingTarget>(targets.Count);

            foreach (var row in rows)
            {
                IEnumerable<PlantingTarget> orderedRow = leftToRight
                    ? row.OrderBy(target => target.Tile.X)
                    : row.OrderByDescending(target => target.Tile.X);
                result.AddRange(orderedRow);
                leftToRight = !leftToRight;
            }

            return result;
        }
    }

    internal sealed class PlantingTarget
    {
        public PlantingTarget(GameLocation location, Vector2 tile, bool requiresTilling)
        {
            this.Location = location;
            this.Tile = tile;
            this.RequiresTilling = requiresTilling;
        }

        public GameLocation Location { get; }
        public Vector2 Tile { get; }
        public bool RequiresTilling { get; }

        public Vector2 WorldCenter => new(
            this.Tile.X * Game1.tileSize + Game1.tileSize / 2f,
            this.Tile.Y * Game1.tileSize + Game1.tileSize / 2f);

        public bool TryGetDirt(out HoeDirt? dirt)
        {
            dirt = null;
            if (!this.Location.terrainFeatures.TryGetValue(this.Tile, out TerrainFeature? feature)
                || feature is not HoeDirt found)
                return false;
            dirt = found;
            return true;
        }
    }

    internal sealed class PlantingPlan
    {
        public PlantingPlan(
            GameLocation location,
            IReadOnlyList<PlantingTarget> targets,
            string seedItemId,
            string seedQualifiedItemId,
            string seedName)
        {
            this.Location = location;
            this.Targets = targets;
            this.SeedItemId = seedItemId;
            this.SeedQualifiedItemId = seedQualifiedItemId;
            this.SeedName = seedName;
        }

        public GameLocation Location { get; }
        public IReadOnlyList<PlantingTarget> Targets { get; }
        public string SeedItemId { get; }
        public string SeedQualifiedItemId { get; }
        public string SeedName { get; }
        public int Count => this.Targets.Count;
        public int TillingCount => this.Targets.Count(target => target.RequiresTilling);

    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>
    /// 把当前 GameLocation 里所有成熟的 Crop 一次性收掉。
    ///
    /// 用 Crop.harvest() 本身的 API,行为跟玩家用工具收一致:
    ///   - 物品优先加入背包;背包放不下时转入当前地图最近的普通储物箱
    ///   - 一次性作物(萝卜/土豆/南瓜)的 HoeDirt.crop 设为 null
    ///   - 多收作物(蓝莓/咖啡)reset 到 regrow 阶段,留在田里
    /// </summary>
    internal sealed class HarvestAllAction : ICompanionAction
    {
        private readonly IMonitor monitor;

        public HarvestAllAction(IMonitor monitor) { this.monitor = monitor; }

        public string Intent => "harvest_all";

        public ActionResult Execute(GameLocation location)
        {
            var plan = this.CreatePlan(location);
            var harvestedNames = new Dictionary<string, int>();
            var harvestedTargets = new List<Vector2>();
            var itemFlights = new List<ActionItemFlight>();
            int count = 0;

            foreach (var target in plan.Targets)
            {
                try
                {
                    if (TryHarvest(target, this.monitor))
                    {
                        count++;
                        harvestedTargets.Add(target.WorldCenter);
                        if (!string.IsNullOrWhiteSpace(target.QualifiedItemId))
                            itemFlights.Add(new ActionItemFlight(target.QualifiedItemId, target.WorldCenter));
                        if (!string.IsNullOrWhiteSpace(target.CropName))
                            harvestedNames[target.CropName] = harvestedNames.TryGetValue(target.CropName, out int old) ? old + 1 : 1;
                    }
                }
                catch (Exception ex)
                {
                    this.monitor?.Log($"[收割] tile {target.Tile} 失败: {ex.Message}", LogLevel.Trace);
                }
            }

            return BuildResult(count, harvestedNames, harvestedTargets, itemFlights);
        }

        public HarvestPlan CreatePlan(GameLocation location)
        {
            var targets = new List<HarvestTarget>();

            if (location != null)
            {
                // 先收集再采集 —— 防止迭代过程中改字典出 InvalidOperationException
                if (location.terrainFeatures?.Pairs != null)
                {
                    foreach (var pair in location.terrainFeatures.Pairs)
                    {
                        if (pair.Value is HoeDirt dirt && dirt.crop != null && dirt.readyForHarvest())
                            targets.Add(CreateTarget(location, pair.Key, dirt));
                    }
                }

                if (location.Objects?.Pairs != null)
                {
                    foreach (var pair in location.Objects.Pairs)
                    {
                        if (pair.Value is IndoorPot pot
                            && pot.hoeDirt?.Value is HoeDirt potDirt
                            && potDirt.crop != null
                            && potDirt.readyForHarvest())
                            targets.Add(CreateTarget(location, pair.Key, potDirt));
                    }
                }
            }

            var names = targets
                .Where(target => !string.IsNullOrWhiteSpace(target.CropName))
                .GroupBy(target => target.CropName)
                .ToDictionary(group => group.Key, group => group.Count());

            return new HarvestPlan(targets, CannedLines.BuildHarvestSong(TopCropNames(names)));
        }

        internal static bool TryHarvest(HarvestTarget target, IMonitor? monitor)
        {
            Farmer? player = Game1.player;
            if (player == null) return false;
            if (target.Dirt.crop == null || !target.Dirt.readyForHarvest()) return false;

            var overflowChests = FindOverflowChests(target);
            var existingDebris = new HashSet<Debris>(target.Location.debris);
            try
            {
                int temporarySlot = FindTemporaryInventorySlot(player);
                if (temporarySlot < 0 || overflowChests.Count == 0 || player.freeSpotsInInventory() > 0)
                    return HarvestCrop(target);

                Item heldItem = player.Items[temporarySlot]!;
                player.Items[temporarySlot] = null;
                Item? overflowItem;
                bool harvested;
                try
                {
                    harvested = HarvestCrop(target);
                    overflowItem = player.Items[temporarySlot];
                    player.Items[temporarySlot] = heldItem;
                }
                catch
                {
                    overflowItem = player.Items[temporarySlot];
                    player.Items[temporarySlot] = heldItem;
                    if (overflowItem != null)
                        DepositOverflowOrDrop(overflowItem, target, overflowChests, monitor);
                    throw;
                }

                if (overflowItem != null)
                {
                    DepositOverflowOrDrop(overflowItem, target, overflowChests, monitor);
                    harvested = true;
                }

                return harvested;
            }
            finally
            {
                CollectNewHarvestDebris(player, target, existingDebris, overflowChests, monitor);
            }
        }

        private static bool HarvestCrop(HarvestTarget target)
        {
            HoeDirt dirt = target.Dirt;
            Crop? crop = dirt.crop;
            if (crop == null || !dirt.readyForHarvest()) return false;

            // Crop.harvest 的 bool 表示“收获后是否移除植株”,不是“是否收获成功”。
            // 草莓等再生作物成功时会返回 false,但 readyForHarvest 会变为 false。
            bool removeCrop = crop.harvest((int)target.Tile.X, (int)target.Tile.Y, dirt);
            bool harvested = removeCrop || dirt.crop == null || !dirt.readyForHarvest();
            if (!harvested) return false;

            if (removeCrop && ReferenceEquals(dirt.crop, crop))
                dirt.crop = null;

            try { Game1.playSound("harvest"); } catch { }
            return true;
        }

        private static List<(Vector2 Tile, Chest Chest)> FindOverflowChests(HarvestTarget target)
        {
            return ItemStorage.FindRegularChests(target.Location, target.Tile);
        }

        private static int FindTemporaryInventorySlot(Farmer player)
        {
            int usableSlots = Math.Min(player.MaxItems, player.Items.Count);
            for (int i = usableSlots - 1; i >= 0; i--)
            {
                if (i != player.CurrentToolIndex && player.Items[i] != null)
                    return i;
            }

            return player.CurrentToolIndex >= 0
                && player.CurrentToolIndex < usableSlots
                && player.Items[player.CurrentToolIndex] != null
                    ? player.CurrentToolIndex
                    : -1;
        }

        private static void DepositOverflowOrDrop(
            Item overflow,
            HarvestTarget target,
            IReadOnlyList<(Vector2 Tile, Chest Chest)> chests,
            IMonitor? monitor)
        {
            Item? remaining = DepositIntoChests(overflow, chests, monitor);
            if (remaining == null || remaining.Stack <= 0) return;

            Game1.createItemDebris(remaining, target.WorldCenter, -1, target.Location);
            monitor?.Log(
                $"[收割] 储物箱容量不足,{remaining.DisplayName} x{remaining.Stack} 已落在作物旁边",
                LogLevel.Warn);
        }

        private static Item? DepositIntoChests(
            Item item,
            IReadOnlyList<(Vector2 Tile, Chest Chest)> chests,
            IMonitor? monitor)
        {
            return ItemStorage.DepositIntoChests(item, chests, monitor, "[收割]");
        }

        private static void CollectNewHarvestDebris(
            Farmer player,
            HarvestTarget target,
            HashSet<Debris> existingDebris,
            IReadOnlyList<(Vector2 Tile, Chest Chest)> chests,
            IMonitor? monitor)
        {
            int collected = 0;
            foreach (Debris debris in target.Location.debris.ToArray())
            {
                if (existingDebris.Contains(debris)) continue;

                try
                {
                    Item? droppedItem = debris.item;
                    if (droppedItem == null || droppedItem.Stack <= 0) continue;

                    int before = droppedItem.Stack;
                    Item? remaining = droppedItem;
                    debris.item = null;
                    try
                    {
                        remaining = player.addItemToInventory(remaining);
                        if (remaining != null && remaining.Stack > 0)
                            remaining = DepositIntoChests(remaining, chests, monitor);

                        int left = remaining?.Stack ?? 0;
                        collected += before - left;
                        if (left <= 0)
                            target.Location.debris.Remove(debris);
                        else
                            debris.item = remaining;
                    }
                    catch
                    {
                        if (remaining != null && remaining.Stack > 0)
                            debris.item = remaining;
                        else
                            target.Location.debris.Remove(debris);
                        throw;
                    }
                }
                catch (Exception ex)
                {
                    monitor?.Log($"[收割] 自动收起额外掉落失败: {ex.Message}", LogLevel.Trace);
                }
            }

            if (collected > 0)
                monitor?.Log($"[收割] 自动收起额外产物 x{collected}", LogLevel.Info);
        }

        internal static ActionResult BuildResult(
            int count,
            Dictionary<string, int> harvestedNames,
            IReadOnlyList<Vector2> targets,
            IReadOnlyList<ActionItemFlight> itemFlights)
        {
            return new ActionResult
            {
                Count = count,
                ActionDescription = count > 0
                    ? $"我帮农夫收了 {count} 个成熟作物"
                    : "",
                Targets = targets,
                FxColor = new Color(255, 215, 90),  // 金黄丰收色
                ItemFlights = itemFlights,
                DonePool = CannedLines.HarvestDone,
                DoneLine = count > 0 ? CannedLines.BuildHarvestSong(TopCropNames(harvestedNames)) : null,
                SpeakDoneLineAlways = count > 0,
                NothingPool = CannedLines.HarvestNothing
            };
        }

        private static IReadOnlyList<string> TopCropNames(Dictionary<string, int> harvestedNames)
        {
            return harvestedNames
                .OrderByDescending(pair => pair.Value)
                .ThenBy(pair => pair.Key, StringComparer.Ordinal)
                .Take(3)
                .Select(pair => pair.Key)
                .ToArray();
        }

        private static HarvestTarget CreateTarget(GameLocation location, Vector2 tile, HoeDirt dirt)
        {
            var cropInfo = GetCropInfo(dirt.crop);
            return new HarvestTarget(location, tile, dirt, cropInfo.DisplayName, cropInfo.QualifiedItemId);
        }

        private static (string QualifiedItemId, string DisplayName) GetCropInfo(Crop? crop)
        {
            if (crop == null) return ("", "");

            try
            {
                string itemId = crop.indexOfHarvest.Value?.ToString() ?? "";
                if (string.IsNullOrWhiteSpace(itemId)) return ("", "");

                string qualifiedId = ItemRegistry.IsQualifiedItemId(itemId)
                    ? itemId
                    : "(O)" + itemId;
                string displayName = ItemRegistry.GetDataOrErrorItem(qualifiedId).DisplayName ?? "";
                return (qualifiedId, displayName);
            }
            catch
            {
                return ("", "");
            }
        }
    }

    internal sealed class HarvestTarget
    {
        public HarvestTarget(
            GameLocation location,
            Vector2 tile,
            HoeDirt dirt,
            string cropName,
            string qualifiedItemId)
        {
            this.Location = location;
            this.Tile = tile;
            this.Dirt = dirt;
            this.CropName = cropName;
            this.QualifiedItemId = qualifiedItemId;
        }

        public GameLocation Location { get; }
        public Vector2 Tile { get; }
        public HoeDirt Dirt { get; }
        public string CropName { get; }
        public string QualifiedItemId { get; }

        public Vector2 WorldCenter => new(
            this.Tile.X * Game1.tileSize + Game1.tileSize / 2,
            this.Tile.Y * Game1.tileSize + Game1.tileSize / 2);
    }

    internal sealed class HarvestPlan
    {
        public HarvestPlan(IReadOnlyList<HarvestTarget> targets, string songLine)
        {
            this.Targets = targets;
            this.SongLine = songLine;
            this.TargetPositions = targets.Select(target => target.WorldCenter).ToArray();
        }

        public IReadOnlyList<HarvestTarget> Targets { get; }
        public string SongLine { get; }
        public IReadOnlyList<Vector2> TargetPositions { get; }
        public int Count => this.Targets.Count;
    }

}

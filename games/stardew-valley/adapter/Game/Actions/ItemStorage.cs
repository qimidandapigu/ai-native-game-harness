using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>动作掉落的共享收纳规则:背包优先、普通储物箱兜底、满载时保留地面物品。</summary>
    internal static class ItemStorage
    {
        public static List<(Vector2 Tile, Chest Chest)> FindRegularChests(
            GameLocation location,
            Vector2 originTile)
        {
            var result = new List<(Vector2 Tile, Chest Chest)>();
            if (location.Objects?.Pairs == null) return result;

            foreach (var pair in location.Objects.Pairs)
            {
                if (pair.Value is Chest chest && IsRegularStorageChest(chest))
                    result.Add((pair.Key, chest));
            }

            result.Sort((left, right) =>
                Vector2.DistanceSquared(left.Tile, originTile)
                    .CompareTo(Vector2.DistanceSquared(right.Tile, originTile)));
            return result;
        }

        public static Item? DepositIntoChests(
            Item item,
            IReadOnlyList<(Vector2 Tile, Chest Chest)> chests,
            IMonitor? monitor,
            string logPrefix)
        {
            Item? remaining = item;
            foreach (var candidate in chests)
            {
                if (remaining == null || remaining.Stack <= 0) return null;

                int before = remaining.Stack;
                try
                {
                    remaining = candidate.Chest.addItem(remaining);
                    int stored = before - (remaining?.Stack ?? 0);
                    if (stored > 0)
                    {
                        monitor?.Log(
                            $"{logPrefix} {item.DisplayName} x{stored} 已放入储物箱 {candidate.Tile}",
                            LogLevel.Info);
                    }
                }
                catch (Exception ex)
                {
                    monitor?.Log(
                        $"{logPrefix} 储物箱 {candidate.Tile} 存放失败: {ex.Message}",
                        LogLevel.Trace);
                }
            }

            return remaining;
        }

        public static int CollectNewDebris(
            GameLocation location,
            HashSet<Debris> existingDebris,
            Farmer player,
            IReadOnlyList<(Vector2 Tile, Chest Chest)> chests,
            IMonitor? monitor,
            string logPrefix)
        {
            int collected = 0;
            foreach (Debris debris in location.debris.ToArray())
            {
                if (existingDebris.Contains(debris)) continue;

                try
                {
                    Item? droppedItem = DetachOrCreateItem(debris);
                    if (droppedItem == null || droppedItem.Stack <= 0) continue;

                    int before = droppedItem.Stack;
                    Item? remaining;
                    try
                    {
                        remaining = player.addItemToInventory(droppedItem);
                    }
                    catch
                    {
                        debris.item = droppedItem;
                        throw;
                    }

                    if (remaining != null && remaining.Stack > 0)
                        remaining = DepositIntoChests(remaining, chests, monitor, logPrefix);

                    int left = remaining?.Stack ?? 0;
                    collected += before - left;
                    if (left <= 0)
                    {
                        location.debris.Remove(debris);
                    }
                    else
                    {
                        debris.item = remaining;
                        monitor?.Log(
                            $"{logPrefix} 背包和储物箱已满,{remaining!.DisplayName} x{left} 保留在地面",
                            LogLevel.Warn);
                    }
                }
                catch (Exception ex)
                {
                    monitor?.Log($"{logPrefix} 自动收起掉落失败: {ex.Message}", LogLevel.Trace);
                }
            }

            return collected;
        }

        private static Item? DetachOrCreateItem(Debris debris)
        {
            if (debris.item is Item item)
            {
                debris.item = null;
                return item;
            }

            string itemId = debris.itemId.Value ?? "";
            if (string.IsNullOrWhiteSpace(itemId) || !ItemRegistry.Exists(itemId))
                return null;

            int stack = Math.Max(1, debris.Chunks.Count);
            return ItemRegistry.Create(itemId, stack, debris.itemQuality, allowNull: true);
        }

        private static bool IsRegularStorageChest(Chest chest)
        {
            if (!chest.playerChest.Value) return false;

            string specialType = chest.SpecialChestType.ToString();
            return specialType == "None" || specialType == "BigChest";
        }
    }
}

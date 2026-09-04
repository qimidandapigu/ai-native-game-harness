using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewAgentMod.Game.Abilities;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using SObject = StardewValley.Object;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>清理玩家在农场周围半径八格内的自然障碍,保留作物与玩家设施。</summary>
    internal sealed class ClearFarmAreaAction : ICompanionAction
    {
        private const int ClearRadius = 8;
        private const int MaxTreeFastForwardTicks = 1000;

        private readonly IMonitor monitor;

        public ClearFarmAreaAction(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        public string Intent => AbilityRegistry.ClearDebris;

        public ActionResult Execute(GameLocation location)
        {
            if (location is not Farm farm || Game1.player is not Farmer player)
                return BuildEmptyResult("要在农场里才能清理空地。");

            Point playerTile = player.TilePoint;
            Vector2 playerTileVector = new(playerTile.X, playerTile.Y);
            var targets = new List<Vector2>();
            var existingDebris = new HashSet<Debris>(farm.debris);
            var chests = ItemStorage.FindRegularChests(farm, playerTileVector);

            var axe = new Axe { UpgradeLevel = 4, lastUser = player };
            var pickaxe = new Pickaxe { UpgradeLevel = 4, lastUser = player };
            var scythe = new MeleeWeapon("47") { lastUser = player };

            int count = 0;
            foreach (var pair in farm.Objects.Pairs.ToArray())
            {
                if (!IsWithinRadius(pair.Key, playerTile) || !IsNaturalDebris(pair.Value))
                    continue;

                if (TryClearObject(farm, pair.Key, pair.Value, player, axe, pickaxe, scythe))
                {
                    targets.Add(TileCenter(pair.Key));
                    count++;
                }
            }

            foreach (var pair in farm.terrainFeatures.Pairs.ToArray())
            {
                if (!IsWithinRadius(pair.Key, playerTile)) continue;

                bool cleared = pair.Value switch
                {
                    Grass grass => TryClearGrass(farm, pair.Key, grass, scythe),
                    Tree tree => TryClearTree(farm, pair.Key, tree, axe),
                    _ => false
                };

                if (cleared)
                {
                    targets.Add(TileCenter(pair.Key));
                    count++;
                }
            }

            foreach (ResourceClump clump in farm.resourceClumps.ToArray())
            {
                // GiantCrop 等子类属于种植成果,不能当成自然岩块删除。
                if (clump.GetType() != typeof(ResourceClump) || !IsWithinRadius(clump, playerTile))
                    continue;

                if (TryClearClump(farm, clump, player, axe, pickaxe))
                {
                    Rectangle bounds = clump.getBoundingBox();
                    targets.Add(new Vector2(bounds.Center.X, bounds.Center.Y));
                    count++;
                }
            }

            foreach (LargeTerrainFeature feature in farm.largeTerrainFeatures.ToArray())
            {
                // 只处理原版判定可砍的野生灌木;玩家种植的茶树丛属于作物。
                if (feature is not Bush bush
                    || bush.size.Value == Bush.greenTeaBush
                    || !bush.isDestroyable()
                    || !IsWithinRadius(bush.getBoundingBox(), playerTile))
                    continue;

                if (TryClearBush(farm, bush, axe))
                {
                    Rectangle bounds = bush.getBoundingBox();
                    targets.Add(new Vector2(bounds.Center.X, bounds.Center.Y));
                    count++;
                }
            }

            int collected = ItemStorage.CollectNewDebris(
                farm,
                existingDebris,
                player,
                chests,
                this.monitor,
                "[清理]");

            this.monitor.Log(
                $"[清理] 半径 {ClearRadius} 格内移除 {count} 处自然障碍,自动收纳掉落 {collected} 件",
                LogLevel.Info);

            return new ActionResult
            {
                Count = count,
                ActionDescription = count > 0 ? $"我帮农夫清理了 {count} 处自然障碍" : "",
                Targets = targets,
                FxColor = new Color(120, 210, 135),
                DonePool = CannedLines.ClearDone,
                NothingPool = count > 0
                    ? CannedLines.ClearNothing
                    : new[] { "周围八格已经很干净了。" }
            };
        }

        private static ActionResult BuildEmptyResult(string line)
        {
            return new ActionResult
            {
                Count = 0,
                NothingPool = new[] { line }
            };
        }

        private bool TryClearObject(
            Farm farm,
            Vector2 tile,
            SObject item,
            Farmer player,
            Axe axe,
            Pickaxe pickaxe,
            MeleeWeapon scythe)
        {
            int oldReadiness = item.MinutesUntilReady;
            try
            {
                item.MinutesUntilReady = Math.Min(oldReadiness, 1);
                bool isStone = item.IsBreakableStone();
                Tool tool = isStone ? pickaxe : item.IsTwig() ? axe : scythe;
                if (!item.performToolAction(tool))
                {
                    item.MinutesUntilReady = oldReadiness;
                    return false;
                }

                if (isStone)
                    farm.OnStoneDestroyed(item.ItemId, (int)tile.X, (int)tile.Y, player);
                farm.Objects.Remove(tile);
                return true;
            }
            catch (Exception ex)
            {
                item.MinutesUntilReady = oldReadiness;
                this.monitor.Log($"[清理] 自然物件 {tile} 清理失败: {ex.Message}", LogLevel.Trace);
                return false;
            }
        }

        private bool TryClearGrass(Farm farm, Vector2 tile, Grass grass, MeleeWeapon scythe)
        {
            try
            {
                if (!grass.performToolAction(scythe, 100, tile)) return false;
                farm.terrainFeatures.Remove(tile);
                return true;
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[清理] 草丛 {tile} 清理失败: {ex.Message}", LogLevel.Trace);
                return false;
            }
        }

        private bool TryClearTree(Farm farm, Vector2 tile, Tree tree, Axe axe)
        {
            // 树液采集器等物件与树共格;保留这类已投入使用的树和设备。
            if (farm.Objects.ContainsKey(tile)) return false;

            float oldHealth = tree.health.Value;
            try
            {
                tree.health.Value = Math.Min(oldHealth, 0.1f);
                bool remove = tree.performToolAction(axe, 0, tile);

                if (!remove && tree.falling.Value)
                {
                    TimeSpan elapsed = TimeSpan.FromMilliseconds(16);
                    TimeSpan total = TimeSpan.Zero;
                    for (int i = 0; i < MaxTreeFastForwardTicks && tree.falling.Value; i++)
                    {
                        total += elapsed;
                        if (tree.tickUpdate(new GameTime(total, elapsed)))
                        {
                            remove = true;
                            break;
                        }
                    }
                }

                if (!remove && tree.stump.Value)
                {
                    tree.health.Value = 0.1f;
                    remove = tree.performToolAction(axe, 0, tile);
                }

                if (!remove)
                {
                    this.monitor.Log($"[清理] 树木 {tile} 未能完成倒下与树桩清理", LogLevel.Warn);
                    return false;
                }

                farm.terrainFeatures.Remove(tile);
                return true;
            }
            catch (Exception ex)
            {
                if (!tree.falling.Value && !tree.stump.Value)
                    tree.health.Value = oldHealth;
                this.monitor.Log($"[清理] 树木 {tile} 清理失败: {ex.Message}", LogLevel.Trace);
                return false;
            }
        }

        private bool TryClearClump(
            Farm farm,
            ResourceClump clump,
            Farmer player,
            Axe axe,
            Pickaxe pickaxe)
        {
            float oldHealth = clump.health.Value;
            try
            {
                int index = clump.parentSheetIndex.Value;
                bool useAxe = index == ResourceClump.stumpIndex
                    || index == ResourceClump.hollowLogIndex
                    || index == ResourceClump.greenRainBush1Index
                    || index == ResourceClump.greenRainBush2Index;
                Tool tool = useAxe ? axe : pickaxe;
                tool.lastUser = player;

                clump.health.Value = Math.Min(oldHealth, 0.1f);
                if (!clump.performToolAction(tool, 0, clump.Tile))
                {
                    clump.health.Value = oldHealth;
                    return false;
                }

                farm.resourceClumps.Remove(clump);
                return true;
            }
            catch (Exception ex)
            {
                clump.health.Value = oldHealth;
                this.monitor.Log($"[清理] 大型障碍 {clump.Tile} 清理失败: {ex.Message}", LogLevel.Trace);
                return false;
            }
        }

        private bool TryClearBush(Farm farm, Bush bush, Axe axe)
        {
            float oldHealth = bush.health;
            try
            {
                bush.health = Math.Min(oldHealth, -1f);
                if (!bush.performToolAction(axe, 0, bush.Tile))
                {
                    bush.health = oldHealth;
                    return false;
                }

                farm.largeTerrainFeatures.Remove(bush);
                return true;
            }
            catch (Exception ex)
            {
                bush.health = oldHealth;
                this.monitor.Log($"[清理] 野生灌木 {bush.Tile} 清理失败: {ex.Message}", LogLevel.Trace);
                return false;
            }
        }

        private static bool IsNaturalDebris(SObject item)
        {
            return item.IsBreakableStone() || item.IsTwig() || item.IsWeeds();
        }

        private static bool IsWithinRadius(Vector2 tile, Point center)
        {
            float dx = tile.X - center.X;
            float dy = tile.Y - center.Y;
            return dx * dx + dy * dy <= ClearRadius * ClearRadius;
        }

        private static bool IsWithinRadius(ResourceClump clump, Point center)
        {
            int left = (int)clump.Tile.X;
            int top = (int)clump.Tile.Y;
            int right = left + Math.Max(1, clump.width.Value) - 1;
            int bottom = top + Math.Max(1, clump.height.Value) - 1;
            int nearestX = Math.Clamp(center.X, left, right);
            int nearestY = Math.Clamp(center.Y, top, bottom);
            int dx = nearestX - center.X;
            int dy = nearestY - center.Y;
            return dx * dx + dy * dy <= ClearRadius * ClearRadius;
        }

        private static bool IsWithinRadius(Rectangle worldBounds, Point center)
        {
            int left = worldBounds.Left / Game1.tileSize;
            int top = worldBounds.Top / Game1.tileSize;
            int right = Math.Max(worldBounds.Left, worldBounds.Right - 1) / Game1.tileSize;
            int bottom = Math.Max(worldBounds.Top, worldBounds.Bottom - 1) / Game1.tileSize;
            int nearestX = Math.Clamp(center.X, left, right);
            int nearestY = Math.Clamp(center.Y, top, bottom);
            int dx = nearestX - center.X;
            int dy = nearestY - center.Y;
            return dx * dx + dy * dy <= ClearRadius * ClearRadius;
        }

        private static Vector2 TileCenter(Vector2 tile)
        {
            return tile * Game1.tileSize + new Vector2(Game1.tileSize / 2f);
        }
    }
}

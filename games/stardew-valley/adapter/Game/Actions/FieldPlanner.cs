using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.TerrainFeatures;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>
    /// 按农场当前地形寻找最大的连续直边空地。
    /// 自动范围位于农舍正门中线左侧或下侧,不再读取旧耕地外框或持久化连接带。
    /// </summary>
    internal sealed class FieldPlanner
    {
        private const int StraightBandSize = 3;
        private const int NaturalObstacleBuffer = 1;
        private static readonly Point[] CardinalDirections =
        {
            new(-1, 0),
            new(1, 0),
            new(0, -1),
            new(0, 1)
        };

        private readonly IMonitor monitor;

        public FieldPlanner(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        public FieldAreaPlan CreateAreaPlan(GameLocation location, string seedItemId)
        {
            if (location is not Farm farm)
                return FieldAreaPlan.NotApplicable;
            if (!TryGetMapBounds(location, out Rectangle mapBounds))
                return new FieldAreaPlan(true, Array.Empty<Vector2>(), Array.Empty<Vector2>(), 0);

            Point houseEntry = farm.GetMainFarmHouseEntry();
            HashSet<Point> naturalObstacleBuffer = BuildNaturalObstacleBuffer(location, mapBounds);
            var openTiles = new HashSet<Point>();
            for (int y = mapBounds.Top; y < mapBounds.Bottom; y++)
            {
                for (int x = mapBounds.Left; x < mapBounds.Right; x++)
                {
                    var tile = new Point(x, y);
                    if (!IsInsideFarmWorkArea(tile, houseEntry))
                        continue;
                    if (naturalObstacleBuffer.Contains(tile))
                        continue;
                    if (IsOpenPlanningTile(farm, tile, seedItemId))
                        openTiles.Add(tile);
                }
            }

            HashSet<Point> largestOpenArea = GetLargestComponent(openTiles);
            HashSet<Point> straightArea = BuildLargestStraightArea(largestOpenArea);
            var existingDirtTiles = new List<Vector2>();
            var tillingTiles = new List<Vector2>();
            foreach (Point tile in straightArea.OrderBy(tile => tile.Y).ThenBy(tile => tile.X))
            {
                Vector2 vector = ToVector2(tile);
                if (location.terrainFeatures.TryGetValue(vector, out TerrainFeature? feature))
                {
                    if (feature is HoeDirt dirt && dirt.crop == null)
                        existingDirtTiles.Add(vector);
                    continue;
                }

                if (location.Objects.ContainsKey(vector))
                    continue;
                if (CanCreateDirtAt(farm, tile, seedItemId))
                    tillingTiles.Add(vector);
            }

            this.monitor.Log(
                $"[农田规划] 农舍中线=({houseEntry.X},{houseEntry.Y}), "
                + $"连续空地={largestOpenArea.Count}, 直边范围={straightArea.Count}, "
                + $"已有空耕地={existingDirtTiles.Count}, 待开垦={tillingTiles.Count}",
                LogLevel.Info);

            return new FieldAreaPlan(
                true,
                existingDirtTiles,
                tillingTiles,
                straightArea.Count);
        }

        private static HashSet<Point> BuildNaturalObstacleBuffer(GameLocation location, Rectangle mapBounds)
        {
            var blocked = new HashSet<Point>();

            foreach (var pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is Tree or FruitTree or Grass)
                    AddBufferedTile(blocked, new Point((int)pair.Key.X, (int)pair.Key.Y), mapBounds);
            }

            foreach (var pair in location.Objects.Pairs)
            {
                if (IsNaturalDebris(pair.Value))
                    AddBufferedTile(blocked, new Point((int)pair.Key.X, (int)pair.Key.Y), mapBounds);
            }

            foreach (ResourceClump clump in location.resourceClumps)
                AddBufferedWorldRectangle(blocked, clump.getBoundingBox(), mapBounds);
            foreach (LargeTerrainFeature feature in location.largeTerrainFeatures)
                AddBufferedWorldRectangle(blocked, feature.getBoundingBox(), mapBounds);

            return blocked;
        }

        private static bool IsNaturalDebris(StardewValley.Object item)
        {
            return item.IsBreakableStone() || item.IsTwig() || item.IsWeeds();
        }

        private static void AddBufferedWorldRectangle(
            HashSet<Point> blocked,
            Rectangle worldBounds,
            Rectangle mapBounds)
        {
            int left = Math.Max(mapBounds.Left, worldBounds.Left / Game1.tileSize - NaturalObstacleBuffer);
            int top = Math.Max(mapBounds.Top, worldBounds.Top / Game1.tileSize - NaturalObstacleBuffer);
            int right = Math.Min(
                mapBounds.Right - 1,
                Math.Max(worldBounds.Left, worldBounds.Right - 1) / Game1.tileSize + NaturalObstacleBuffer);
            int bottom = Math.Min(
                mapBounds.Bottom - 1,
                Math.Max(worldBounds.Top, worldBounds.Bottom - 1) / Game1.tileSize + NaturalObstacleBuffer);
            for (int y = top; y <= bottom; y++)
            {
                for (int x = left; x <= right; x++)
                    blocked.Add(new Point(x, y));
            }
        }

        private static void AddBufferedTile(HashSet<Point> blocked, Point center, Rectangle mapBounds)
        {
            for (int y = center.Y - NaturalObstacleBuffer; y <= center.Y + NaturalObstacleBuffer; y++)
            {
                for (int x = center.X - NaturalObstacleBuffer; x <= center.X + NaturalObstacleBuffer; x++)
                {
                    var tile = new Point(x, y);
                    if (mapBounds.Contains(tile))
                        blocked.Add(tile);
                }
            }
        }

        private static bool IsInsideFarmWorkArea(Point tile, Point houseEntry)
        {
            return tile.X < houseEntry.X || tile.Y > houseEntry.Y;
        }

        private static bool IsOpenPlanningTile(Farm farm, Point tile, string seedItemId)
        {
            Vector2 vector = ToVector2(tile);
            if (!CanUseBaseTerrain(farm, tile, seedItemId))
                return false;

            if (farm.terrainFeatures.TryGetValue(vector, out TerrainFeature? feature))
                return feature is HoeDirt or Flooring;

            // 人工物体只占用自身格,不额外扩大自然障碍缓冲。
            return true;
        }

        private static bool CanCreateDirtAt(Farm farm, Point tile, string seedItemId)
        {
            Vector2 vector = ToVector2(tile);
            if (farm.Objects.ContainsKey(vector) || farm.terrainFeatures.ContainsKey(vector))
                return false;
            return CanUseBaseTerrain(farm, tile, seedItemId);
        }

        private static bool CanUseBaseTerrain(Farm farm, Point tile, string seedItemId)
        {
            Vector2 vector = ToVector2(tile);
            try
            {
                if (!IsOnMap(farm, tile) || farm.isWaterTile(tile.X, tile.Y))
                    return false;
                if (!farm.isTileLocationOpen(vector))
                    return false;
                if (farm.buildings.Any(building => building.occupiesTile(tile.X, tile.Y, applyTilePropertyRadius: true)))
                    return false;

                bool alreadyDirt = farm.terrainFeatures.TryGetValue(vector, out TerrainFeature? feature)
                    && feature is HoeDirt;
                if (!alreadyDirt)
                {
                    string diggable = farm.doesTileHavePropertyNoNull(tile.X, tile.Y, "Diggable", "Back");
                    if (string.IsNullOrWhiteSpace(diggable))
                        return false;
                }

                return farm.CanPlantSeedsHere(seedItemId, tile.X, tile.Y, false, out _);
            }
            catch
            {
                return false;
            }
        }

        private static HashSet<Point> BuildLargestStraightArea(HashSet<Point> component)
        {
            if (component.Count == 0)
                return new HashSet<Point>();

            int minY = component.Min(tile => tile.Y);
            int maxY = component.Max(tile => tile.Y);
            HashSet<Point> best = new();
            for (int offset = 0; offset < StraightBandSize; offset++)
            {
                var candidate = new HashSet<Point>();
                for (int top = minY + offset; top + StraightBandSize - 1 <= maxY; top += StraightBandSize)
                {
                    HashSet<int>? commonColumns = null;
                    for (int y = top; y < top + StraightBandSize; y++)
                    {
                        var rowColumns = component
                            .Where(tile => tile.Y == y)
                            .Select(tile => tile.X)
                            .ToHashSet();
                        if (commonColumns == null)
                            commonColumns = rowColumns;
                        else
                            commonColumns.IntersectWith(rowColumns);
                    }

                    if (commonColumns == null || commonColumns.Count == 0)
                        continue;
                    AddStraightRuns(candidate, commonColumns, top);
                }

                HashSet<Point> largest = GetLargestComponent(candidate);
                if (largest.Count > best.Count)
                    best = largest;
            }

            return best;
        }

        private static void AddStraightRuns(HashSet<Point> area, HashSet<int> columns, int top)
        {
            int[] ordered = columns.OrderBy(x => x).ToArray();
            if (ordered.Length == 0)
                return;

            int runStart = ordered[0];
            int previous = ordered[0];
            for (int i = 1; i <= ordered.Length; i++)
            {
                bool closesRun = i == ordered.Length || ordered[i] != previous + 1;
                if (closesRun)
                {
                    int width = previous - runStart + 1;
                    if (width >= StraightBandSize)
                    {
                        for (int y = top; y < top + StraightBandSize; y++)
                        {
                            for (int x = runStart; x <= previous; x++)
                                area.Add(new Point(x, y));
                        }
                    }

                    if (i < ordered.Length)
                        runStart = ordered[i];
                }

                if (i < ordered.Length)
                    previous = ordered[i];
            }
        }

        private static HashSet<Point> GetLargestComponent(HashSet<Point> tiles)
        {
            var unvisited = new HashSet<Point>(tiles);
            HashSet<Point> largest = new();
            while (unvisited.Count > 0)
            {
                Point first = unvisited.First();
                unvisited.Remove(first);
                var component = new HashSet<Point> { first };
                var queue = new Queue<Point>();
                queue.Enqueue(first);

                while (queue.Count > 0)
                {
                    Point current = queue.Dequeue();
                    foreach (Point direction in CardinalDirections)
                    {
                        Point next = new(current.X + direction.X, current.Y + direction.Y);
                        if (!unvisited.Remove(next))
                            continue;
                        component.Add(next);
                        queue.Enqueue(next);
                    }
                }

                if (component.Count > largest.Count)
                    largest = component;
            }

            return largest;
        }

        private static bool TryGetMapBounds(GameLocation location, out Rectangle bounds)
        {
            bounds = Rectangle.Empty;
            try
            {
                var back = location.Map?.GetLayer("Back");
                if (back == null || back.LayerWidth <= 0 || back.LayerHeight <= 0)
                    return false;
                bounds = new Rectangle(0, 0, back.LayerWidth, back.LayerHeight);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsOnMap(GameLocation location, Point tile)
        {
            try
            {
                var back = location.Map?.GetLayer("Back");
                return back != null
                    && tile.X >= 0
                    && tile.Y >= 0
                    && tile.X < back.LayerWidth
                    && tile.Y < back.LayerHeight
                    && back.Tiles[tile.X, tile.Y] != null;
            }
            catch
            {
                return false;
            }
        }

        private static Vector2 ToVector2(Point point) => new(point.X, point.Y);
    }

    internal sealed class FieldAreaPlan
    {
        public static FieldAreaPlan NotApplicable { get; } = new(
            false,
            Array.Empty<Vector2>(),
            Array.Empty<Vector2>(),
            0);

        public FieldAreaPlan(
            bool appliesToLocation,
            IReadOnlyList<Vector2> existingDirtTiles,
            IReadOnlyList<Vector2> tillingTiles,
            int areaTileCount)
        {
            this.AppliesToLocation = appliesToLocation;
            this.ExistingDirtTiles = existingDirtTiles;
            this.TillingTiles = tillingTiles;
            this.AreaTileCount = areaTileCount;
        }

        public bool AppliesToLocation { get; }
        public IReadOnlyList<Vector2> ExistingDirtTiles { get; }
        public IReadOnlyList<Vector2> TillingTiles { get; }
        public int AreaTileCount { get; }
    }
}

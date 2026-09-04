using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace StardewAgentMod.Game.Fishing
{
    /// <summary>
    /// 截获对水面使用原版炸弹的操作，播放投掷、炸鱼和水花浇地演出。
    /// 这里不会调用原版爆炸逻辑，因此不会伤害角色或破坏地形、作物和物品。
    /// </summary>
    internal sealed class BombFishingController
    {
        private const long ImpactTimeMs = 620;
        private const long SequenceDurationMs = 3300;
        private const double LegendaryAcceptanceChance = 0.05;
        private const double QuestFishAcceptanceChance = 0.10;
        private const double LegendaryQuestAcceptanceChance = 0.03;

        private static readonly HashSet<string> LegendaryFishIds = new(StringComparer.Ordinal)
        {
            "159", // Crimsonfish
            "160", // Angler
            "163", // Legend
            "682", // Mutant Carp
            "775", // Glacierfish
            "898", // Son of Crimsonfish
            "899", // Ms. Angler
            "900", // Legend II
            "901", // Radioactive Carp
            "902"  // Glacierfish Jr.
        };

        private static readonly HashSet<string> QuestFishIds = new(StringComparer.Ordinal)
        {
            "898",
            "899",
            "900",
            "901",
            "902"
        };

        private readonly IMonitor monitor;
        private readonly IInputHelper input;
        private readonly Random random = new();
        private BombFishingSequence? active;

        private readonly record struct BombTier(
            string ItemId,
            string DisplayName,
            int MinFish,
            int MaxFish,
            int WaterRadius,
            int ThrowRange,
            int DecorativeDroplets);

        private sealed class SpriteVisual
        {
            public SpriteVisual(Texture2D texture, Rectangle sourceRect)
            {
                this.Texture = texture;
                this.SourceRect = sourceRect;
            }

            public Texture2D Texture { get; }
            public Rectangle SourceRect { get; }
        }

        private sealed class WaterTarget
        {
            public WaterTarget(Vector2 tile, HoeDirt dirt)
            {
                this.Tile = tile;
                this.Dirt = dirt;
            }

            public Vector2 Tile { get; }
            public HoeDirt Dirt { get; }
            public bool Applied { get; set; }

            public Vector2 WorldCenter => new(
                this.Tile.X * Game1.tileSize + Game1.tileSize / 2f,
                this.Tile.Y * Game1.tileSize + Game1.tileSize / 2f);
        }

        private sealed class FishFlight
        {
            public FishFlight(
                Item item,
                SpriteVisual visual,
                Vector2 start,
                Vector2 end,
                long delayMs,
                long durationMs,
                float arcHeight,
                float rotationOffset)
            {
                this.Item = item;
                this.Visual = visual;
                this.Start = start;
                this.End = end;
                this.DelayMs = delayMs;
                this.DurationMs = durationMs;
                this.ArcHeight = arcHeight;
                this.RotationOffset = rotationOffset;
            }

            public Item Item { get; }
            public SpriteVisual Visual { get; }
            public Vector2 Start { get; }
            public Vector2 End { get; }
            public long DelayMs { get; }
            public long DurationMs { get; }
            public float ArcHeight { get; }
            public float RotationOffset { get; }
            public bool Landed { get; set; }
        }

        private sealed class WaterFlight
        {
            public WaterFlight(
                Vector2 start,
                Vector2 end,
                long delayMs,
                long durationMs,
                float arcHeight,
                float width,
                WaterTarget? target)
            {
                this.Start = start;
                this.End = end;
                this.DelayMs = delayMs;
                this.DurationMs = durationMs;
                this.ArcHeight = arcHeight;
                this.Width = width;
                this.Target = target;
            }

            public Vector2 Start { get; }
            public Vector2 End { get; }
            public long DelayMs { get; }
            public long DurationMs { get; }
            public float ArcHeight { get; }
            public float Width { get; }
            public WaterTarget? Target { get; }
            public bool Landed { get; set; }
        }

        private sealed class LandingSplash
        {
            public LandingSplash(Vector2 position, long startMs, float scale)
            {
                this.Position = position;
                this.StartMs = startMs;
                this.Scale = scale;
            }

            public Vector2 Position { get; }
            public long StartMs { get; }
            public float Scale { get; }
        }

        private sealed class BombFishingSequence
        {
            public BombFishingSequence(
                GameLocation location,
                BombTier tier,
                Vector2 impactTile,
                Vector2 throwStart,
                SpriteVisual bombVisual,
                long startTicks)
            {
                this.Location = location;
                this.Tier = tier;
                this.ImpactTile = impactTile;
                this.ThrowStart = throwStart;
                this.BombVisual = bombVisual;
                this.StartTicks = startTicks;
            }

            public GameLocation Location { get; }
            public BombTier Tier { get; }
            public Vector2 ImpactTile { get; }
            public Vector2 ThrowStart { get; }
            public SpriteVisual BombVisual { get; }
            public long StartTicks { get; }
            public bool ImpactPlayed { get; set; }
            public List<FishFlight> FishFlights { get; } = new();
            public List<WaterFlight> WaterFlights { get; } = new();
            public List<WaterTarget> WaterTargets { get; } = new();
            public List<LandingSplash> LandingSplashes { get; } = new();

            public Vector2 ImpactWorld => new(
                this.ImpactTile.X * Game1.tileSize + Game1.tileSize / 2f,
                this.ImpactTile.Y * Game1.tileSize + Game1.tileSize / 2f);
        }

        public BombFishingController(IMonitor monitor, IInputHelper input)
        {
            this.monitor = monitor;
            this.input = input;
        }

        public void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
        {
            try
            {
                if (!Context.IsWorldReady || !e.Button.IsActionButton()) return;
                if (Game1.activeClickableMenu != null || Game1.eventUp || Game1.currentMinigame != null) return;

                Farmer? player = Game1.player;
                GameLocation? location = player?.currentLocation;
                if (player == null || location == null || !player.IsLocalPlayer) return;

                int inventoryIndex = player.CurrentToolIndex;
                if (inventoryIndex < 0 || inventoryIndex >= player.Items.Count) return;

                Item? heldItem = player.Items[inventoryIndex];
                if (heldItem == null || !TryGetBombTier(heldItem.QualifiedItemId, out BombTier tier)) return;

                Vector2 impactTile = new((int)e.Cursor.Tile.X, (int)e.Cursor.Tile.Y);
                if (!IsOnMap(location, impactTile) || !location.isWaterTile((int)impactTile.X, (int)impactTile.Y))
                    return;

                // 从这里开始由本功能接管，不能让原版同时在岸边放下一枚会造成伤害的炸弹。
                this.input.Suppress(e.Button);

                if (this.active != null)
                {
                    ShowHud("上一枚炸弹还在水里翻腾。", HUDMessage.error_type);
                    return;
                }

                float distance = Vector2.Distance(player.Tile, impactTile);
                if (distance > tier.ThrowRange + 0.01f)
                {
                    ShowHud($"{tier.DisplayName}最多能投 {tier.ThrowRange} 格。", HUDMessage.error_type);
                    return;
                }

                int waterDepth = GetWaterDepth(location, impactTile, tier.ThrowRange + 2);
                List<Item> fish = this.CreateFishLoot(location, player, impactTile, waterDepth, tier);
                if (fish.Count == 0)
                {
                    ShowHud("这片水域现在炸不到鱼。", HUDMessage.error_type);
                    return;
                }

                SpriteVisual? bombVisual = TryLoadVisual(heldItem);
                if (bombVisual == null)
                {
                    this.monitor.Log($"[炸鱼] 无法读取炸弹图标 {heldItem.QualifiedItemId}。", LogLevel.Warn);
                    return;
                }

                List<Vector2> shoreTiles = FindShoreTiles(location, impactTile, tier.ThrowRange + 4);
                if (shoreTiles.Count == 0)
                    shoreTiles.Add(player.Tile);

                List<WaterTarget> waterTargets = FindWaterTargets(location, impactTile, tier.WaterRadius);
                Vector2 throwStart = player.getStandingPosition() + new Vector2(0f, -48f);
                long startTicks = Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
                var sequence = new BombFishingSequence(
                    location,
                    tier,
                    impactTile,
                    throwStart,
                    bombVisual,
                    startTicks);
                sequence.WaterTargets.AddRange(waterTargets);
                this.BuildFishFlights(sequence, fish, shoreTiles);
                this.BuildWaterFlights(sequence);

                ConsumeOne(player, inventoryIndex, heldItem);
                this.active = sequence;
                TryPlaySound(location, "throwDownITem", player.Tile);

                this.monitor.Log(
                    $"[炸鱼] {tier.DisplayName} 投向 {impactTile}: 鱼={fish.Count},待浇地={waterTargets.Count}",
                    LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[炸鱼] 触发失败: {ex}", LogLevel.Error);
            }
        }

        public void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (this.active == null || !Context.IsWorldReady) return;

            try
            {
                BombFishingSequence sequence = this.active;
                if (Game1.player?.currentLocation != sequence.Location)
                {
                    this.CompleteImmediately(sequence);
                    this.active = null;
                    return;
                }

                long elapsed = GetElapsedMs(sequence);
                if (!sequence.ImpactPlayed && elapsed >= ImpactTimeMs)
                {
                    sequence.ImpactPlayed = true;
                    TryPlaySound(sequence.Location, "explosion", sequence.ImpactTile);
                    TryPlaySound(sequence.Location, "waterSlosh", sequence.ImpactTile);
                }

                foreach (FishFlight flight in sequence.FishFlights)
                {
                    if (flight.Landed || elapsed < ImpactTimeMs + flight.DelayMs + flight.DurationMs) continue;
                    flight.Landed = true;
                    Game1.createItemDebris(flight.Item, flight.End, -1, sequence.Location);
                    sequence.LandingSplashes.Add(new LandingSplash(flight.End, elapsed, 0.9f));
                    TryPlaySound(sequence.Location, "dropItemInWater", flight.End / Game1.tileSize);
                }

                foreach (WaterFlight flight in sequence.WaterFlights)
                {
                    if (flight.Landed || elapsed < ImpactTimeMs + flight.DelayMs + flight.DurationMs) continue;
                    flight.Landed = true;
                    ApplyWater(flight.Target);
                    sequence.LandingSplashes.Add(new LandingSplash(
                        flight.End,
                        elapsed,
                        flight.Target == null ? 0.55f : 0.85f));
                }

                sequence.LandingSplashes.RemoveAll(splash => elapsed - splash.StartMs > 480);
                if (elapsed >= SequenceDurationMs
                    && sequence.FishFlights.All(flight => flight.Landed)
                    && sequence.WaterFlights.All(flight => flight.Landed))
                {
                    int watered = sequence.WaterTargets.Count(target => target.Applied);
                    this.monitor.Log($"[炸鱼] 演出完成: 鱼={sequence.FishFlights.Count},浇地={watered}", LogLevel.Info);
                    this.active = null;
                }
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[炸鱼] 更新失败: {ex}", LogLevel.Error);
                if (this.active != null)
                    this.CompleteImmediately(this.active);
                this.active = null;
            }
        }

        public void Draw(SpriteBatch b)
        {
            BombFishingSequence? sequence = this.active;
            if (sequence == null || Game1.player?.currentLocation != sequence.Location) return;

            try
            {
                long elapsed = GetElapsedMs(sequence);
                if (elapsed < ImpactTimeMs)
                    DrawThrownBomb(b, sequence, elapsed);
                else
                    DrawMainSplash(b, sequence, elapsed - ImpactTimeMs);

                foreach (WaterFlight flight in sequence.WaterFlights)
                    DrawWaterFlight(b, flight, elapsed);

                foreach (FishFlight flight in sequence.FishFlights)
                    DrawFishFlight(b, flight, elapsed);

                foreach (LandingSplash splash in sequence.LandingSplashes)
                    DrawLandingSplash(b, splash, elapsed);
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[炸鱼] 绘制失败: {ex.Message}", LogLevel.Trace);
            }
        }

        public void Reset()
        {
            this.active = null;
        }

        private List<Item> CreateFishLoot(
            GameLocation location,
            Farmer player,
            Vector2 impactTile,
            int waterDepth,
            BombTier tier)
        {
            int wanted = this.random.Next(tier.MinFish, tier.MaxFish + 1);
            var result = new List<Item>(wanted);
            int attempts = Math.Max(36, wanted * 12);

            for (int i = 0; i < attempts && result.Count < wanted; i++)
            {
                Item? candidate;
                try
                {
                    candidate = location.getFish(
                        millisecondsAfterNibble: 0f,
                        bait: null,
                        waterDepth: Math.Clamp(waterDepth, 1, 5),
                        who: player,
                        baitPotency: 0d,
                        bobberTile: impactTile,
                        locationName: null);
                }
                catch (Exception ex)
                {
                    this.monitor.Log($"[炸鱼] 原版出鱼计算失败: {ex.Message}", LogLevel.Trace);
                    break;
                }

                if (!IsFish(candidate) || !this.AcceptRareFish(candidate!)) continue;
                candidate!.Stack = 1;
                result.Add(candidate);
            }

            // 极端情况下原版连续返回垃圾或稀有鱼被门控，用已成功选出的鱼补齐数量，保持炸弹等级约定。
            while (result.Count > 0 && result.Count < wanted)
            {
                Item copy = result[this.random.Next(result.Count)].getOne();
                copy.Stack = 1;
                result.Add(copy);
            }

            return result;
        }

        private bool AcceptRareFish(Item item)
        {
            bool legendary = LegendaryFishIds.Contains(item.ItemId)
                || item.HasContextTag("fish_legendary");
            bool questFish = QuestFishIds.Contains(item.ItemId)
                || item is StardewValley.Object obj && obj.questItem.Value;

            double chance = legendary && questFish
                ? LegendaryQuestAcceptanceChance
                : legendary
                    ? LegendaryAcceptanceChance
                    : questFish
                        ? QuestFishAcceptanceChance
                        : 1d;

            return this.random.NextDouble() <= chance;
        }

        private static bool IsFish(Item? item)
        {
            return item is StardewValley.Object obj
                && obj.Category == StardewValley.Object.FishCategory;
        }

        private void BuildFishFlights(
            BombFishingSequence sequence,
            IReadOnlyList<Item> fish,
            IReadOnlyList<Vector2> shoreTiles)
        {
            for (int i = 0; i < fish.Count; i++)
            {
                SpriteVisual? visual = TryLoadVisual(fish[i]);
                if (visual == null) continue;

                int shoreIndex = (i * 3 + this.random.Next(shoreTiles.Count)) % shoreTiles.Count;
                Vector2 shore = shoreTiles[shoreIndex];
                Vector2 end = new(
                    shore.X * Game1.tileSize + Game1.tileSize / 2f + this.RandomRange(-11f, 11f),
                    shore.Y * Game1.tileSize + Game1.tileSize / 2f + this.RandomRange(-9f, 9f));
                Vector2 start = sequence.ImpactWorld + new Vector2(
                    this.RandomRange(-12f, 12f),
                    this.RandomRange(-7f, 7f));

                sequence.FishFlights.Add(new FishFlight(
                    fish[i],
                    visual,
                    start,
                    end,
                    delayMs: 100 + i * 75 + this.random.Next(0, 150),
                    durationMs: this.random.Next(900, 1251),
                    arcHeight: this.RandomRange(105f, 178f) + sequence.Tier.WaterRadius * 8f,
                    rotationOffset: this.RandomRange(-0.35f, 0.35f)));
            }
        }

        private void BuildWaterFlights(BombFishingSequence sequence)
        {
            foreach (WaterTarget target in sequence.WaterTargets)
            {
                sequence.WaterFlights.Add(new WaterFlight(
                    sequence.ImpactWorld + new Vector2(this.RandomRange(-10f, 10f), this.RandomRange(-5f, 5f)),
                    target.WorldCenter,
                    delayMs: this.random.Next(40, 260),
                    durationMs: this.random.Next(720, 1121),
                    arcHeight: this.RandomRange(100f, 170f) + sequence.Tier.WaterRadius * 10f,
                    width: this.RandomRange(4f, 7f),
                    target));
            }

            float maxRadius = (sequence.Tier.WaterRadius + 1.5f) * Game1.tileSize;
            for (int i = 0; i < sequence.Tier.DecorativeDroplets; i++)
            {
                float angle = this.RandomRange(0f, MathHelper.TwoPi);
                float radius = maxRadius * (float)Math.Sqrt(this.random.NextDouble());
                Vector2 end = sequence.ImpactWorld + new Vector2(
                    (float)Math.Cos(angle) * radius,
                    (float)Math.Sin(angle) * radius * 0.72f);

                sequence.WaterFlights.Add(new WaterFlight(
                    sequence.ImpactWorld + new Vector2(this.RandomRange(-14f, 14f), this.RandomRange(-8f, 8f)),
                    end,
                    delayMs: this.random.Next(0, 330),
                    durationMs: this.random.Next(650, 1221),
                    arcHeight: this.RandomRange(90f, 205f) + sequence.Tier.WaterRadius * 8f,
                    width: this.RandomRange(3f, 6.5f),
                    target: null));
            }
        }

        private static List<WaterTarget> FindWaterTargets(GameLocation location, Vector2 impactTile, int radius)
        {
            var targets = new List<WaterTarget>();
            if (location.terrainFeatures?.Pairs == null) return targets;

            float radiusSquared = radius * radius;
            foreach (var pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is not HoeDirt dirt || dirt.state.Value != HoeDirt.dry) continue;
                if (Vector2.DistanceSquared(pair.Key, impactTile) > radiusSquared + 0.01f) continue;
                targets.Add(new WaterTarget(pair.Key, dirt));
            }

            return targets;
        }

        private static List<Vector2> FindShoreTiles(GameLocation location, Vector2 waterTile, int searchRadius)
        {
            var candidates = new List<Vector2>();
            int centerX = (int)waterTile.X;
            int centerY = (int)waterTile.Y;

            for (int radius = 1; radius <= searchRadius; radius++)
            {
                for (int y = centerY - radius; y <= centerY + radius; y++)
                {
                    for (int x = centerX - radius; x <= centerX + radius; x++)
                    {
                        if (Math.Max(Math.Abs(x - centerX), Math.Abs(y - centerY)) != radius) continue;
                        var tile = new Vector2(x, y);
                        if (!IsValidShoreTile(location, tile)) continue;
                        candidates.Add(tile);
                    }
                }

                if (candidates.Count >= 18)
                    break;
            }

            return candidates
                .Distinct()
                .OrderBy(tile => Vector2.DistanceSquared(tile, waterTile))
                .Take(24)
                .ToList();
        }

        private static bool IsValidShoreTile(GameLocation location, Vector2 tile)
        {
            if (!IsOnMap(location, tile)) return false;
            int x = (int)tile.X;
            int y = (int)tile.Y;
            if (location.isWaterTile(x, y)) return false;
            if (!HasAdjacentWater(location, x, y)) return false;
            if (location.Objects.ContainsKey(tile)) return false;

            try
            {
                return location.CanItemBePlacedHere(tile, itemIsPassable: true);
            }
            catch
            {
                return true;
            }
        }

        private static bool HasAdjacentWater(GameLocation location, int x, int y)
        {
            Point[] offsets =
            {
                new(-1, 0),
                new(1, 0),
                new(0, -1),
                new(0, 1)
            };

            foreach (Point offset in offsets)
            {
                var tile = new Vector2(x + offset.X, y + offset.Y);
                if (IsOnMap(location, tile) && location.isWaterTile((int)tile.X, (int)tile.Y))
                    return true;
            }

            return false;
        }

        private static int GetWaterDepth(GameLocation location, Vector2 waterTile, int maxDepth)
        {
            int centerX = (int)waterTile.X;
            int centerY = (int)waterTile.Y;
            for (int radius = 1; radius <= maxDepth; radius++)
            {
                for (int y = centerY - radius; y <= centerY + radius; y++)
                {
                    for (int x = centerX - radius; x <= centerX + radius; x++)
                    {
                        if (Math.Max(Math.Abs(x - centerX), Math.Abs(y - centerY)) != radius) continue;
                        var tile = new Vector2(x, y);
                        if (!IsOnMap(location, tile) || !location.isWaterTile(x, y))
                            return Math.Clamp(radius, 1, 5);
                    }
                }
            }

            return 5;
        }

        private static bool IsOnMap(GameLocation location, Vector2 tile)
        {
            try
            {
                var back = location.Map?.GetLayer("Back");
                int x = (int)tile.X;
                int y = (int)tile.Y;
                return back != null
                    && x >= 0
                    && y >= 0
                    && x < back.LayerWidth
                    && y < back.LayerHeight
                    && back.Tiles[x, y] != null;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryGetBombTier(string qualifiedItemId, out BombTier tier)
        {
            tier = qualifiedItemId switch
            {
                "(O)286" => new BombTier("(O)286", "樱桃炸弹", 1, 2, 2, 6, 34),
                "(O)287" => new BombTier("(O)287", "炸弹", 3, 4, 3, 8, 52),
                "(O)288" => new BombTier("(O)288", "超级炸弹", 5, 7, 4, 10, 74),
                _ => default
            };
            return tier.ItemId != null;
        }

        private static SpriteVisual? TryLoadVisual(Item item)
        {
            try
            {
                var data = ItemRegistry.GetDataOrErrorItem(item.QualifiedItemId);
                Texture2D texture = data.GetTexture();
                Rectangle sourceRect = data.GetSourceRect();
                return sourceRect.Width > 0 && sourceRect.Height > 0
                    ? new SpriteVisual(texture, sourceRect)
                    : null;
            }
            catch
            {
                return null;
            }
        }

        private static void ConsumeOne(Farmer player, int inventoryIndex, Item heldItem)
        {
            if (heldItem.Stack > 1)
                heldItem.Stack--;
            else
                player.Items[inventoryIndex] = null;
        }

        private static void ApplyWater(WaterTarget? target)
        {
            if (target == null || target.Applied) return;
            if (target.Dirt.state.Value == HoeDirt.dry)
            {
                target.Dirt.state.Value = HoeDirt.watered;
                target.Applied = true;
            }
        }

        private void CompleteImmediately(BombFishingSequence sequence)
        {
            foreach (FishFlight flight in sequence.FishFlights)
            {
                if (flight.Landed) continue;
                flight.Landed = true;
                Game1.createItemDebris(flight.Item, flight.End, -1, sequence.Location);
            }

            foreach (WaterTarget target in sequence.WaterTargets)
                ApplyWater(target);
        }

        private static void DrawThrownBomb(SpriteBatch b, BombFishingSequence sequence, long elapsed)
        {
            float progress = SmoothStep(MathHelper.Clamp(elapsed / (float)ImpactTimeMs, 0f, 1f));
            Vector2 impact = sequence.ImpactWorld;
            Vector2 world = Vector2.Lerp(sequence.ThrowStart, impact, progress);
            float throwDistance = Vector2.Distance(sequence.ThrowStart, impact);
            world.Y -= (float)Math.Sin(progress * Math.PI) * MathHelper.Clamp(throwDistance * 0.24f, 105f, 190f);

            Vector2 screen = Game1.GlobalToLocal(Game1.viewport, world);
            Rectangle source = sequence.BombVisual.SourceRect;
            Vector2 origin = new(source.Width / 2f, source.Height / 2f);
            float sourceScale = Game1.pixelZoom * (16f / Math.Max(source.Width, source.Height));
            float rotation = progress * MathHelper.TwoPi * 1.7f;

            Vector2 groundWorld = Vector2.Lerp(sequence.ThrowStart, impact, progress);
            Vector2 shadow = Game1.GlobalToLocal(Game1.viewport, groundWorld) + new Vector2(0f, 10f);
            float shadowScale = MathHelper.Lerp(1f, 0.48f, (float)Math.Sin(progress * Math.PI));
            b.Draw(
                Game1.staminaRect,
                shadow,
                null,
                Color.Black * 0.3f,
                0f,
                new Vector2(0.5f, 0.5f),
                new Vector2(34f * shadowScale, 12f * shadowScale),
                SpriteEffects.None,
                1f);
            b.Draw(
                sequence.BombVisual.Texture,
                screen,
                source,
                Color.White,
                rotation,
                origin,
                sourceScale,
                SpriteEffects.None,
                1f);
        }

        private static void DrawMainSplash(SpriteBatch b, BombFishingSequence sequence, long impactAge)
        {
            if (impactAge < 0 || impactAge > 1800) return;

            DrawSplashRing(b, sequence.ImpactWorld, impactAge, 0, 760, 42f, 150f + sequence.Tier.WaterRadius * 16f, 34);
            DrawSplashRing(b, sequence.ImpactWorld, impactAge, 145, 920, 34f, 185f + sequence.Tier.WaterRadius * 17f, 42);
            DrawSplashRing(b, sequence.ImpactWorld, impactAge, 310, 1080, 26f, 220f + sequence.Tier.WaterRadius * 18f, 50);

            if (impactAge > 260) return;
            float progress = MathHelper.Clamp(impactAge / 260f, 0f, 1f);
            float alpha = 1f - progress;
            float radius = MathHelper.Lerp(18f, 76f + sequence.Tier.WaterRadius * 8f, progress);
            Vector2 center = Game1.GlobalToLocal(Game1.viewport, sequence.ImpactWorld);
            for (int i = 0; i < 24; i++)
            {
                float angle = MathHelper.TwoPi * i / 24f;
                Vector2 offset = new((float)Math.Cos(angle) * radius, (float)Math.Sin(angle) * radius * 0.5f);
                float size = MathHelper.Lerp(12f, 4f, progress);
                b.Draw(
                    Game1.staminaRect,
                    center + offset,
                    null,
                    Color.White * alpha,
                    0f,
                    new Vector2(0.5f, 0.5f),
                    new Vector2(size, size),
                    SpriteEffects.None,
                    1f);
            }
        }

        private static void DrawSplashRing(
            SpriteBatch b,
            Vector2 worldCenter,
            long impactAge,
            long delay,
            long duration,
            float startRadius,
            float endRadius,
            int points)
        {
            if (impactAge < delay || impactAge > delay + duration) return;
            float progress = SmoothStep((impactAge - delay) / (float)duration);
            float alpha = (1f - progress) * 0.78f;
            float radius = MathHelper.Lerp(startRadius, endRadius, progress);
            Vector2 center = Game1.GlobalToLocal(Game1.viewport, worldCenter);

            for (int i = 0; i < points; i++)
            {
                float angle = MathHelper.TwoPi * i / points;
                Vector2 offset = new((float)Math.Cos(angle) * radius, (float)Math.Sin(angle) * radius * 0.42f);
                float size = 5f + (float)Math.Sin(angle * 3f) * 1.4f;
                b.Draw(
                    Game1.staminaRect,
                    center + offset,
                    null,
                    new Color(120, 215, 255) * alpha,
                    0f,
                    new Vector2(0.5f, 0.5f),
                    new Vector2(size, size),
                    SpriteEffects.None,
                    1f);
            }
        }

        private static void DrawWaterFlight(SpriteBatch b, WaterFlight flight, long elapsed)
        {
            if (flight.Landed) return;
            long localTime = elapsed - ImpactTimeMs - flight.DelayMs;
            if (localTime < 0 || localTime > flight.DurationMs) return;

            float progress = MathHelper.Clamp(localTime / (float)flight.DurationMs, 0f, 1f);
            Vector2 world = GetArcPosition(flight.Start, flight.End, flight.ArcHeight, progress);
            Vector2 screen = Game1.GlobalToLocal(Game1.viewport, world);
            Vector2 velocity = flight.End - flight.Start;
            velocity.Y -= 4f * flight.ArcHeight * (1f - 2f * progress);
            float rotation = (float)Math.Atan2(velocity.Y, velocity.X) + MathHelper.PiOver2;
            float alpha = progress < 0.9f ? 0.92f : (1f - progress) / 0.1f;

            b.Draw(
                Game1.staminaRect,
                screen,
                null,
                new Color(82, 184, 255) * alpha,
                rotation,
                new Vector2(0.5f, 0.5f),
                new Vector2(flight.Width, flight.Width * 2.7f),
                SpriteEffects.None,
                1f);
            b.Draw(
                Game1.staminaRect,
                screen - new Vector2(1f, 2f),
                null,
                Color.White * (alpha * 0.72f),
                rotation,
                new Vector2(0.5f, 0.5f),
                new Vector2(Math.Max(1.5f, flight.Width * 0.34f), flight.Width * 1.25f),
                SpriteEffects.None,
                1f);
        }

        private static void DrawFishFlight(SpriteBatch b, FishFlight flight, long elapsed)
        {
            if (flight.Landed) return;
            long localTime = elapsed - ImpactTimeMs - flight.DelayMs;
            if (localTime < 0 || localTime > flight.DurationMs) return;

            float progress = MathHelper.Clamp(localTime / (float)flight.DurationMs, 0f, 1f);
            Vector2 world = GetArcPosition(flight.Start, flight.End, flight.ArcHeight, progress);
            Vector2 screen = Game1.GlobalToLocal(Game1.viewport, world);
            Vector2 ground = Game1.GlobalToLocal(Game1.viewport, Vector2.Lerp(flight.Start, flight.End, progress));
            Rectangle source = flight.Visual.SourceRect;
            Vector2 origin = new(source.Width / 2f, source.Height / 2f);
            float sourceScale = Game1.pixelZoom * (16f / Math.Max(source.Width, source.Height));
            float rotation = flight.RotationOffset
                + (float)Math.Sin(progress * Math.PI * 4.5f) * 0.62f
                + progress * MathHelper.Pi;
            float alpha = progress > 0.93f ? (1f - progress) / 0.07f : 1f;

            b.Draw(
                Game1.staminaRect,
                ground + new Vector2(0f, 8f),
                null,
                Color.Black * (0.22f * alpha),
                0f,
                new Vector2(0.5f, 0.5f),
                new Vector2(28f, 9f),
                SpriteEffects.None,
                1f);
            b.Draw(
                flight.Visual.Texture,
                screen + new Vector2(3f, 5f),
                source,
                Color.Black * (0.25f * alpha),
                rotation,
                origin,
                sourceScale,
                SpriteEffects.None,
                1f);
            b.Draw(
                flight.Visual.Texture,
                screen,
                source,
                Color.White * alpha,
                rotation,
                origin,
                sourceScale,
                SpriteEffects.None,
                1f);
        }

        private static void DrawLandingSplash(SpriteBatch b, LandingSplash splash, long elapsed)
        {
            long age = elapsed - splash.StartMs;
            if (age < 0 || age > 480) return;
            float progress = SmoothStep(age / 480f);
            float alpha = 1f - progress;
            float radius = MathHelper.Lerp(4f, 30f * splash.Scale, progress);
            Vector2 center = Game1.GlobalToLocal(Game1.viewport, splash.Position);

            for (int i = 0; i < 8; i++)
            {
                float angle = MathHelper.TwoPi * i / 8f;
                Vector2 offset = new((float)Math.Cos(angle) * radius, (float)Math.Sin(angle) * radius * 0.55f);
                b.Draw(
                    Game1.staminaRect,
                    center + offset,
                    null,
                    new Color(100, 205, 255) * alpha,
                    0f,
                    new Vector2(0.5f, 0.5f),
                    new Vector2(5f * splash.Scale, 5f * splash.Scale),
                    SpriteEffects.None,
                    1f);
            }
        }

        private static Vector2 GetArcPosition(Vector2 start, Vector2 end, float height, float progress)
        {
            Vector2 position = Vector2.Lerp(start, end, progress);
            position.Y -= 4f * height * progress * (1f - progress);
            return position;
        }

        private static long GetElapsedMs(BombFishingSequence sequence)
        {
            long now = Game1.currentGameTime?.TotalGameTime.Ticks ?? sequence.StartTicks;
            return Math.Max(0, (now - sequence.StartTicks) / 10000);
        }

        private static float SmoothStep(float value)
        {
            value = MathHelper.Clamp(value, 0f, 1f);
            return value * value * (3f - 2f * value);
        }

        private float RandomRange(float min, float max)
        {
            return min + (float)this.random.NextDouble() * (max - min);
        }

        private static void TryPlaySound(GameLocation location, string cue, Vector2 tile)
        {
            try { location.playSound(cue, tile); }
            catch { }
        }

        private static void ShowHud(string message, int type)
        {
            try { Game1.addHUDMessage(new HUDMessage(message, type)); }
            catch { }
        }
    }
}

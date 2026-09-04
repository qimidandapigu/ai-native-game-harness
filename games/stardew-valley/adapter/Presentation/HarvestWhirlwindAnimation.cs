using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewAgentMod.Contracts;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentMod.Presentation;

/// <summary>
/// 只消费收获动作已经提交的物品 ID 与世界坐标，绘制作物旋转汇入玩家的演出。
/// 这里不持有 Crop、HoeDirt 等可变游戏对象，也不修改背包或地图状态。
/// </summary>
internal sealed class HarvestWhirlwindAnimation
{
    private const long AnimationDurationMs = 2_400;
    private const float FormationPortion = 0.2f;
    private const int SpiralArmCount = 6;
    private const float SpiralPitch = 42f;
    private const float BaseSpiralPhase = -1.5707964f;
    private const float MinFormationRadius = 56f;
    private const float LateralOffsetStdDev = 30f;
    private const float MaxLateralOffset = 90f;
    private static readonly Random FlightRandom = new();

    private readonly IMonitor monitor;
    private readonly List<HarvestFlight> flights = new();
    private bool active;
    private long animationStartTicks;

    public HarvestWhirlwindAnimation(IMonitor monitor)
    {
        this.monitor = monitor;
    }

    public void Start(HarvestWhirlwindEffect effect)
    {
        this.Reset();
        if (!Context.IsWorldReady || Game1.player is null || effect.Items.Count == 0)
            return;

        this.animationStartTicks = Now();
        foreach (HarvestWhirlwindItem item in effect.Items)
        {
            HarvestFlight? flight = this.TryCreateFlight(item);
            if (flight is not null)
                this.flights.Add(flight);
        }

        this.ArrangeFlightsOnSpiral();
        this.active = this.flights.Count > 0;
        if (this.active)
            this.monitor.Log($"[收割演出] 旋转收获动画已启动，共 {this.flights.Count} 个作物图标。", LogLevel.Info);
    }

    public void Draw(SpriteBatch batch)
    {
        if (!this.active || this.flights.Count == 0 || Game1.player is null)
            return;

        float progress = MathHelper.Clamp(this.GetElapsedMs() / (float)AnimationDurationMs, 0f, 1f);
        if (progress >= 1f)
        {
            this.Reset();
            return;
        }

        float formationProgress = SmoothStep(MathHelper.Clamp(progress / FormationPortion, 0f, 1f));
        float inwardProgress = GetInwardProgress(progress);
        Vector2 destination = GetPlayerDestination();

        for (int index = 0; index < this.flights.Count; index++)
        {
            HarvestFlight flight = this.flights[index];
            Vector2 world = GetSpiralPosition(flight, destination, progress);
            Vector2 screen = Game1.GlobalToLocal(Game1.viewport, world);

            float alpha = progress < 0.82f
                ? 1f
                : MathHelper.Clamp((1f - progress) / 0.18f, 0f, 1f);
            float iconScale = progress < FormationPortion
                ? MathHelper.Lerp(1f, 0.88f, formationProgress)
                : MathHelper.Lerp(0.88f, 0.24f, inwardProgress);
            float sourceScale = Game1.pixelZoom
                * (16f / Math.Max(flight.SourceRect.Width, flight.SourceRect.Height));
            float rotation = progress * MathHelper.TwoPi * (1.8f + (index % 4) * 0.12f);
            Vector2 origin = new(flight.SourceRect.Width / 2f, flight.SourceRect.Height / 2f);

            batch.Draw(
                flight.Texture,
                screen + new Vector2(3f, 5f),
                flight.SourceRect,
                Color.Black * (alpha * 0.28f),
                rotation,
                origin,
                sourceScale * iconScale,
                SpriteEffects.None,
                1f);
            batch.Draw(
                flight.Texture,
                screen,
                flight.SourceRect,
                Color.White * alpha,
                rotation,
                origin,
                sourceScale * iconScale,
                SpriteEffects.None,
                1f);
        }
    }

    public void Reset()
    {
        this.active = false;
        this.flights.Clear();
    }

    private HarvestFlight? TryCreateFlight(HarvestWhirlwindItem item)
    {
        if (string.IsNullOrWhiteSpace(item.QualifiedItemId))
            return null;

        try
        {
            var itemData = ItemRegistry.GetDataOrErrorItem(item.QualifiedItemId);
            Texture2D texture = itemData.GetTexture();
            Rectangle sourceRect = itemData.GetSourceRect();
            if (sourceRect.Width <= 0 || sourceRect.Height <= 0)
                return null;

            return new HarvestFlight(
                item.StartWorldPosition,
                texture,
                sourceRect,
                NextLateralOffset());
        }
        catch (Exception ex)
        {
            this.monitor.Log($"[收割旋风] {item.QualifiedItemId} 图标加载失败：{ex.Message}", LogLevel.Trace);
            return null;
        }
    }

    private void ArrangeFlightsOnSpiral()
    {
        if (this.flights.Count == 0) return;

        Vector2 center = GetPlayerDestination();
        List<HarvestFlight> ordered = this.flights
            .OrderBy(flight => Vector2.DistanceSquared(flight.StartWorldPosition, center))
            .ToList();

        for (int batchStart = 0; batchStart < ordered.Count; batchStart += SpiralArmCount)
        {
            List<HarvestFlight> batch = ordered
                .Skip(batchStart)
                .Take(SpiralArmCount)
                .OrderBy(flight => GetPolarAngle(flight.StartWorldPosition - center))
                .ToList();
            List<int> availableSlots = GetSymmetricArmSlots(batch.Count);

            foreach (HarvestFlight flight in batch)
            {
                Vector2 offset = flight.StartWorldPosition - center;
                float radius = Math.Max(MinFormationRadius, offset.Length());
                float actualAngle = GetPolarAngle(offset);
                int bestSlot = availableSlots[0];
                float bestDistance = float.MaxValue;

                foreach (int slot in availableSlots)
                {
                    float phase = BaseSpiralPhase + MathHelper.TwoPi * slot / SpiralArmCount;
                    float spiralAngle = phase + radius / SpiralPitch;
                    float angularDistance = Math.Abs(MathHelper.WrapAngle(actualAngle - spiralAngle));
                    if (angularDistance >= bestDistance) continue;
                    bestDistance = angularDistance;
                    bestSlot = slot;
                }

                availableSlots.Remove(bestSlot);
                flight.FormationRadius = radius;
                flight.ArmPhase = BaseSpiralPhase + MathHelper.TwoPi * bestSlot / SpiralArmCount;
            }
        }
    }

    private long GetElapsedMs()
    {
        return Math.Max(0, (Now() - this.animationStartTicks) / 10_000L);
    }

    private static Vector2 GetSpiralPosition(HarvestFlight flight, Vector2 destination, float progress)
    {
        if (progress < FormationPortion)
        {
            float formationProgress = SmoothStep(MathHelper.Clamp(progress / FormationPortion, 0f, 1f));
            Vector2 formationPoint = GetArchimedeanPoint(
                destination,
                flight.FormationRadius,
                flight.ArmPhase);
            float lift = (float)Math.Sin(formationProgress * Math.PI) * 20f;
            return Vector2.Lerp(flight.StartWorldPosition, formationPoint, formationProgress)
                + new Vector2(0f, -lift);
        }

        float inwardProgress = GetInwardProgress(progress);
        float radius = flight.FormationRadius * (1f - inwardProgress);
        Vector2 centerline = GetArchimedeanPoint(destination, radius, flight.ArmPhase);
        Vector2 normal = GetArchimedeanNormal(radius, flight.ArmPhase);
        float offsetEnvelope = (float)Math.Sin(inwardProgress * Math.PI);
        return centerline + normal * (flight.LateralOffset * offsetEnvelope);
    }

    private static Vector2 GetArchimedeanPoint(Vector2 center, float radius, float armPhase)
    {
        float angle = armPhase + radius / SpiralPitch;
        return center + new Vector2((float)Math.Cos(angle), (float)Math.Sin(angle)) * radius;
    }

    private static Vector2 GetArchimedeanNormal(float radius, float armPhase)
    {
        float angle = armPhase + radius / SpiralPitch;
        float radialToAngular = radius / SpiralPitch;
        Vector2 tangent = new(
            (float)Math.Cos(angle) - radialToAngular * (float)Math.Sin(angle),
            (float)Math.Sin(angle) + radialToAngular * (float)Math.Cos(angle));
        if (tangent.LengthSquared() < 0.0001f)
            return Vector2.UnitY;

        tangent.Normalize();
        return new Vector2(-tangent.Y, tangent.X);
    }

    private static List<int> GetSymmetricArmSlots(int count)
    {
        int[] slots = count switch
        {
            <= 1 => new[] { 0 },
            2 => new[] { 0, 3 },
            3 => new[] { 0, 2, 4 },
            4 => new[] { 0, 3, 1, 4 },
            5 => new[] { 0, 3, 1, 4, 2 },
            _ => new[] { 0, 1, 2, 3, 4, 5 }
        };
        return slots.ToList();
    }

    private static float NextLateralOffset()
    {
        double u1 = Math.Max(double.Epsilon, 1.0 - FlightRandom.NextDouble());
        double u2 = 1.0 - FlightRandom.NextDouble();
        double standardNormal = Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(MathHelper.TwoPi * u2);
        return Math.Clamp((float)(standardNormal * LateralOffsetStdDev), -MaxLateralOffset, MaxLateralOffset);
    }

    private static float GetInwardProgress(float progress)
    {
        float normalized = MathHelper.Clamp(
            (progress - FormationPortion) / (1f - FormationPortion),
            0f,
            1f);
        return SmoothStep(normalized);
    }

    private static float GetPolarAngle(Vector2 offset)
    {
        return (float)Math.Atan2(offset.Y, offset.X);
    }

    private static Vector2 GetPlayerDestination()
    {
        return Game1.player?.getStandingPosition() + new Vector2(0f, -42f) ?? Vector2.Zero;
    }

    private static float SmoothStep(float value)
    {
        return value * value * (3f - 2f * value);
    }

    private static long Now()
    {
        return Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
    }

    private sealed class HarvestFlight
    {
        public HarvestFlight(
            Vector2 startWorldPosition,
            Texture2D texture,
            Rectangle sourceRect,
            float lateralOffset)
        {
            this.StartWorldPosition = startWorldPosition;
            this.Texture = texture;
            this.SourceRect = sourceRect;
            this.LateralOffset = lateralOffset;
        }

        public Vector2 StartWorldPosition { get; }
        public Texture2D Texture { get; }
        public Rectangle SourceRect { get; }
        public float LateralOffset { get; }
        public float FormationRadius { get; set; }
        public float ArmPhase { get; set; }
    }
}

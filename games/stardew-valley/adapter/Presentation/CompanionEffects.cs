using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewAgentMod.Contracts;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentMod.Presentation;

/// <summary>
/// 纯表现层的农事施法与 idle 粒子。动作结果先由游戏接口层权威提交，
/// 这里随后消费只读坐标计划，不参与体力、物品或世界状态修改。
/// </summary>
internal sealed class CompanionEffects
{
    private const long ChargeMs = 300;
    private const long BeamTravelMs = 300;
    private const long BeamSpreadMs = 500;
    private const long SplashMs = 400;
    private const long IdleDurationMs = 1_800;

    private readonly Func<Vector2?> anchorProvider;
    private readonly Random random = new();
    private readonly List<Beam> beams = new();
    private readonly List<IdleBurst> idleBursts = new();
    private readonly HarvestWhirlwindAnimation harvestWhirlwind;
    private bool casting;
    private long castingStarted;
    private Vector2 castingOrigin;
    private Color castingColor;

    public CompanionEffects(Func<Vector2?> anchorProvider, IMonitor monitor)
    {
        this.anchorProvider = anchorProvider;
        this.harvestWhirlwind = new HarvestWhirlwindAnimation(monitor);
    }

    public void Start(ActionCastingEffect effect)
    {
        if (effect.Targets.Count == 0 || !Context.IsWorldReady) return;
        Vector2? anchor = this.anchorProvider();
        if (anchor is null && Game1.player is not null)
            anchor = new Vector2(Game1.player.GetBoundingBox().Center.X, Game1.player.GetBoundingBox().Top);
        if (anchor is null) return;

        this.casting = true;
        this.castingStarted = Now();
        this.castingOrigin = anchor.Value;
        this.castingColor = effect.Color;
        this.beams.Clear();
        foreach (Vector2 target in effect.Targets)
        {
            long fireMs = ChargeMs + this.random.Next(0, (int)BeamSpreadMs + 1);
            this.beams.Add(new Beam(target, fireMs, fireMs + BeamTravelMs));
        }
    }

    public void SpawnIdle(IdlePulseEffect effect)
    {
        Vector2? anchor = this.anchorProvider();
        if (anchor is null) return;
        this.idleBursts.Add(new IdleBurst(anchor.Value + new Vector2(0, -34), effect.Color, Now()));
    }

    public void Start(HarvestWhirlwindEffect effect)
    {
        this.Start(new ActionCastingEffect(effect.Targets, effect.Color));
        this.harvestWhirlwind.Start(effect);
    }

    public void Draw(SpriteBatch batch)
    {
        this.DrawCasting(batch);
        this.harvestWhirlwind.Draw(batch);
        this.DrawIdle(batch);
    }

    public void Reset()
    {
        this.casting = false;
        this.beams.Clear();
        this.idleBursts.Clear();
        this.harvestWhirlwind.Reset();
    }

    private void DrawCasting(SpriteBatch batch)
    {
        if (!this.casting) return;
        long elapsed = (Now() - this.castingStarted) / 10_000L;
        long totalMs = ChargeMs + BeamSpreadMs + BeamTravelMs + SplashMs;
        if (elapsed > totalMs)
        {
            this.casting = false;
            this.beams.Clear();
            return;
        }

        if (elapsed < ChargeMs + 200)
        {
            float progress = Math.Min(1f, elapsed / (float)ChargeMs);
            int radius = (int)(12 + progress * 28);
            float alpha = 1f - progress * 0.5f;
            Vector2 screen = Game1.GlobalToLocal(Game1.viewport, this.castingOrigin);
            DrawRing(batch, screen, radius, this.castingColor * alpha, 3);
            DrawRing(batch, screen, Math.Max(4, radius - 6), Color.White * (alpha * 0.7f), 2);
        }

        foreach (Beam beam in this.beams)
        {
            if (elapsed < beam.FireMs) continue;
            if (elapsed <= beam.ImpactMs)
            {
                float progress = (elapsed - beam.FireMs) / (float)BeamTravelMs;
                Vector2 direction = beam.Target - this.castingOrigin;
                Vector2 head = this.castingOrigin + direction * progress;
                Vector2 tail = this.castingOrigin + direction * Math.Max(0f, progress - 0.35f);
                DrawWorldLine(batch, tail, head, this.castingColor, 3);
                Vector2 headScreen = Game1.GlobalToLocal(Game1.viewport, head);
                batch.Draw(Game1.staminaRect, new Rectangle((int)headScreen.X - 3, (int)headScreen.Y - 3, 6, 6), Color.White);
                continue;
            }

            long splashElapsed = elapsed - beam.ImpactMs;
            if (splashElapsed >= SplashMs) continue;
            float splashProgress = splashElapsed / (float)SplashMs;
            float splashAlpha = 1f - splashProgress;
            Vector2 targetScreen = Game1.GlobalToLocal(Game1.viewport, beam.Target);
            DrawRing(batch, targetScreen, (int)(6 + splashProgress * 18), this.castingColor * splashAlpha, 2);
            int dotSize = Math.Max(2, (int)(10 * (1f - splashProgress)));
            batch.Draw(
                Game1.staminaRect,
                new Rectangle((int)targetScreen.X - dotSize / 2, (int)targetScreen.Y - dotSize / 2, dotSize, dotSize),
                Color.White * splashAlpha);
        }
    }

    private void DrawIdle(SpriteBatch batch)
    {
        long now = Now();
        for (int index = this.idleBursts.Count - 1; index >= 0; index--)
        {
            IdleBurst burst = this.idleBursts[index];
            long elapsedMs = (now - burst.StartTicks) / 10_000L;
            if (elapsedMs > IdleDurationMs)
            {
                this.idleBursts.RemoveAt(index);
                continue;
            }

            float progress = elapsedMs / (float)IdleDurationMs;
            float alpha = 1f - progress;
            Vector2 screen = Game1.GlobalToLocal(
                Game1.viewport,
                burst.Anchor + new Vector2(0, -progress * 26f));
            for (int dot = 0; dot < 3; dot++)
            {
                float delayed = progress - dot * 0.15f;
                if (delayed <= 0) continue;
                float dotAlpha = alpha * Math.Min(1f, delayed / 0.1f);
                int x = (int)screen.X - 17 + dot * 14;
                int y = (int)screen.Y;
                batch.Draw(Game1.staminaRect, new Rectangle(x - 1, y - 1, 10, 10), Color.Black * dotAlpha);
                batch.Draw(Game1.staminaRect, new Rectangle(x, y, 8, 8), burst.Color * dotAlpha);
            }
        }
    }

    private static void DrawRing(SpriteBatch batch, Vector2 center, int radius, Color color, int thickness)
    {
        int size = radius * 2;
        int x = (int)center.X;
        int y = (int)center.Y;
        batch.Draw(Game1.staminaRect, new Rectangle(x - radius, y - radius, size, thickness), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - radius, y + radius - thickness, size, thickness), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - radius, y - radius, thickness, size), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x + radius - thickness, y - radius, thickness, size), color);
    }

    private static void DrawWorldLine(SpriteBatch batch, Vector2 from, Vector2 to, Color color, int thickness)
    {
        Vector2 screenFrom = Game1.GlobalToLocal(Game1.viewport, from);
        Vector2 screenTo = Game1.GlobalToLocal(Game1.viewport, to);
        Vector2 difference = screenTo - screenFrom;
        float length = difference.Length();
        if (length < 1) return;
        batch.Draw(
            Game1.staminaRect,
            screenFrom,
            null,
            color,
            (float)Math.Atan2(difference.Y, difference.X),
            Vector2.Zero,
            new Vector2(length, thickness),
            SpriteEffects.None,
            0f);
    }

    private static long Now() => Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;

    private readonly record struct Beam(Vector2 Target, long FireMs, long ImpactMs);
    private readonly record struct IdleBurst(Vector2 Anchor, Color Color, long StartTicks);
}

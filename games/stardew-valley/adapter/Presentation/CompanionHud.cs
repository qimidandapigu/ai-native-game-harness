using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewAgentMod.Game.Companion;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentMod.Presentation;

/// <summary>
/// 纯表现层：绘制体力、心情、思考、互动粒子与日记入口。
/// 点击只回调语义化 interaction；它不直接修改任何 Domain 状态。
/// </summary>
internal sealed class CompanionHud
{
    private const long StatusDurationTicks = 8 * 10_000_000L;
    private const long MoodParticleLifeMs = 2_000;
    private const long MoodSpawnIntervalTicks = 4 * 10_000_000L;

    private readonly IInputHelper input;
    private readonly Func<Vector2?> anchorProvider;
    private readonly Func<Rectangle?> boundsProvider;
    private readonly Func<int> staminaProvider;
    private readonly Func<CompanionLifeSnapshot> lifeProvider;
    private readonly Func<bool> thinkingProvider;
    private readonly Func<List<CompanionDiarySnapshot>> diaryProvider;
    private readonly Action<bool> interaction;
    private readonly Random random = new();
    private readonly List<Spark> sparks = new();
    private readonly List<MoodParticle> moodParticles = new();

    private Rectangle? diaryButton;
    private long statusVisibleUntil;
    private long lastMoodSpawn;

    public CompanionHud(
        IInputHelper input,
        Func<Vector2?> anchorProvider,
        Func<Rectangle?> boundsProvider,
        Func<int> staminaProvider,
        Func<CompanionLifeSnapshot> lifeProvider,
        Func<bool> thinkingProvider,
        Func<List<CompanionDiarySnapshot>> diaryProvider,
        Action<bool> interaction)
    {
        this.input = input;
        this.anchorProvider = anchorProvider;
        this.boundsProvider = boundsProvider;
        this.staminaProvider = staminaProvider;
        this.lifeProvider = lifeProvider;
        this.thinkingProvider = thinkingProvider;
        this.diaryProvider = diaryProvider;
        this.interaction = interaction;
    }

    public void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (!Context.IsWorldReady || Game1.player is null || Game1.eventUp) return;
        if (e.Button is not SButton.MouseLeft and not SButton.MouseRight) return;

        var cursor = this.input.GetCursorPosition();
        if (e.Button == SButton.MouseLeft
            && this.diaryButton is Rectangle diaryBounds
            && diaryBounds.Contains((int)cursor.ScreenPixels.X, (int)cursor.ScreenPixels.Y))
        {
            this.input.Suppress(e.Button);
            Game1.playSound("bigSelect");
            List<DiaryMenu.Entry> entries = this.diaryProvider()
                .ConvertAll(entry => new DiaryMenu.Entry(entry.Date, entry.Text));
            Game1.activeClickableMenu = new DiaryMenu(entries);
            return;
        }
        if (Game1.activeClickableMenu is not null) return;

        Rectangle? fullBounds = this.boundsProvider();
        if (fullBounds is null) return;
        Rectangle bounds = BodyBounds(fullBounds.Value);
        if (!bounds.Contains((int)cursor.AbsolutePixels.X, (int)cursor.AbsolutePixels.Y)) return;

        this.input.Suppress(e.Button);
        bool friendly = e.Button == SButton.MouseLeft;
        this.interaction(friendly);
        this.SpawnSparks(
            new Vector2(bounds.Center.X, bounds.Center.Y),
            friendly ? Color.HotPink : Color.Red,
            friendly ? 10 : 14);
        Game1.playSound(friendly ? "dwop" : "clubhit");
        if (!friendly)
            this.statusVisibleUntil = (Game1.currentGameTime?.TotalGameTime.Ticks ?? 0) + StatusDurationTicks;
    }

    public void Draw(SpriteBatch batch)
    {
        if (!Context.IsWorldReady || Game1.player is null) return;
        long now = Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
        this.DrawMood(batch, now);
        this.DrawSparks(batch, now);
        if (this.thinkingProvider()) this.DrawThinking(batch, now);

        Rectangle? bounds = this.boundsProvider();
        if (bounds is null || now >= this.statusVisibleUntil)
        {
            this.diaryButton = null;
            return;
        }
        this.DrawStatus(batch, bounds.Value);
        this.DrawDiaryButton(batch, bounds.Value, now);
    }

    public void Reset()
    {
        this.diaryButton = null;
        this.statusVisibleUntil = 0;
        this.lastMoodSpawn = 0;
        this.sparks.Clear();
        this.moodParticles.Clear();
    }

    private void DrawStatus(SpriteBatch batch, Rectangle bounds)
    {
        CompanionLifeSnapshot life = this.lifeProvider();
        int stamina = Math.Clamp(this.staminaProvider(), 0, CompanionStamina.Max);
        string text = $"精力 {stamina}/{CompanionStamina.Max} · {life.MoodLabel} · {life.RelationshipStage}";
        SpriteFont font = Game1.smallFont;
        int width = Math.Max(190, (int)font.MeasureString(text).X + 20);
        const int height = 42;
        Vector2 anchor = Game1.GlobalToLocal(Game1.viewport, new Vector2(bounds.Right + 12, bounds.Top - 38));
        int x = Math.Clamp((int)anchor.X, 8, Math.Max(8, Game1.viewport.Width - width - 8));
        int y = Math.Clamp((int)anchor.Y, 8, Math.Max(8, Game1.viewport.Height - height - 8));

        IClickableMenu.drawTextureBox(
            batch,
            Game1.menuTexture,
            new Rectangle(0, 256, 60, 60),
            x,
            y,
            width,
            height,
            Color.White * 0.9f,
            0.75f,
            drawShadow: false);
        Utility.drawTextWithShadow(batch, text, font, new Vector2(x + 10, y + 5), Game1.textColor);

        int barX = x + 10;
        int barY = y + 29;
        int barWidth = width - 20;
        float ratio = stamina / (float)CompanionStamina.Max;
        batch.Draw(Game1.staminaRect, new Rectangle(barX, barY, barWidth, 5), Color.Black * 0.35f);
        Color bar = ratio <= 0.25f ? new Color(210, 82, 72)
            : ratio <= 0.55f ? new Color(228, 172, 65)
            : new Color(93, 188, 116);
        batch.Draw(Game1.staminaRect, new Rectangle(barX, barY, Math.Max(1, (int)(barWidth * ratio)), 5), bar);
    }

    private void DrawDiaryButton(SpriteBatch batch, Rectangle bounds, long now)
    {
        Vector2 anchor = Game1.GlobalToLocal(Game1.viewport, new Vector2(bounds.Right + 12, bounds.Top + 12));
        int x = (int)anchor.X;
        int y = (int)(anchor.Y + 2f * Math.Sin(now / 10_000f * 0.004f));
        const int width = 30;
        const int height = 34;
        Rectangle button = new(x - 4, y - 6, width + 12, height + 12);
        var cursor = this.input.GetCursorPosition();
        bool hover = button.Contains((int)cursor.ScreenPixels.X, (int)cursor.ScreenPixels.Y);
        float alpha = hover ? 1f : 0.9f;

        Color dark = new Color(74, 46, 28) * alpha;
        Color cover = new Color(150, 95, 48) * alpha;
        Color page = new Color(245, 236, 205) * alpha;
        Color ribbon = new Color(200, 60, 50) * alpha;
        batch.Draw(Game1.staminaRect, new Rectangle(x - 2, y - 2, width + 4, height + 4), dark);
        batch.Draw(Game1.staminaRect, new Rectangle(x, y, width, height), cover);
        batch.Draw(Game1.staminaRect, new Rectangle(x + width - 4, y + 3, 3, height - 6), page);
        batch.Draw(Game1.staminaRect, new Rectangle(x + 3, y + height - 4, width - 6, 3), page);
        batch.Draw(Game1.staminaRect, new Rectangle(x + 3, y + 2, 3, height - 4), dark);
        batch.Draw(Game1.staminaRect, new Rectangle(x + 9, y + 8, width - 15, height - 18), page);
        batch.Draw(Game1.staminaRect, new Rectangle(x + width - 11, y - 5, 4, 9), ribbon);
        this.diaryButton = button;
    }

    private void DrawMood(SpriteBatch batch, long now)
    {
        int mood = this.lifeProvider().Mood;
        bool heart = mood >= 7;
        bool cloud = mood <= -7;
        if ((heart || cloud) && now - this.lastMoodSpawn >= MoodSpawnIntervalTicks)
        {
            Rectangle? bounds = this.boundsProvider();
            if (bounds is not null)
            {
                this.lastMoodSpawn = now;
                this.moodParticles.Add(new MoodParticle(
                    now,
                    new Vector2(bounds.Value.Center.X + this.random.Next(-12, 13), bounds.Value.Top - 8),
                    heart,
                    (float)(this.random.NextDouble() - 0.5) * 0.01f));
            }
        }

        for (int index = this.moodParticles.Count - 1; index >= 0; index--)
        {
            MoodParticle particle = this.moodParticles[index];
            long elapsedMs = (now - particle.StartTicks) / 10_000L;
            if (elapsedMs > MoodParticleLifeMs)
            {
                this.moodParticles.RemoveAt(index);
                continue;
            }
            float progress = elapsedMs / (float)MoodParticleLifeMs;
            float alpha = 1f - progress;
            float y = particle.IsHeart ? -progress * 28f : progress * 12f;
            Vector2 screen = Game1.GlobalToLocal(
                Game1.viewport,
                particle.Anchor + new Vector2(particle.DriftX * elapsedMs, y));
            if (particle.IsHeart) DrawHeart(batch, (int)screen.X, (int)screen.Y, alpha);
            else DrawCloud(batch, (int)screen.X, (int)screen.Y, alpha);
        }
    }

    private void DrawThinking(SpriteBatch batch, long now)
    {
        Rectangle? bounds = this.boundsProvider();
        if (bounds is null) return;
        float phase = now / 10_000_000f * 3f;
        float pulse = 0.6f + 0.4f * Math.Abs((float)Math.Sin(phase));
        Vector2 screen = Game1.GlobalToLocal(
            Game1.viewport,
            new Vector2(bounds.Value.Center.X, bounds.Value.Top - 30 + 3f * (float)Math.Sin(phase * 0.7f)));
        DrawQuestionMark(batch, (int)screen.X + 1, (int)screen.Y + 1, Color.Black * (pulse * 0.6f));
        DrawQuestionMark(batch, (int)screen.X, (int)screen.Y, new Color(255, 235, 120) * pulse);
    }

    private void SpawnSparks(Vector2 origin, Color color, int count)
    {
        long now = Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
        for (int index = 0; index < count; index++)
        {
            double angle = Math.PI * 2 * index / count + (this.random.NextDouble() - 0.5) * 0.5;
            float speed = (float)(0.2 + this.random.NextDouble() * 0.15);
            this.sparks.Add(new Spark(
                origin,
                new Vector2((float)Math.Cos(angle) * speed, (float)Math.Sin(angle) * speed),
                now,
                color,
                count > 10 ? 8 : 6));
        }
    }

    private void DrawSparks(SpriteBatch batch, long now)
    {
        for (int index = this.sparks.Count - 1; index >= 0; index--)
        {
            Spark spark = this.sparks[index];
            float elapsedMs = (now - spark.StartTicks) / 10_000f;
            if (elapsedMs > 600)
            {
                this.sparks.RemoveAt(index);
                continue;
            }
            Vector2 screen = Game1.GlobalToLocal(Game1.viewport, spark.Origin + spark.Velocity * elapsedMs);
            float alpha = 1f - elapsedMs / 600f;
            batch.Draw(
                Game1.staminaRect,
                new Rectangle((int)screen.X - spark.Size / 2, (int)screen.Y - spark.Size / 2, spark.Size, spark.Size),
                spark.Color * alpha);
        }
    }

    private static Rectangle BodyBounds(Rectangle full)
    {
        int height = Math.Max(16, (int)(full.Height * 0.55f));
        return new Rectangle(full.X, full.Y, full.Width, Math.Min(full.Height, height));
    }

    private static void DrawHeart(SpriteBatch batch, int x, int y, float alpha)
    {
        Color color = new Color(255, 105, 150) * alpha;
        batch.Draw(Game1.staminaRect, new Rectangle(x - 5, y - 3, 4, 4), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x + 1, y - 3, 4, 4), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - 5, y, 10, 3), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - 3, y + 3, 6, 2), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - 1, y + 5, 2, 2), color);
    }

    private static void DrawCloud(SpriteBatch batch, int x, int y, float alpha)
    {
        batch.Draw(Game1.staminaRect, new Rectangle(x - 7, y, 14, 5), new Color(70, 70, 85) * (alpha * 0.85f));
        batch.Draw(Game1.staminaRect, new Rectangle(x - 4, y - 3, 8, 4), new Color(110, 110, 125) * (alpha * 0.7f));
        batch.Draw(Game1.staminaRect, new Rectangle(x + 1, y - 1, 5, 3), new Color(70, 70, 85) * (alpha * 0.85f));
    }

    private static void DrawQuestionMark(SpriteBatch batch, int x, int y, Color color)
    {
        batch.Draw(Game1.staminaRect, new Rectangle(x - 4, y - 8, 8, 3), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - 6, y - 6, 3, 4), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x + 3, y - 6, 3, 5), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x, y - 1, 4, 3), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - 1, y + 2, 3, 3), color);
        batch.Draw(Game1.staminaRect, new Rectangle(x - 1, y + 7, 3, 3), color);
    }

    private readonly record struct Spark(Vector2 Origin, Vector2 Velocity, long StartTicks, Color Color, int Size);
    private readonly record struct MoodParticle(long StartTicks, Vector2 Anchor, bool IsHeart, float DriftX);
}

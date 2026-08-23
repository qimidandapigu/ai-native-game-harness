using System;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentMod;

internal sealed class SpeechBubble
{
    private const long DurationMilliseconds = 6500;
    private readonly Func<Vector2?> anchorProvider;
    private string? text;
    private long startedAt;
    private bool persistent;

    public SpeechBubble(Func<Vector2?> anchorProvider)
    {
        this.anchorProvider = anchorProvider;
    }

    public void Show(string nextText)
    {
        this.text = nextText;
        this.startedAt = (Game1.currentGameTime?.TotalGameTime.Ticks ?? 0) / 10000;
        this.persistent = false;
    }

    public void ShowStatus(string nextText)
    {
        this.text = nextText;
        this.startedAt = (Game1.currentGameTime?.TotalGameTime.Ticks ?? 0) / 10000;
        this.persistent = true;
    }

    public void Clear()
    {
        this.text = null;
        this.persistent = false;
    }

    public void Draw(SpriteBatch batch, int yOffset)
    {
        if (string.IsNullOrWhiteSpace(this.text) || Game1.player is null) return;
        long now = (Game1.currentGameTime?.TotalGameTime.Ticks ?? 0) / 10000;
        long elapsed = now - this.startedAt;
        if (!this.persistent && elapsed >= DurationMilliseconds)
        {
            this.text = null;
            return;
        }

        float alpha = elapsed < 250 ? elapsed / 250f
            : !this.persistent && elapsed > DurationMilliseconds - 600
                ? (DurationMilliseconds - elapsed) / 600f
                : 1f;
        alpha = Math.Clamp(alpha, 0f, 1f);

        SpriteFont font = Game1.smallFont;
        int maxWidth = Math.Max(220, (int)(Game1.viewport.Width * 0.36));
        string wrapped = Game1.parseText(this.text, font, maxWidth);
        Vector2 size = font.MeasureString(wrapped);
        Vector2 world = this.anchorProvider()
            ?? new Vector2(Game1.player.Position.X + 72, Game1.player.Position.Y - 32);
        Vector2 anchor = Game1.GlobalToLocal(Game1.viewport, world);

        int x = (int)(anchor.X - size.X / 2f);
        int y = (int)(anchor.Y - yOffset - size.Y);
        const int padding = 24;
        x = Math.Clamp(x, padding, Math.Max(padding, Game1.viewport.Width - (int)size.X - padding));
        y = Math.Max(padding, y);

        IClickableMenu.drawTextureBox(
            batch,
            Game1.menuTexture,
            new Rectangle(0, 256, 60, 60),
            x - 16,
            y - 12,
            (int)size.X + 32,
            (int)size.Y + 24,
            Color.White * alpha,
            1f,
            drawShadow: false
        );
        Utility.drawTextWithShadow(batch, wrapped, font, new Vector2(x, y), Game1.textColor * alpha);
    }
}

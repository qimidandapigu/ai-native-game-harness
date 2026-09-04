using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using StardewValley;
using StardewValley.BellsAndWhistles;
using StardewValley.Menus;

namespace StardewAgentMod.Presentation
{
    /// <summary>
    /// 豆包日记界面:一本翻页的日记本。
    /// 一页一篇日记(日期标题 + 内容),左右箭头/方向键翻页,ESC 关闭。
    /// 数据由外部传入(DiarySystem 读 .diary.json),菜单只管显示。
    /// </summary>
    internal sealed class DiaryMenu : IClickableMenu
    {
        public readonly record struct Entry(string Date, string Text);

        private const int W = 700;
        private const int H = 540;

        private readonly List<Entry> entries;
        private int page;

        private ClickableTextureComponent prevButton = null!;
        private ClickableTextureComponent nextButton = null!;

        public DiaryMenu(List<Entry> entries)
            : base(
                Game1.uiViewport.Width / 2 - W / 2,
                Game1.uiViewport.Height / 2 - H / 2,
                W, H, showUpperRightCloseButton: true)
        {
            this.entries = entries ?? new List<Entry>();
            this.page = Math.Max(0, this.entries.Count - 1);  // 默认翻到最新一篇
            this.SetupButtons();
        }

        private void SetupButtons()
        {
            this.prevButton = new ClickableTextureComponent(
                new Rectangle(this.xPositionOnScreen - 16, this.yPositionOnScreen + H / 2 - 24, 48, 44),
                Game1.mouseCursors, new Rectangle(352, 495, 12, 11), 4f);
            this.nextButton = new ClickableTextureComponent(
                new Rectangle(this.xPositionOnScreen + W - 32, this.yPositionOnScreen + H / 2 - 24, 48, 44),
                Game1.mouseCursors, new Rectangle(365, 495, 12, 11), 4f);
        }

        public override void receiveLeftClick(int x, int y, bool playSound = true)
        {
            if (this.prevButton.containsPoint(x, y)) { this.TurnPage(-1); return; }
            if (this.nextButton.containsPoint(x, y)) { this.TurnPage(+1); return; }
            base.receiveLeftClick(x, y, playSound);
        }

        public override void receiveKeyPress(Keys key)
        {
            if (key == Keys.Left) { this.TurnPage(-1); return; }
            if (key == Keys.Right) { this.TurnPage(+1); return; }
            base.receiveKeyPress(key);
        }

        private void TurnPage(int delta)
        {
            if (this.entries.Count == 0) return;
            int next = Math.Clamp(this.page + delta, 0, this.entries.Count - 1);
            if (next != this.page)
            {
                this.page = next;
                Game1.playSound("shwip");
            }
        }

        public override void performHoverAction(int x, int y)
        {
            this.prevButton.tryHover(x, y);
            this.nextButton.tryHover(x, y);
            base.performHoverAction(x, y);
        }

        public override void draw(SpriteBatch b)
        {
            // 半透明遮罩
            b.Draw(Game1.fadeToBlackRect, Game1.graphics.GraphicsDevice.Viewport.Bounds, Color.Black * 0.5f);

            // 羊皮纸底框
            Game1.drawDialogueBox(
                this.xPositionOnScreen, this.yPositionOnScreen, W, H,
                speaker: false, drawOnlyBox: true);

            int innerX = this.xPositionOnScreen + 48;
            int innerY = this.yPositionOnScreen + 48;
            int innerW = W - 96;

            // 标题
            string title = "豆包的日记";
            SpriteText.drawStringHorizontallyCenteredAt(
                b, title, this.xPositionOnScreen + W / 2, innerY);

            int contentTop = innerY + 64;

            if (this.entries.Count == 0)
            {
                Utility.drawTextWithShadow(
                    b, "还没有日记。\n\n她睡过一晚才会开始写。",
                    Game1.dialogueFont,
                    new Vector2(innerX, contentTop), Game1.textColor);
            }
            else
            {
                var entry = this.entries[this.page];

                // 日期(深色小标)
                Utility.drawTextWithShadow(
                    b, entry.Date, Game1.dialogueFont,
                    new Vector2(innerX, contentTop), Game1.textColor * 0.7f);

                // 正文(自动换行)
                string wrapped = Game1.parseText(entry.Text, Game1.dialogueFont, innerW);
                Utility.drawTextWithShadow(
                    b, wrapped, Game1.dialogueFont,
                    new Vector2(innerX, contentTop + 56), Game1.textColor);

                // 页码
                string pageLabel = $"{this.page + 1} / {this.entries.Count}";
                SpriteText.drawStringHorizontallyCenteredAt(
                    b, pageLabel, this.xPositionOnScreen + W / 2, this.yPositionOnScreen + H - 80);

                // 翻页箭头(到头就半透明)
                this.prevButton.draw(b, Color.White * (this.page > 0 ? 1f : 0.35f), 0.9f);
                this.nextButton.draw(b, Color.White * (this.page < this.entries.Count - 1 ? 1f : 0.35f), 0.9f);
            }

            base.draw(b);  // 关闭按钮
            this.drawMouse(b);
        }
    }
}

using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;

namespace StardewAgentMod.Game.Flight
{
    /// <summary>位于豆包坐骑下方的双喷口火焰与短寿命像素拖尾,不依赖外部贴图资源。</summary>
    internal sealed class JetTrailFx
    {
        private const float MountOpaqueBottomInset = 12f;

        private readonly Random random = new();
        private readonly List<JetParticle> particles = new();
        private int spawnTick;

        public void Reset()
        {
            this.spawnTick = 0;
            this.particles.Clear();
        }

        public void Update(Farmer who, float altitude, FlightState state, float elapsedMs)
        {
            float seconds = elapsedMs / 1000f;
            for (int i = this.particles.Count - 1; i >= 0; i--)
            {
                JetParticle particle = this.particles[i];
                particle.AgeMs += elapsedMs;
                if (particle.AgeMs >= particle.LifetimeMs)
                {
                    this.particles.RemoveAt(i);
                    continue;
                }

                particle.Position += particle.Velocity * seconds;
                particle.Velocity.Y += 45f * seconds;
            }

            this.spawnTick++;
            int interval = state switch
            {
                FlightState.TakingOff => 1,
                FlightState.Flying => 2,
                _ => 3
            };
            if (this.spawnTick % interval != 0 || altitude < 3f)
                return;

            int count = state == FlightState.TakingOff ? 3 : 2;
            GetNozzleGeometry(who, altitude, out Vector2 basePosition, out Vector2 exhaustDirection, out Vector2 nozzleAxis);
            for (int i = 0; i < count; i++)
            {
                float nozzleOffset = i % 2 == 0 ? -7f : 7f;
                float sidewaysJitter = (float)(this.random.NextDouble() * 6d - 3d);
                Color color = this.random.NextDouble() < 0.45d
                    ? Color.DeepSkyBlue
                    : this.random.NextDouble() < 0.65d ? Color.White : Color.Orange;
                this.particles.Add(new JetParticle
                {
                    Position = basePosition
                        + nozzleAxis * (nozzleOffset + sidewaysJitter)
                        + exhaustDirection * this.random.Next(0, 7),
                    Velocity = exhaustDirection
                            * (state == FlightState.TakingOff ? this.random.Next(125, 190) : this.random.Next(85, 145))
                        + nozzleAxis * (float)(this.random.NextDouble() * 34d - 17d),
                    LifetimeMs = this.random.Next(280, 560),
                    Size = this.random.Next(4, 9),
                    Color = color
                });
            }
        }

        public void Draw(SpriteBatch spriteBatch, Farmer? who, float altitude, FlightState state)
        {
            for (int i = 0; i < this.particles.Count; i++)
            {
                JetParticle particle = this.particles[i];
                float life = Math.Clamp(1f - particle.AgeMs / particle.LifetimeMs, 0f, 1f);
                int size = Math.Max(1, (int)Math.Round(particle.Size * (0.45f + life * 0.55f)));
                Vector2 screen = Game1.GlobalToLocal(Game1.viewport, particle.Position);
                spriteBatch.Draw(
                    Game1.staminaRect,
                    new Rectangle((int)screen.X - size / 2, (int)screen.Y - size / 2, size, size),
                    particle.Color * life);
            }

            if (who?.currentLocation == null || altitude < 4f)
                return;

            GetNozzleGeometry(who, altitude, out Vector2 nozzle, out Vector2 exhaustDirection, out Vector2 nozzleAxis);
            int flameLength = state == FlightState.TakingOff ? 18 : 11;
            float alpha = Math.Clamp(altitude / 28f, 0.15f, 1f);

            DrawFlame(spriteBatch, nozzle + nozzleAxis * -7f, exhaustDirection, flameLength, 4f, Color.DeepSkyBlue * alpha);
            DrawFlame(spriteBatch, nozzle + nozzleAxis * 7f, exhaustDirection, flameLength, 4f, Color.DeepSkyBlue * alpha);
            DrawFlame(spriteBatch, nozzle + nozzleAxis * -7f, exhaustDirection, Math.Max(4, flameLength - 4), 2f, Color.White * alpha);
            DrawFlame(spriteBatch, nozzle + nozzleAxis * 7f, exhaustDirection, Math.Max(4, flameLength - 4), 2f, Color.White * alpha);
        }

        private static void GetNozzleGeometry(
            Farmer who,
            float altitude,
            out Vector2 nozzle,
            out Vector2 exhaustDirection,
            out Vector2 nozzleAxis)
        {
            // 豆包按原版 Horse 的 128x128 绘制框定位;altitude 是最终可视高度,
            // 直接从该绘制框的底部取喷口,避免再次混用 Farmer.yJumpOffset 的半高度单位。
            exhaustDirection = Vector2.UnitY;
            nozzleAxis = -Vector2.UnitX;
            Vector2 seatOffset = DoubaoMountPatches.GetRiderDrawOffset(who.FacingDirection);
            nozzle = who.Position + seatOffset + new Vector2(
                DoubaoMountPatches.RiderFrameWorldSize / 2f,
                -altitude
                    + DoubaoMountPatches.RiderFrameWorldSize
                    - MountOpaqueBottomInset);
        }

        private static void DrawFlame(
            SpriteBatch spriteBatch,
            Vector2 worldPosition,
            Vector2 direction,
            float length,
            float width,
            Color color)
        {
            Vector2 screenPosition = Game1.GlobalToLocal(Game1.viewport, worldPosition);
            float rotation = MathF.Atan2(direction.Y, direction.X);
            spriteBatch.Draw(
                Game1.staminaRect,
                screenPosition,
                sourceRectangle: null,
                color,
                rotation,
                origin: new Vector2(0f, 0.5f),
                scale: new Vector2(length, width),
                effects: SpriteEffects.None,
                layerDepth: 1f);
        }

        private sealed class JetParticle
        {
            public Vector2 Position;
            public Vector2 Velocity;
            public float AgeMs;
            public float LifetimeMs;
            public float Size;
            public Color Color;
        }
    }
}

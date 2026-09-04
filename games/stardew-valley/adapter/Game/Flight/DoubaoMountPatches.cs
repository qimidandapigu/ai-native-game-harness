using System;
using HarmonyLib;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;

namespace StardewAgentMod.Game.Flight
{
    /// <summary>
    /// 让一个普通的原版 Horse 实例以豆包贴图绘制。
    /// 实体仍是原版 Horse,因此 Farmer.mount、骑乘动画、移动速度和碰撞盒都沿用游戏逻辑;
    /// Harmony 只替换带有本 Mod 标记的临时坐骑绘制,并阻止原版把它卸载到地图中。
    /// </summary>
    internal static class DoubaoMountPatches
    {
        internal const string MarkerKey = "qimidandapigu.StardewAgent/DoubaoFlightMount";
        internal const string MarkerName = "StardewAgent_DoubaoFlightMount";
        internal const string RiderTextureAsset =
            "Mods/qimidandapigu.XiaoTangYuanCompanion/rider";

        // 原版 Horse 使用 32x32 帧按 4 倍绘制,最终占用 128x128 世界像素。
        // 豆包源帧是 64x64,因此按 2 倍绘制并复用 Horse 左上角锚点,人物才能落在坐骑上。
        private const int RiderFrameSize = 64;
        private const float RiderDrawScale = 2f;
        internal const float RiderFrameWorldSize = RiderFrameSize * RiderDrawScale;

        // 侧面豆包的可坐斜面位于背部:向右时在画面左侧,向左时在画面右侧。
        // 侧视图额外上移 16px,让骑手腿部压进斜面形成包裹关系,不再像站在豆包上。
        private const float SideSeatOffsetX = 32f;
        private const float CenterSeatOffsetY = -32f;
        private const float SideSeatOffsetY = -48f;

        private static IMonitor? monitor;
        private static FlightController? controller;
        private static bool ready;
        private static string? lastTextureError;

        public static bool IsReady => ready;

        public static void Apply(
            string harmonyId,
            FlightController flightController,
            IMonitor patchMonitor)
        {
            monitor = patchMonitor;
            controller = flightController;
            var harmony = new Harmony(harmonyId + ".DoubaoMount");
            try
            {
                var draw = AccessTools.Method(
                    typeof(Horse),
                    nameof(Horse.draw),
                    new[] { typeof(SpriteBatch) });
                var checkAction = AccessTools.Method(
                    typeof(Horse),
                    nameof(Horse.checkAction),
                    new[] { typeof(Farmer), typeof(GameLocation) });
                var dismount = AccessTools.Method(
                    typeof(Horse),
                    nameof(Horse.dismount),
                    new[] { typeof(bool) });

                if (draw == null || checkAction == null || dismount == null)
                    throw new MissingMethodException("Stardew 1.6 Horse 骑乘接口不存在");

                harmony.Patch(
                    draw,
                    prefix: new HarmonyMethod(typeof(DoubaoMountPatches), nameof(BeforeDraw)));
                harmony.Patch(
                    checkAction,
                    prefix: new HarmonyMethod(typeof(DoubaoMountPatches), nameof(BeforeCheckAction)));
                harmony.Patch(
                    dismount,
                    prefix: new HarmonyMethod(typeof(DoubaoMountPatches), nameof(BeforeDismount)));

                ready = true;
                patchMonitor.Log("[飞行坐骑] 已安装豆包 Horse 绘制与卸载保护补丁", LogLevel.Trace);
            }
            catch (Exception ex)
            {
                ready = false;
                controller = null;
                patchMonitor.Log($"[飞行坐骑] 原版 Horse 接口补丁安装失败,已禁用起飞:{ex}", LogLevel.Error);
            }
        }

        public static bool IsTemporaryMount(Horse? horse)
        {
            if (horse == null)
                return false;

            return string.Equals(horse.Name, MarkerName, StringComparison.Ordinal)
                || horse.modData.ContainsKey(MarkerKey);
        }

        public static void MarkTemporaryMount(Horse horse, Farmer owner)
        {
            horse.Name = MarkerName;
            horse.displayName = "豆包";
            horse.ownerId.Value = owner.UniqueMultiplayerID;
            horse.modData[MarkerKey] = "1";
        }

        private static bool BeforeDraw(Horse __instance, SpriteBatch b)
        {
            if (!IsTemporaryMount(__instance))
                return true;

            Farmer? rider = __instance.rider;
            int jumpOffset = rider?.yJumpOffset ?? __instance.yJumpOffset;
            int facingDirection = rider?.FacingDirection ?? __instance.FacingDirection;
            int frame = facingDirection switch
            {
                Game1.down => 0,
                Game1.right => 1,
                Game1.up => 2,
                Game1.left => 3,
                _ => 0
            };
            Vector2 seatOffset = GetRiderDrawOffset(facingDirection);

            // Farmer.draw() 的骑手位置会应用两次 yJumpOffset:getLocalPosition() 一次,
            // 交给 FarmerRenderer 前再一次。坐骑必须走相同换算,否则骑手会悬在豆包上方。
            Vector2 screenPosition = __instance.getLocalPosition(Game1.viewport)
                + new Vector2(0f, jumpOffset)
                + seatOffset;
            float layerDepth = Math.Clamp(__instance.StandingPixel.Y / 10000f - 0.0001f, 0f, 1f);

            try
            {
                Texture2D texture = Game1.content.Load<Texture2D>(RiderTextureAsset);
                if (texture.Width < RiderFrameSize * 4 || texture.Height < RiderFrameSize)
                {
                    throw new InvalidOperationException(
                        $"坐骑贴图尺寸应至少为 256x64,实际为 {texture.Width}x{texture.Height}");
                }

                b.Draw(
                    texture,
                    screenPosition,
                    new Rectangle(frame * RiderFrameSize, 0, RiderFrameSize, RiderFrameSize),
                    Color.White,
                    rotation: 0f,
                    origin: Vector2.Zero,
                    scale: RiderDrawScale,
                    effects: SpriteEffects.None,
                    layerDepth);
                lastTextureError = null;
            }
            catch (Exception ex)
            {
                // 皮肤包缺失或资源尚未就绪时仍保留一个抬升后的原版马兜底,不让玩家隐形骑乘。
                DrawVanillaFallback(__instance, b, jumpOffset, layerDepth);
                if (!string.Equals(lastTextureError, ex.Message, StringComparison.Ordinal))
                {
                    lastTextureError = ex.Message;
                    monitor?.Log($"[飞行坐骑] 豆包坐骑贴图加载失败,临时显示原版马:{ex.Message}", LogLevel.Warn);
                }
            }

            return false;
        }

        /// <summary>取得豆包贴图相对骑手的座位校准;喷气口也复用同一偏移。</summary>
        internal static Vector2 GetRiderDrawOffset(int facingDirection)
        {
            return facingDirection switch
            {
                Game1.right => new Vector2(SideSeatOffsetX, SideSeatOffsetY),
                Game1.left => new Vector2(-SideSeatOffsetX, SideSeatOffsetY),
                _ => new Vector2(0f, CenterSeatOffsetY)
            };
        }

        private static bool BeforeCheckAction(Horse __instance, ref bool __result)
        {
            if (!IsTemporaryMount(__instance))
                return true;

            // 飞行只允许通过“帮我落地”结束,避免原版交互把临时 Horse 留在地图角色列表中。
            __result = true;
            return false;
        }

        private static bool BeforeDismount(Horse __instance, bool from_demolish)
        {
            if (!IsTemporaryMount(__instance))
                return true;

            if (controller?.HandleVanillaDismountRequest(__instance, from_demolish) != true)
                DetachOrphanTemporaryMount(__instance);
            return false;
        }

        private static void DetachOrphanTemporaryMount(Horse mount)
        {
            Farmer? rider = mount.rider;
            Vector2 riderPosition = rider?.Position ?? mount.Position;
            mount.currentLocation?.characters.Remove(mount);
            rider?.currentLocation?.characters.Remove(mount);
            if (rider != null && ReferenceEquals(rider.mount, mount))
                rider.mount = null;
            mount.rider = null;
            mount.mounting.Value = false;
            mount.dismounting.Value = false;
            if (rider != null)
                rider.Position = riderPosition;
            monitor?.Log("[飞行坐骑] 清理了失去控制器关联的临时坐骑", LogLevel.Warn);
        }

        private static void DrawVanillaFallback(
            Horse horse,
            SpriteBatch spriteBatch,
            int jumpOffset,
            float layerDepth)
        {
            AnimatedSprite? sprite = horse.Sprite;
            Texture2D? texture = sprite?.Texture;
            if (texture == null || sprite == null)
                return;

            Vector2 screenPosition = horse.getLocalPosition(Game1.viewport)
                + new Vector2(0f, jumpOffset);
            spriteBatch.Draw(
                texture,
                screenPosition,
                sprite.SourceRect,
                Color.White,
                rotation: 0f,
                origin: Vector2.Zero,
                scale: 4f,
                effects: SpriteEffects.None,
                layerDepth);
        }
    }
}

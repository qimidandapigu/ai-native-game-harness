using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Locations;

namespace StardewAgentMod.Game.Flight
{
    internal enum FlightState
    {
        Grounded,
        TakingOff,
        Flying,
        Landing
    }

    /// <summary>
    /// 本地玩家飞行状态机。
    /// 物理坐标仍留在当前 GameLocation,只在主线程临时忽略地形碰撞;
    /// yJumpOffset 仅负责把玩家画到空中,不会伪造跨地图坐标。
    /// </summary>
    internal sealed class FlightController
    {
        private const float CruiseAltitude = 104f;
        private const float FarmerJumpVisualScale = 2f;
        private const float TakeoffDurationMs = 900f;
        private const float LandingDurationMs = 1500f;
        private const int VillagerReactionIntervalTicks = 12;
        private const float VillagerSightRadiusPixels = 7f * 64f;
        private const int VillagerShockDurationMs = 1600;
        private const float VillagerShockHorizontalAmplitude = 8f;
        private const float VillagerShockVerticalAmplitude = 4f;

        private readonly IMonitor monitor;
        private readonly JetTrailFx jetTrail = new();
        private readonly HashSet<string> shockedVillagers = new(StringComparer.Ordinal);
        private readonly Dictionary<NPC, VillagerShockEffect> activeVillagerShocks = new();

        private FlightState state;
        private Farmer? flyer;
        private GameLocation? originLocation;
        private Point takeoffTile;
        private bool savedIgnoreCollisions;
        private bool savedCanMove;
        private int savedJumpOffset;
        private float savedJumpVelocity;
        private float savedRotation;
        private int savedFacingDirection;
        private bool savedPauseForSingleAnimation;
        private int savedSpeed;
        private bool savedRunning;
        private float savedXOffset;
        private float savedYOffset;
        private bool savedIsAnimatingMount;
        private Horse? flightMount;
        private float altitude;
        private float transitionElapsedMs;
        private Vector2 landingStartPosition;
        private float landingStartAltitude;
        private Point landingTile;
        private int villagerReactionTick;
        private long lastWarpNoticeTicks;

        public FlightController(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        public bool IsAirborne => this.state != FlightState.Grounded;
        public bool IsTransitioning => this.state is FlightState.TakingOff or FlightState.Landing;

        /// <summary>飞行中只限制非步行出口换图;普通碰撞 Warp/门由补丁签发一次性许可。</summary>
        public bool ShouldBlockMapTransition(Character? character = null)
        {
            if (!this.IsAirborne || Game1.eventUp || Game1.newDay || (this.flyer?.health ?? 1) <= 0)
                return false;

            return character == null || ReferenceEquals(character, this.flyer);
        }

        public bool TryTakeOff(out string feedback)
        {
            feedback = "";
            if (!FlightWarpPatches.IsReady || !DoubaoMountPatches.IsReady)
            {
                feedback = "飞行边界或豆包坐骑没有准备好,现在起飞会不安全。";
                return false;
            }

            if (this.state != FlightState.Grounded)
            {
                feedback = this.state == FlightState.Landing
                    ? "正往下降呢,等我落稳。"
                    : "已经飞起来啦。";
                return false;
            }

            Farmer? who = Game1.player;
            GameLocation? location = who?.currentLocation;
            if (who == null || location == null || !Context.IsWorldReady)
            {
                feedback = "现在还不能起飞。";
                return false;
            }

            if (!IsMainMap(location))
            {
                feedback = "这里只能在室外主地图飞,室内、矿洞和地下城都不行。";
                return false;
            }

            if (Game1.newDay || Game1.eventUp || Game1.currentMinigame != null
                || Game1.activeClickableMenu != null || !who.CanMove)
            {
                feedback = "现在忙着呢,等能自由走动时再起飞。";
                return false;
            }

            if (who.mount != null)
            {
                feedback = "先从坐骑上下来,不然我带不动。";
                return false;
            }

            if (who.yJumpOffset != 0)
            {
                feedback = "先站稳再起飞。";
                return false;
            }

            this.flyer = who;
            this.originLocation = location;
            this.takeoffTile = who.TilePoint;
            this.savedIgnoreCollisions = who.ignoreCollisions;
            this.savedCanMove = who.CanMove;
            this.savedJumpOffset = who.yJumpOffset;
            this.savedJumpVelocity = who.yJumpVelocity;
            this.savedRotation = who.rotation;
            this.savedFacingDirection = who.FacingDirection;
            this.savedPauseForSingleAnimation = who.FarmerSprite.PauseForSingleAnimation;
            this.savedSpeed = who.speed;
            this.savedRunning = who.running;
            this.savedXOffset = who.xOffset;
            this.savedYOffset = who.yOffset;
            this.savedIsAnimatingMount = who.isAnimatingMount;
            this.altitude = Math.Max(0f, -who.yJumpOffset * FarmerJumpVisualScale);
            this.transitionElapsedMs = 0f;
            this.villagerReactionTick = 0;
            this.jetTrail.Reset();
            this.ClearActiveVillagerShocks();
            this.shockedVillagers.Clear();
            FlightWarpPatches.ClearOrdinaryExitPermit();

            who.Halt();
            if (!this.TryAttachTemporaryMount(who, location, out string mountError))
            {
                this.RestorePlayerState(who, restoreMovement: true);
                this.ClearState();
                feedback = mountError;
                return false;
            }

            who.CanMove = false;
            who.ignoreCollisions = true;
            who.yJumpVelocity = 0f;

            if (!this.SyncTemporaryMount(who))
            {
                this.RestorePlayerState(who, restoreMovement: true);
                this.ClearState();
                feedback = "豆包坐骑状态意外丢失,先不起飞。";
                return false;
            }
            this.state = FlightState.TakingOff;
            this.ApplyFlightVisual(who);

            feedback = "抓稳,起飞!";
            this.monitor.Log($"[飞行] 开始起飞 location={location.NameOrUniqueName} tile={this.takeoffTile}", LogLevel.Info);
            return true;
        }

        public bool TryLand(out string feedback)
        {
            feedback = "";
            if (this.state == FlightState.Grounded)
            {
                feedback = "还站在地上呢。";
                return false;
            }

            if (this.state == FlightState.Landing)
            {
                feedback = "正在慢慢降落。";
                return false;
            }

            Farmer? who = this.flyer;
            GameLocation? location = who?.currentLocation;
            if (who == null || location == null || !ReferenceEquals(location, this.originLocation))
            {
                this.ResetAfterExternalTransition("落地前地图状态已经变化");
                feedback = "地图变了,我先把飞行停掉。";
                return false;
            }

            Point? nearest = FlightLandingLocator.FindNearest(location, who, who.TilePoint);
            if (nearest == null)
            {
                feedback = "附近找不到能站稳的地块,先飞到开阔一点的地方。";
                this.monitor.Log("[飞行] 落地失败:当前地图找不到可行走地块", LogLevel.Warn);
                return false;
            }

            this.landingTile = nearest.Value;
            this.landingStartPosition = who.Position;
            this.landingStartAltitude = Math.Max(1f, this.altitude);
            this.transitionElapsedMs = 0f;
            this.state = FlightState.Landing;
            who.Halt();
            who.CanMove = false;
            who.ignoreCollisions = true;

            feedback = "找到落脚点了,慢慢降下去。";
            this.monitor.Log(
                $"[飞行] 开始降落 from={who.TilePoint} target={this.landingTile}",
                LogLevel.Info);
            return true;
        }

        /// <summary>由 ModEntry.UpdateTicked 在主线程调用。</summary>
        public void Update()
        {
            if (this.state == FlightState.Grounded)
                return;

            Farmer? who = this.flyer;
            if (!Context.IsWorldReady || who == null || who.currentLocation == null)
            {
                this.ResetAfterExternalTransition("世界或玩家状态不可用");
                return;
            }

            if (!ReferenceEquals(who.currentLocation, this.originLocation))
            {
                // 原版先切 Game1.player.currentLocation,SMAPI 的 Player.Warped 再晚一拍到达。
                // 已由普通步行出口签发的换图在这里等待事件完成,避免 UpdateTicked 抢先清掉飞行状态。
                if (FlightWarpPatches.IsOrdinaryWarpTransitionInProgress(who.currentLocation))
                    return;

                this.ResetAfterExternalTransition("检测到外部换图");
                return;
            }

            if (Game1.newDay || Game1.eventUp || who.health <= 0)
            {
                this.ForceLandImmediately("剧情、昏倒或过夜流程开始");
                return;
            }

            float elapsedMs = (float)(Game1.currentGameTime?.ElapsedGameTime.TotalMilliseconds ?? 16.667);
            elapsedMs = Math.Clamp(elapsedMs, 0f, 100f);

            who.ignoreCollisions = true;
            who.yJumpVelocity = 0f;
            if (!this.SyncTemporaryMount(who))
            {
                this.ForceLandImmediately("豆包坐骑状态意外丢失");
                return;
            }

            switch (this.state)
            {
                case FlightState.TakingOff:
                {
                    this.transitionElapsedMs += elapsedMs;
                    float t = Math.Clamp(this.transitionElapsedMs / TakeoffDurationMs, 0f, 1f);
                    this.altitude = CruiseAltitude * EaseOutCubic(t);
                    if (t >= 1f)
                    {
                        this.state = FlightState.Flying;
                        if (this.savedCanMove && Game1.activeClickableMenu == null)
                            who.forceCanMove();
                        this.monitor.Log("[飞行] 已进入巡航状态", LogLevel.Info);
                    }
                    break;
                }

                case FlightState.Flying:
                {
                    double seconds = (Game1.currentGameTime?.TotalGameTime.TotalSeconds ?? 0d);
                    this.altitude = CruiseAltitude + (float)Math.Sin(seconds * 3.4d) * 3f;
                    if (this.savedCanMove && !who.CanMove && !Game1.isWarping
                        && !Game1.eventUp && Game1.activeClickableMenu == null)
                    {
                        who.forceCanMove();
                    }
                    break;
                }

                case FlightState.Landing:
                {
                    who.CanMove = false;
                    this.transitionElapsedMs += elapsedMs;
                    float t = Math.Clamp(this.transitionElapsedMs / LandingDurationMs, 0f, 1f);
                    float eased = SmoothStep(t);
                    Vector2 targetPosition = new(this.landingTile.X * 64f, this.landingTile.Y * 64f);
                    who.Position = Vector2.Lerp(this.landingStartPosition, targetPosition, eased);
                    this.altitude = MathHelper.Lerp(this.landingStartAltitude, 0f, eased);
                    if (t >= 1f)
                    {
                        this.CompleteLanding(who, who.currentLocation);
                        return;
                    }
                    break;
                }
            }

            this.ClampPlayerToMap(who, who.currentLocation);
            this.ApplyFlightVisual(who);
            this.jetTrail.Update(who, this.altitude, this.state, elapsedMs);
            this.UpdateVillagerReactions(who, who.currentLocation, elapsedMs);
        }

        public void Draw(SpriteBatch spriteBatch)
        {
            if (this.state == FlightState.Grounded)
                return;

            this.jetTrail.Draw(spriteBatch, this.flyer, this.altitude, this.state);
        }

        public void NotifyWarpBlocked()
        {
            long now = Game1.currentGameTime?.TotalGameTime.Ticks ?? Environment.TickCount64 * TimeSpan.TicksPerMillisecond;
            if (now - this.lastWarpNoticeTicks < TimeSpan.TicksPerSecond * 2)
                return;

            this.lastWarpNoticeTicks = now;
            Game1.addHUDMessage(new HUDMessage("飞行时只能从平时走路使用的出入口换地图。", HUDMessage.error_type));
        }

        /// <summary>普通出口换图后延续室外飞行;进入室内或地下区域时立即恢复地面状态。</summary>
        public void OnWarped(GameLocation? oldLocation, GameLocation newLocation)
        {
            if (this.state == FlightState.Grounded)
                return;

            Farmer? who = this.flyer;
            if (who == null || !ReferenceEquals(who.currentLocation, newLocation)
                || Game1.newDay || Game1.eventUp || who.health <= 0)
            {
                this.ResetAfterExternalTransition("强制流程切换地图");
                return;
            }

            if (!FlightWarpPatches.TryCompleteOrdinaryWarpTransition(newLocation))
            {
                this.ResetAfterExternalTransition("未取得普通步行出口许可的换图");
                return;
            }

            if (!IsMainMap(newLocation))
            {
                this.RestorePlayerState(who, restoreMovement: false);
                this.ClearState();
                this.monitor.Log(
                    $"[飞行] 从普通出口进入不可飞区域 {newLocation.NameOrUniqueName},已自动结束飞行",
                    LogLevel.Info);
                return;
            }

            this.ClearActiveVillagerShocks();
            this.originLocation = newLocation;
            this.takeoffTile = who.TilePoint;
            this.jetTrail.Reset();
            if (this.flightMount != null)
            {
                oldLocation?.characters.Remove(this.flightMount);
                newLocation.characters.Remove(this.flightMount);
            }
            who.ignoreCollisions = true;
            who.yJumpVelocity = 0f;
            if (!this.TryRestoreTemporaryMountAfterWarp(who, newLocation))
            {
                this.RestorePlayerState(who, restoreMovement: false);
                this.ClearState();
                this.monitor.Log("[飞行坐骑] 换图后骑乘关系丢失,已安全结束飞行", LogLevel.Warn);
                return;
            }
            this.ApplyFlightVisual(who);
            this.monitor.Log(
                $"[飞行] 经普通出口从 {oldLocation?.NameOrUniqueName ?? "未知地图"} 飞入 {newLocation.NameOrUniqueName},继续巡航",
                LogLevel.Info);
        }

        public void ForceLandImmediately(string reason)
        {
            if (this.state == FlightState.Grounded)
                return;

            Farmer? who = this.flyer;
            if (who != null && who.currentLocation != null && ReferenceEquals(who.currentLocation, this.originLocation))
            {
                Point target = FlightLandingLocator.FindNearest(who.currentLocation, who, who.TilePoint)
                    ?? this.takeoffTile;
                who.setTileLocation(new Vector2(target.X, target.Y));
                who.Halt();
            }

            this.RestorePlayerState(who, restoreMovement: false);
            this.ClearState();
            this.monitor.Log($"[飞行] 立即结束:{reason}", LogLevel.Trace);
        }

        public void ResetAfterExternalTransition(string reason)
        {
            if (this.state == FlightState.Grounded)
                return;

            this.RestorePlayerState(this.flyer, restoreMovement: false);
            this.ClearState();
            this.monitor.Log($"[飞行] 外部状态变化后复位:{reason}", LogLevel.Trace);
        }

        /// <summary>原版流程直接要求 Horse.dismount 时,改走本控制器的无残留清理路径。</summary>
        internal bool HandleVanillaDismountRequest(Horse mount, bool fromDemolish)
        {
            if (this.state == FlightState.Grounded || !ReferenceEquals(this.flightMount, mount))
                return false;

            if (FlightWarpPatches.IsOrdinaryWarpTransitionInProgress())
            {
                // 普通出口换图可能要求原版 Horse 临时卸载;跳过该卸载,由 OnWarped 在目标地图重绑。
                mount.mounting.Value = false;
                mount.dismounting.Value = false;
                mount.rider = this.flyer;
                return true;
            }

            this.ForceLandImmediately(fromDemolish
                ? "原版拆除流程请求解除豆包坐骑"
                : "原版流程请求解除豆包坐骑");
            return true;
        }

        private static bool IsMainMap(GameLocation location)
        {
            return location.IsOutdoors
                && location is not MineShaft
                && location is not VolcanoDungeon;
        }

        private void CompleteLanding(Farmer who, GameLocation location)
        {
            Point finalTile = FlightLandingLocator.FindNearest(location, who, this.landingTile)
                ?? this.takeoffTile;
            who.setTileLocation(new Vector2(finalTile.X, finalTile.Y));
            who.Halt();
            this.RestorePlayerState(who, restoreMovement: true);
            this.ClearState();
            this.monitor.Log($"[飞行] 降落完成 tile={finalTile}", LogLevel.Info);
        }

        private void RestorePlayerState(Farmer? who, bool restoreMovement)
        {
            this.DetachTemporaryMount(who);
            if (who == null)
                return;

            who.ignoreCollisions = this.savedIgnoreCollisions;
            who.yJumpOffset = this.savedJumpOffset;
            who.yJumpVelocity = this.savedJumpVelocity;
            who.rotation = this.savedRotation;
            who.FarmerSprite.PauseForSingleAnimation = false;
            who.faceDirection(this.savedFacingDirection);
            who.FarmerSprite.StopAnimation();
            who.FarmerSprite.PauseForSingleAnimation = this.savedPauseForSingleAnimation;
            who.speed = this.savedSpeed;
            who.running = this.savedRunning;
            who.xOffset = this.savedXOffset;
            who.yOffset = this.savedYOffset;
            who.isAnimatingMount = this.savedIsAnimatingMount;
            if (restoreMovement && this.savedCanMove && !Game1.newDay
                && !Game1.eventUp && Game1.activeClickableMenu == null)
            {
                who.forceCanMove();
            }
            else if (!this.savedCanMove)
            {
                who.CanMove = false;
            }
        }

        private void ClearState()
        {
            this.DetachTemporaryMount(this.flyer);
            this.state = FlightState.Grounded;
            this.flyer = null;
            this.originLocation = null;
            this.altitude = 0f;
            this.transitionElapsedMs = 0f;
            this.jetTrail.Reset();
            this.ClearActiveVillagerShocks();
            this.shockedVillagers.Clear();
            FlightWarpPatches.ClearOrdinaryExitPermit();
        }

        private void ApplyFlightVisual(Farmer who)
        {
            // Farmer.draw() 先通过 getLocalPosition() 应用一次 yJumpOffset,
            // 随后又在交给 FarmerRenderer 前应用一次;字段值因此只取目标可视高度的一半。
            who.yJumpOffset = -(int)Math.Round(this.altitude / FarmerJumpVisualScale);
            who.yJumpVelocity = 0f;
            who.rotation = this.savedRotation;
            who.FarmerSprite.PauseForSingleAnimation = false;
            who.showRiding();
            this.SyncTemporaryMount(who);
        }

        private bool TryAttachTemporaryMount(Farmer who, GameLocation location, out string feedback)
        {
            feedback = "";
            Vector2 originalPosition = who.Position;
            try
            {
                var mount = new Horse(Guid.NewGuid(), who.TilePoint.X, who.TilePoint.Y);
                this.flightMount = mount;
                DoubaoMountPatches.MarkTemporaryMount(mount, who);
                mount.currentLocation = location;
                mount.Position = originalPosition;
                mount.FacingDirection = who.FacingDirection;
                mount.farmerPassesThrough = true;
                mount.mounting.Value = false;
                mount.dismounting.Value = false;
                mount.rider = who;

                // 原版 setter 建立真正的骑乘关系。setter 会按马碰撞盒挪一次玩家,随后还原原坐标。
                who.mount = mount;
                who.Position = originalPosition;
                mount.SyncPositionToRider();
                who.showRiding();
                return true;
            }
            catch (Exception ex)
            {
                this.DetachTemporaryMount(who);
                who.Position = originalPosition;
                feedback = "豆包这次没变稳,先不起飞。";
                this.monitor.Log($"[飞行坐骑] 建立原版骑乘关系失败:{ex}", LogLevel.Error);
                return false;
            }
        }

        private bool SyncTemporaryMount(Farmer who)
        {
            Horse? mount = this.flightMount;
            if (mount == null || !ReferenceEquals(who.mount, mount)
                || !DoubaoMountPatches.IsTemporaryMount(mount))
            {
                return false;
            }

            mount.rider = who;
            mount.currentLocation = who.currentLocation;
            mount.Position = who.Position;
            mount.FacingDirection = who.FacingDirection;
            mount.yJumpOffset = who.yJumpOffset;
            mount.mounting.Value = false;
            mount.dismounting.Value = false;
            if (mount.Sprite != null)
                mount.Sprite.currentAnimationIndex = 0;
            return true;
        }

        private bool TryRestoreTemporaryMountAfterWarp(Farmer who, GameLocation location)
        {
            Horse? mount = this.flightMount;
            if (mount == null || !DoubaoMountPatches.IsTemporaryMount(mount))
                return false;

            Vector2 playerPosition = who.Position;
            try
            {
                mount.currentLocation = location;
                mount.rider = who;
                mount.mounting.Value = false;
                mount.dismounting.Value = false;
                if (!ReferenceEquals(who.mount, mount))
                    who.mount = mount;

                // Farmer.mount setter 会按原版马碰撞盒挪一次位置;跨图出口坐标必须保持不变。
                who.Position = playerPosition;
                mount.Position = playerPosition;
                return this.SyncTemporaryMount(who);
            }
            catch (Exception ex)
            {
                who.Position = playerPosition;
                this.monitor.Log($"[飞行坐骑] 换图后恢复骑乘关系失败:{ex}", LogLevel.Warn);
                return false;
            }
        }

        private void DetachTemporaryMount(Farmer? who)
        {
            Horse? mount = this.flightMount;
            if (mount == null && DoubaoMountPatches.IsTemporaryMount(who?.mount))
                mount = who!.mount;
            if (mount == null)
                return;

            Vector2 playerPosition = who?.Position ?? mount.Position;
            mount.currentLocation?.characters.Remove(mount);
            this.originLocation?.characters.Remove(mount);
            who?.currentLocation?.characters.Remove(mount);

            if (who != null && ReferenceEquals(who.mount, mount))
                who.mount = null;
            mount.rider = null;
            mount.mounting.Value = false;
            mount.dismounting.Value = false;
            if (who != null)
                who.Position = playerPosition;

            this.flightMount = null;
        }

        private void ClampPlayerToMap(Farmer who, GameLocation location)
        {
            var back = location.Map?.GetLayer("Back");
            if (back == null || back.LayerWidth <= 0 || back.LayerHeight <= 0)
                return;

            Rectangle box = who.GetBoundingBox();
            int mapWidth = back.LayerWidth * 64;
            int mapHeight = back.LayerHeight * 64;
            float dx = box.Left < 0
                ? -box.Left
                : box.Right > mapWidth ? mapWidth - box.Right : 0f;
            float dy = box.Top < 0
                ? -box.Top
                : box.Bottom > mapHeight ? mapHeight - box.Bottom : 0f;
            if (dx != 0f || dy != 0f)
                who.Position += new Vector2(dx, dy);
        }

        private void UpdateVillagerReactions(Farmer who, GameLocation location, float elapsedMs)
        {
            this.UpdateActiveVillagerShocks(location, elapsedMs);
            if (this.altitude < 48f || ++this.villagerReactionTick % VillagerReactionIntervalTicks != 0)
                return;

            Vector2 playerPosition = who.getStandingPosition();
            foreach (NPC npc in location.characters)
            {
                if (!npc.IsVillager || npc.IsInvisible)
                    continue;

                string key = $"{location.NameOrUniqueName}\u001f{npc.Name}";
                if (this.shockedVillagers.Contains(key))
                    continue;

                if (Vector2.DistanceSquared(playerPosition, npc.getStandingPosition())
                    > VillagerSightRadiusPixels * VillagerSightRadiusPixels)
                {
                    continue;
                }

                // 先朝向飞行玩家并暂停寻路/当前精灵动画,再播放明显的加强震动。
                // movementPause 是原版可恢复的短暂停顿,不会清空 NPC 的日程控制器。
                npc.faceGeneralDirection(playerPosition, yBias: 0, opposite: false, useTileCalculations: true);
                npc.movementPause = Math.Max(npc.movementPause, VillagerShockDurationMs);
                npc.Sprite.StopAnimation();
                npc.doEmote(Character.exclamationEmote, playSound: true, nextEventCommand: false);
                npc.shake(VillagerShockDurationMs);
                this.activeVillagerShocks[npc] = new VillagerShockEffect();
                this.shockedVillagers.Add(key);
                this.monitor.Log(
                    $"[飞行] {npc.Name} 看见玩家飞行并停步、感叹、加强震动",
                    LogLevel.Trace);
            }
        }

        private void UpdateActiveVillagerShocks(GameLocation location, float elapsedMs)
        {
            if (this.activeVillagerShocks.Count == 0)
                return;

            List<NPC>? completed = null;
            foreach ((NPC npc, VillagerShockEffect effect) in this.activeVillagerShocks)
            {
                // 先撤掉上一帧由本控制器施加的纯绘制偏移,保留 NPC 或其他 Mod 的基础 drawOffset。
                npc.drawOffset -= effect.AppliedDrawOffset;
                effect.AppliedDrawOffset = Vector2.Zero;
                effect.ElapsedMs += elapsedMs;

                if (!location.characters.Contains(npc) || effect.ElapsedMs >= VillagerShockDurationMs)
                {
                    completed ??= new List<NPC>();
                    completed.Add(npc);
                    continue;
                }

                float horizontal = MathF.Cos(effect.ElapsedMs * 0.09f)
                    * VillagerShockHorizontalAmplitude;
                float vertical = MathF.Sin(effect.ElapsedMs * 0.13f)
                    * VillagerShockVerticalAmplitude;
                effect.AppliedDrawOffset = new Vector2(horizontal, vertical);
                npc.drawOffset += effect.AppliedDrawOffset;

                int remainingMs = (int)Math.Ceiling(VillagerShockDurationMs - effect.ElapsedMs);
                npc.movementPause = Math.Max(npc.movementPause, remainingMs);
                npc.Sprite.StopAnimation();
            }

            if (completed == null)
                return;

            foreach (NPC npc in completed)
                this.activeVillagerShocks.Remove(npc);
        }

        private void ClearActiveVillagerShocks()
        {
            foreach ((NPC npc, VillagerShockEffect effect) in this.activeVillagerShocks)
                npc.drawOffset -= effect.AppliedDrawOffset;

            this.activeVillagerShocks.Clear();
        }

        private static float EaseOutCubic(float value)
        {
            float inverse = 1f - value;
            return 1f - inverse * inverse * inverse;
        }

        private static float SmoothStep(float value)
        {
            return value * value * (3f - 2f * value);
        }

        private sealed class VillagerShockEffect
        {
            public float ElapsedMs;
            public Vector2 AppliedDrawOffset;
        }

    }
}

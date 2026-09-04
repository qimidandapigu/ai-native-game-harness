using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace StardewAgentMod.Game.Companion
{
    /// <summary>
    /// 凌晨救助:先把农夫送回自己的床,等传送完全结束后再走原版睡眠入口。
    /// 传送与过夜都使用淡出流程,不能在同一帧同时启动,否则会留下移动锁或未完成的传送状态。
    /// </summary>
    internal sealed class RescueAssist
    {
        private const int WarpTimeoutTicks = 300;

        private readonly IMonitor monitor;
        private RescueState state;
        private string? expectedHomeName;
        private Point expectedBedSpot;
        private int elapsedTicks;
        private int sleepDelayTicks;
        private bool wasMovableBeforeRescue;
        private Action? onSleepStarted;
        private Action? onFailed;

        public RescueAssist(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        public bool IsActive => this.state != RescueState.Idle;

        /// <summary>
        /// 开始救援。这里只发起传送;真正睡觉会在 Warped 事件后的下一游戏帧执行。
        /// 返回 false 表示救援没有启动,调用方应立即返还已经预扣的体力。
        /// </summary>
        public bool TryBegin(Action onSleepStarted, Action onFailed)
        {
            if (this.IsActive)
            {
                this.monitor.Log("[体力] 凌晨救助已在进行中,忽略重复请求", LogLevel.Trace);
                return false;
            }

            Farmer? who = Game1.player;
            if (who == null || Game1.newDay || Game1.eventUp
                || Game1.activeClickableMenu != null || Game1.currentMinigame != null
                || !who.CanMove)
            {
                this.monitor.Log("[体力] 当前游戏状态不允许启动凌晨救助", LogLevel.Warn);
                return false;
            }

            var home = Utility.getHomeOfFarmer(who);
            if (home == null)
            {
                this.monitor.Log("[体力] 凌晨救助失败:找不到玩家住宅", LogLevel.Warn);
                return false;
            }

            this.expectedHomeName = home.NameOrUniqueName;
            this.expectedBedSpot = home.GetPlayerBedSpot();
            this.elapsedTicks = 0;
            this.wasMovableBeforeRescue = who.CanMove;
            this.onSleepStarted = onSleepStarted;
            this.onFailed = onFailed;

            try
            {
                if (string.Equals(
                    who.currentLocation?.NameOrUniqueName,
                    this.expectedHomeName,
                    StringComparison.Ordinal))
                {
                    who.setTileLocation(new Vector2(this.expectedBedSpot.X, this.expectedBedSpot.Y));
                    who.Halt();
                    this.QueueSleep();
                    this.monitor.Log("[体力] 凌晨救助:玩家已在家,移动到床边后准备睡觉", LogLevel.Info);
                }
                else
                {
                    this.state = RescueState.Warping;
                    Game1.warpFarmer(
                        this.expectedHomeName,
                        this.expectedBedSpot.X,
                        this.expectedBedSpot.Y,
                        false);
                    this.monitor.Log("[体力] 凌晨救助:已发起回家传送", LogLevel.Info);
                }

                return true;
            }
            catch (Exception ex)
            {
                bool restoreMovement = this.wasMovableBeforeRescue;
                this.ResetState();
                this.RestorePlayerControlIfSafe(who, restoreMovement);
                this.monitor.Log($"[体力] 凌晨救助启动失败:{ex.Message}", LogLevel.Warn);
                return false;
            }
        }

        public void OnWarped(object? sender, WarpedEventArgs e)
        {
            if (this.state != RescueState.Warping || !e.IsLocalPlayer || e.NewLocation == null)
                return;

            if (!string.Equals(e.NewLocation.NameOrUniqueName, this.expectedHomeName, StringComparison.Ordinal))
            {
                this.Fail("传送被改到了其他地点");
                return;
            }

            this.QueueSleep();
            this.monitor.Log("[体力] 凌晨救助:回家传送完成,等待下一帧进入原版睡眠", LogLevel.Info);
        }

        public void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (!Context.IsWorldReady || this.state == RescueState.Idle || this.state == RescueState.SleepStarted)
                return;

            if (this.state == RescueState.Warping)
            {
                this.elapsedTicks++;
                if (this.elapsedTicks > WarpTimeoutTicks)
                    this.Fail("等待回家传送超时");
                return;
            }

            if (this.state == RescueState.SleepQueued && --this.sleepDelayTicks <= 0)
                this.StartOriginalSleepFlow();
        }

        public void OnDayStarted(object? sender, DayStartedEventArgs e)
        {
            if (this.state == RescueState.SleepStarted)
                this.monitor.Log("[体力] 凌晨救助:原版过夜流程完成,玩家控制状态由新一天正常恢复", LogLevel.Info);

            this.ResetState();
        }

        public void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
        {
            this.ResetState();
        }

        private void QueueSleep()
        {
            this.state = RescueState.SleepQueued;
            this.elapsedTicks = 0;
            // Warped 可能发生在同一轮游戏更新中,保留一整帧让原版传送收尾。
            this.sleepDelayTicks = 2;
        }

        private void StartOriginalSleepFlow()
        {
            Farmer? who = Game1.player;
            var home = who == null ? null : Utility.getHomeOfFarmer(who);
            if (who == null || home == null
                || !string.Equals(home.NameOrUniqueName, this.expectedHomeName, StringComparison.Ordinal)
                || !string.Equals(who.currentLocation?.NameOrUniqueName, this.expectedHomeName, StringComparison.Ordinal))
            {
                this.Fail("到达床边前玩家或住宅状态发生变化");
                return;
            }

            try
            {
                who.setTileLocation(new Vector2(this.expectedBedSpot.X, this.expectedBedSpot.Y));
                who.isInBed.Value = true;
                who.sleptInTemporaryBed.Value = false;
                who.Halt();

                // 走原版公开的对话动作入口,由 startSleep/doSleep 负责睡眠位置、联机确认、存档和过夜。
                if (!home.answerDialogueAction("Sleep_Yes", Array.Empty<string>()))
                {
                    who.isInBed.Value = false;
                    this.Fail("原版睡眠入口拒绝了请求");
                    return;
                }

                this.state = RescueState.SleepStarted;
                Action? completed = this.onSleepStarted;
                this.onSleepStarted = null;
                this.onFailed = null;
                completed?.Invoke();
                this.monitor.Log("[体力] 凌晨救助:已进入原版睡眠流程", LogLevel.Info);
            }
            catch (Exception ex)
            {
                if (!Game1.newDay)
                    who.isInBed.Value = false;
                this.Fail($"进入原版睡眠流程失败:{ex.Message}");
            }
        }

        private void Fail(string reason)
        {
            Farmer? who = Game1.player;
            bool restoreMovement = this.wasMovableBeforeRescue;
            Action? failed = this.onFailed;
            this.ResetState();
            this.RestorePlayerControlIfSafe(who, restoreMovement);

            try
            {
                failed?.Invoke();
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[体力] 凌晨救助失败回调异常:{ex.Message}", LogLevel.Warn);
            }

            this.monitor.Log($"[体力] 凌晨救助失败:{reason}", LogLevel.Warn);
        }

        private void RestorePlayerControlIfSafe(Farmer? who, bool restoreMovement)
        {
            if (who == null || Game1.newDay)
                return;

            who.isInBed.Value = false;
            if (restoreMovement && Game1.activeClickableMenu == null && !Game1.eventUp)
                who.forceCanMove();
        }

        private void ResetState()
        {
            this.state = RescueState.Idle;
            this.expectedHomeName = null;
            this.expectedBedSpot = Point.Zero;
            this.elapsedTicks = 0;
            this.sleepDelayTicks = 0;
            this.wasMovableBeforeRescue = false;
            this.onSleepStarted = null;
            this.onFailed = null;
        }

        private enum RescueState
        {
            Idle,
            Warping,
            SleepQueued,
            SleepStarted
        }
    }
}

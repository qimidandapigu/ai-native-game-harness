using System;
using HarmonyLib;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentMod.Game.Flight
{
    /// <summary>
    /// 飞行时只允许普通步行出口发起换图。
    /// 碰撞 Warp 与地图 Warp TouchAction 会签发短时、单次、目标绑定的许可;
    /// MagicWarp、脚本直传等一般换图请求仍会被拦截。
    /// </summary>
    internal static class FlightWarpPatches
    {
        private const long ExitPermitDurationMs = 2500;
        private const long WarpTransitionTimeoutMs = 30000;

        private static FlightController? controller;
        private static long exitPermitExpiresAt;
        private static string? permittedTargetName;
        private static long ordinaryWarpExpiresAt;
        private static string? ordinaryWarpTargetName;

        public static void Apply(string harmonyId, FlightController flightController, IMonitor monitor)
        {
            controller = flightController;
            try
            {
                var harmony = new Harmony(harmonyId + ".Flight");
                var warpCollision = AccessTools.Method(
                    typeof(GameLocation),
                    nameof(GameLocation.isCollidingWithWarp),
                    new[] { typeof(Rectangle), typeof(Character) });
                var touchAction = AccessTools.Method(
                    typeof(GameLocation),
                    nameof(GameLocation.performTouchAction),
                    new[] { typeof(string[]), typeof(Vector2) });
                var requestedWarp = AccessTools.Method(
                    typeof(Game1),
                    nameof(Game1.warpFarmer),
                    new[] { typeof(LocationRequest), typeof(int), typeof(int), typeof(int) });

                if (warpCollision == null || touchAction == null || requestedWarp == null)
                    throw new MissingMethodException("Stardew 1.6 飞行换图拦截点不存在");

                harmony.Patch(
                    warpCollision,
                    postfix: new HarmonyMethod(typeof(FlightWarpPatches), nameof(AfterWarpCollision)));
                harmony.Patch(
                    touchAction,
                    prefix: new HarmonyMethod(typeof(FlightWarpPatches), nameof(BeforeTouchAction)));
                harmony.Patch(
                    requestedWarp,
                    prefix: new HarmonyMethod(typeof(FlightWarpPatches), nameof(BeforeRequestedWarp)));
                monitor.Log("[飞行] 已安装普通步行出口换图补丁", LogLevel.Trace);
            }
            catch (Exception ex)
            {
                controller = null;
                monitor.Log($"[飞行] 地图边界补丁安装失败,已禁用飞行:{ex}", LogLevel.Error);
            }
        }

        public static bool IsReady => controller != null;

        public static void ClearOrdinaryExitPermit()
        {
            ClearPendingExitPermit();
            ClearOrdinaryWarpTransition();
        }

        /// <summary>
        /// 普通出口的 warpFarmer 请求已经放行、但 SMAPI Player.Warped 尚未到达。
        /// 这段窗口内 Game1.player.currentLocation 可能已指向新地图,UpdateTicked 不应抢先复位飞行。
        /// </summary>
        public static bool IsOrdinaryWarpTransitionInProgress(GameLocation? destination = null)
        {
            if (ordinaryWarpExpiresAt < Environment.TickCount64
                || string.IsNullOrWhiteSpace(ordinaryWarpTargetName))
            {
                ClearOrdinaryWarpTransition();
                return false;
            }

            return destination == null || IsTargetLocation(destination, ordinaryWarpTargetName);
        }

        /// <summary>由 Player.Warped 消费目标绑定的普通出口换图状态。</summary>
        public static bool TryCompleteOrdinaryWarpTransition(GameLocation destination)
        {
            bool valid = IsOrdinaryWarpTransitionInProgress(destination);
            ClearOrdinaryWarpTransition();
            return valid;
        }

        private static void ClearPendingExitPermit()
        {
            exitPermitExpiresAt = 0;
            permittedTargetName = null;
        }

        private static void ClearOrdinaryWarpTransition()
        {
            ordinaryWarpExpiresAt = 0;
            ordinaryWarpTargetName = null;
        }

        private static void AfterWarpCollision(Character character, ref Warp? __result)
        {
            if (__result == null || controller?.ShouldBlockMapTransition(character) != true)
                return;

            PermitOrdinaryExit(__result.TargetName);
        }

        private static bool BeforeTouchAction(
            GameLocation __instance,
            string[] action,
            Vector2 playerStandingPosition)
        {
            if (controller?.ShouldBlockMapTransition() != true)
                return true;

            string actionType = GetActionType(action);
            if (actionType.Equals("Warp", StringComparison.OrdinalIgnoreCase))
            {
                if (IsDeclaredWalkingWarp(__instance, action, playerStandingPosition))
                {
                    PermitOrdinaryExit(action[1]);
                    return true;
                }

                controller.NotifyWarpBlocked();
                return false;
            }

            // Door/ConditionalDoor 只负责普通门禁检查,真正的门 Warp 仍会经过
            // isCollidingWithWarp 并在那里取得目标绑定许可。
            if (actionType.Equals("Door", StringComparison.OrdinalIgnoreCase)
                || actionType.Equals("ConditionalDoor", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (!actionType.Equals("MagicWarp", StringComparison.OrdinalIgnoreCase))
                return true;

            controller.NotifyWarpBlocked();
            return false;
        }

        private static bool BeforeRequestedWarp(LocationRequest locationRequest)
        {
            if (controller?.ShouldBlockMapTransition() != true)
                return true;

            if (TryConsumeOrdinaryExitPermit(locationRequest.Name))
                return true;

            controller.NotifyWarpBlocked();
            return false;
        }

        private static string GetActionType(string[]? action)
        {
            return action?.Length > 0 ? action[0] : "";
        }

        private static bool IsDeclaredWalkingWarp(
            GameLocation location,
            string[] action,
            Vector2 playerStandingPosition)
        {
            if (action.Length < 2 || string.IsNullOrWhiteSpace(action[1])
                || !ReferenceEquals(Game1.player?.currentLocation, location))
            {
                return false;
            }

            int tileX = (int)Math.Floor(playerStandingPosition.X / 64f);
            int tileY = (int)Math.Floor(playerStandingPosition.Y / 64f);
            string declaredAction = location.doesTileHavePropertyNoNull(
                tileX,
                tileY,
                "TouchAction",
                "Back");
            string[] declaredTokens = ArgUtility.SplitBySpace(declaredAction);
            return declaredTokens.Length > 1
                && GetActionType(declaredTokens).Equals("Warp", StringComparison.OrdinalIgnoreCase)
                && string.Equals(declaredTokens[1], action[1], StringComparison.OrdinalIgnoreCase);
        }

        private static void PermitOrdinaryExit(string targetName)
        {
            permittedTargetName = targetName;
            exitPermitExpiresAt = Environment.TickCount64 + ExitPermitDurationMs;
        }

        private static bool TryConsumeOrdinaryExitPermit(string targetName)
        {
            bool valid = exitPermitExpiresAt >= Environment.TickCount64
                && !string.IsNullOrWhiteSpace(permittedTargetName)
                && string.Equals(permittedTargetName, targetName, StringComparison.OrdinalIgnoreCase);

            ClearPendingExitPermit();
            if (valid)
            {
                ordinaryWarpTargetName = targetName;
                ordinaryWarpExpiresAt = Environment.TickCount64 + WarpTransitionTimeoutMs;
            }
            return valid;
        }

        private static bool IsTargetLocation(GameLocation location, string targetName)
        {
            return string.Equals(location.Name, targetName, StringComparison.OrdinalIgnoreCase)
                || string.Equals(location.NameOrUniqueName, targetName, StringComparison.OrdinalIgnoreCase);
        }
    }
}

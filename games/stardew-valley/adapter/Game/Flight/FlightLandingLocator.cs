using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;

namespace StardewAgentMod.Game.Flight
{
    /// <summary>按直线距离寻找最近、可容纳玩家碰撞箱且不是地图出口的落脚格。</summary>
    internal static class FlightLandingLocator
    {
        public static Point? FindNearest(GameLocation location, Farmer who, Point start)
        {
            var back = location.Map?.GetLayer("Back");
            if (back == null || back.LayerWidth <= 0 || back.LayerHeight <= 0)
                return null;

            int width = back.LayerWidth;
            int height = back.LayerHeight;
            start.X = Math.Clamp(start.X, 0, width - 1);
            start.Y = Math.Clamp(start.Y, 0, height - 1);

            var candidates = new List<Point>(width * height);
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                    candidates.Add(new Point(x, y));
            }

            candidates.Sort((left, right) =>
            {
                long leftX = left.X - start.X;
                long leftY = left.Y - start.Y;
                long rightX = right.X - start.X;
                long rightY = right.Y - start.Y;
                long leftDistance = leftX * leftX + leftY * leftY;
                long rightDistance = rightX * rightX + rightY * rightY;
                int distanceCompare = leftDistance.CompareTo(rightDistance);
                if (distanceCompare != 0)
                    return distanceCompare;

                int yCompare = left.Y.CompareTo(right.Y);
                return yCompare != 0 ? yCompare : left.X.CompareTo(right.X);
            });

            foreach (Point tile in candidates)
            {
                if (IsLandable(location, who, tile))
                    return tile;
            }

            return null;
        }

        private static bool IsLandable(GameLocation location, Farmer who, Point tile)
        {
            foreach (Warp warp in location.warps)
            {
                if (warp.X == tile.X && warp.Y == tile.Y)
                    return false;
            }

            string touchAction = location.doesTileHavePropertyNoNull(tile.X, tile.Y, "TouchAction", "Back");
            if (IsWarpTouchAction(touchAction))
                return false;

            Rectangle currentBox = who.GetBoundingBox();
            int positionX = (int)Math.Floor(who.Position.X);
            int positionY = (int)Math.Floor(who.Position.Y);
            var candidateBox = new Rectangle(
                tile.X * 64 + currentBox.X - positionX,
                tile.Y * 64 + currentBox.Y - positionY,
                currentBox.Width,
                currentBox.Height);

            return !location.isCollidingPosition(
                candidateBox,
                Game1.viewport,
                isFarmer: true,
                damagesFarmer: 0,
                glider: false,
                character: who,
                pathfinding: false,
                projectile: false,
                ignoreCharacterRequirement: false,
                skipCollisionEffects: true);
        }

        private static bool IsWarpTouchAction(string? action)
        {
            if (string.IsNullOrWhiteSpace(action))
                return false;

            string first = action.TrimStart();
            return first.Contains("Warp", StringComparison.OrdinalIgnoreCase)
                || first.StartsWith("Door ", StringComparison.OrdinalIgnoreCase)
                || first.Equals("Door", StringComparison.OrdinalIgnoreCase);
        }
    }
}

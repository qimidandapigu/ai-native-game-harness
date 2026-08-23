using System;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace DoubaoAI.ONI.GameState
{
    internal static class GameSnapshotCollector
    {
        internal static GameSnapshot Collect()
        {
            var sb = new StringBuilder(1024);
            Vector3 mouseScreen = KInputManager.GetMousePos();
            Vector3 mouseWorld = GetMouseWorld(mouseScreen);
            int mouseCell = Grid.PosToCell(mouseWorld);

            AppendClock(sb);
            AppendWorld(sb);
            AppendPopulationAndSpeed(sb);
            AppendCamera(sb);
            AppendMouseCell(sb, mouseScreen, mouseWorld, mouseCell);
            AppendSelection(sb);

            return new GameSnapshot { PromptContext = sb.ToString() };
        }

        private static Vector3 GetMouseWorld(Vector3 mouseScreen)
        {
            if (PlayerController.Instance != null)
                return PlayerController.GetCursorPos(mouseScreen);
            if (Camera.main != null)
                return Camera.main.ScreenToWorldPoint(mouseScreen);
            return Vector3.zero;
        }

        private static void AppendClock(StringBuilder sb)
        {
            if (GameClock.Instance == null) return;
            sb.AppendLine("周期: " + GameClock.Instance.GetCycle().ToString(CultureInfo.InvariantCulture));
            sb.AppendLine("周期进度: " + (GameClock.Instance.GetCurrentCycleAsPercentage() * 100f).ToString("0.0", CultureInfo.InvariantCulture) + "%");
            sb.AppendLine("是否夜间: " + GameClock.Instance.IsNighttime());
        }

        private static void AppendWorld(StringBuilder sb)
        {
            if (ClusterManager.Instance == null) return;
            int worldId = ClusterManager.Instance.activeWorldId;
            WorldContainer world = ClusterManager.Instance.GetWorld(worldId);
            sb.AppendLine("当前世界ID: " + worldId);
            if (world == null) return;
            string displayName = string.IsNullOrWhiteSpace(world.overrideName) ? world.worldName : world.overrideName;
            sb.AppendLine("当前世界: " + displayName);
            sb.AppendLine("世界类型: " + world.worldType);
            sb.AppendLine("世界尺寸: " + world.Width + "x" + world.Height);
        }

        private static void AppendPopulationAndSpeed(StringBuilder sb)
        {
            sb.AppendLine("存活复制人: " + Components.LiveMinionIdentities.Count);
            if (SpeedControlScreen.Instance == null) return;
            sb.AppendLine("游戏暂停: " + SpeedControlScreen.Instance.IsPaused);
            sb.AppendLine("游戏速度档位: " + SpeedControlScreen.Instance.GetSpeed());
        }

        private static void AppendCamera(StringBuilder sb)
        {
            CameraController controller = CameraController.Instance;
            if (controller == null || controller.baseCamera == null) return;
            Vector3 p = controller.baseCamera.transform.position;
            sb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "镜头: 中心({0:0.00}, {1:0.00}) 正交尺寸{2:0.00}", p.x, p.y, controller.OrthographicSize));
        }

        private static void AppendMouseCell(StringBuilder sb, Vector3 screen, Vector3 world, int cell)
        {
            sb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "鼠标屏幕坐标: ({0:0}, {1:0}) / 分辨率 {2}x{3}", screen.x, screen.y, Screen.width, Screen.height));
            sb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "鼠标世界坐标: ({0:0.00}, {1:0.00})", world.x, world.y));

            if (!Grid.IsValidCell(cell))
            {
                sb.AppendLine("鼠标格子: 无效或世界外");
                return;
            }

            int x;
            int y;
            Grid.CellToXY(cell, out x, out y);
            Element element = Grid.Element[cell];
            string elementId = element == null ? "未知" : element.id.ToString();
            string state = element == null ? "未知" : element.state.ToString();
            float mass = Grid.Mass[cell];
            float celsius = Grid.Temperature[cell] - 273.15f;
            sb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "鼠标格子: cell={0}, x={1}, y={2}, world={3}", cell, x, y, Grid.WorldIdx[cell]));
            sb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "格子环境: 元素={0}, 状态={1}, 质量={2:0.###}kg, 温度={3:0.0}°C, 病菌索引={4}, 病菌数={5}",
                elementId, state, mass, celsius, Grid.DiseaseIdx[cell], Grid.DiseaseCount[cell]));
        }

        private static void AppendSelection(StringBuilder sb)
        {
            KSelectable selected = SelectTool.Instance == null ? null : SelectTool.Instance.selected;
            if (selected == null)
            {
                sb.AppendLine("当前选中对象: 无");
                return;
            }

            GameObject go = selected.gameObject;
            KPrefabID prefab = go.GetComponent<KPrefabID>();
            string prefabId = prefab == null ? go.name : prefab.PrefabTag.ToString();
            string properName;
            try { properName = go.GetProperName(); }
            catch { properName = go.name; }
            int cell = Grid.PosToCell(go);
            Vector3 p = go.transform.position;
            sb.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "当前选中对象: {0}, prefab={1}, cell={2}, 位置=({3:0.00}, {4:0.00})",
                properName, prefabId, cell, p.x, p.y));
        }
    }
}

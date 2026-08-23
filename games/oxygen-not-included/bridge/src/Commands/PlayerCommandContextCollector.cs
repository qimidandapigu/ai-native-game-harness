using System;
using UnityEngine;

namespace DoubaoAI.ONI.Commands
{
    internal static class PlayerCommandContextCollector
    {
        internal static PlayerCommandSnapshot Collect()
        {
            var result = new PlayerCommandSnapshot();
            Vector3 screen = KInputManager.GetMousePos();
            Vector3 world = PlayerController.Instance != null
                ? PlayerController.GetCursorPos(screen)
                : Camera.main == null ? Vector3.zero : Camera.main.ScreenToWorldPoint(screen);
            result.MouseCell = Grid.PosToCell(world);
            if (Grid.IsValidCell(result.MouseCell))
            {
                Element element = Grid.Element[result.MouseCell];
                result.MouseElement = element == null ? "未知" : element.id.ToString();
                result.MouseCellSolid = Grid.IsSolidCell(result.MouseCell);
            }

            MinionIdentity selected = null;
            if (SelectTool.Instance != null && SelectTool.Instance.selected != null)
                selected = SelectTool.Instance.selected.gameObject.GetComponent<MinionIdentity>();
            result.SelectedActorId = GetId(selected);

            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                int id = GetId(minion);
                int cell = Grid.PosToCell(minion.gameObject);
                Navigator navigator = minion.GetComponent<Navigator>();
                bool canReachMouse = Grid.IsValidCell(result.MouseCell) &&
                                     navigator != null &&
                                     navigator.GetNavigationCost(result.MouseCell) >= 0;
                result.Actors.Add(new PlayerCommandActor
                {
                    Id = id,
                    Name = SafeName(minion),
                    Cell = cell,
                    Selected = id >= 0 && id == result.SelectedActorId,
                    CanReachMouse = canReachMouse
                });
            }
            return result;
        }

        internal static int GetId(MinionIdentity minion)
        {
            if (minion == null) return -1;
            KPrefabID prefab = minion.GetComponent<KPrefabID>();
            return prefab == null ? -1 : prefab.InstanceID;
        }

        private static string SafeName(MinionIdentity minion)
        {
            try { return (minion.GetProperName() ?? "未知").Replace("\r", " ").Replace("\n", " "); }
            catch { return minion == null ? "未知" : minion.name; }
        }
    }
}

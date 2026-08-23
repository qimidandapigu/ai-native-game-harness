using System.Collections.Generic;
using Klei.AI;
using UnityEngine;

namespace DoubaoAI.ONI.GameState
{
    internal sealed class PlayerDangerEvent
    {
        internal string Signature;
        internal string Prompt;
    }

    internal static class PlayerDangerDetector
    {
        internal static PlayerDangerEvent Detect()
        {
            try { return DetectCore(); }
            catch { return null; }
        }

        private static PlayerDangerEvent DetectCore()
        {
            var signatures = new List<string>();
            var descriptions = new List<string>();
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                string name = minion.GetProperName();
                KPrefabID prefab = minion.GetComponent<KPrefabID>();
                int id = prefab == null ? -1 : prefab.InstanceID;
                int cell = Grid.PosToCell(minion.gameObject);
                bool deepWater = IsDeepLiquidCell(cell);

                AmountInstance breath = Db.Get().Amounts.Breath.Lookup(minion.gameObject);
                float breathPercent = breath != null && breath.GetMax() > 0f ? Mathf.Clamp01(breath.value / breath.GetMax()) : 1f;
                SuffocationMonitor.Instance suffocation = minion.GetSMI<SuffocationMonitor.Instance>();
                bool losingBreath = suffocation != null && suffocation.IsBreathDepletingSignificantly();

                Health health = minion.GetComponent<Health>();
                float healthPercent = health != null && health.maxHitPoints > 0f ? Mathf.Clamp01(health.percent()) : 1f;

                TemperatureMonitor.Instance temperature = minion.GetSMI<TemperatureMonitor.Instance>();
                bool temperatureDanger = temperature != null && (temperature.IsHypothermic() || temperature.IsHyperthermic());

                if (deepWater || (breathPercent < 0.70f && losingBreath))
                {
                    signatures.Add(id + ":breath");
                    descriptions.Add(name + "正在深水里或明显缺氧，剩余呼吸约" + Mathf.RoundToInt(breathPercent * 100f) + "%");
                }
                if (healthPercent < 0.35f)
                {
                    signatures.Add(id + ":health");
                    descriptions.Add(name + "生命值只剩约" + Mathf.RoundToInt(healthPercent * 100f) + "%");
                }
                if (temperatureDanger)
                {
                    signatures.Add(id + ":temperature");
                    descriptions.Add(name + "体温处于危险状态");
                }
            }
            if (descriptions.Count == 0) return null;
            signatures.Sort();
            return new PlayerDangerEvent
            {
                Signature = string.Join("|", signatures),
                Prompt = "发生了需要立刻提醒玩家的事件：" + string.Join("；", descriptions) +
                         "。请用一句非常口语、紧迫又带点傲娇的话提醒玩家先救人，不要写列表，不要提系统检测。"
            };
        }

        private static bool IsDeepLiquidCell(int cell)
        {
            if (!Grid.IsValidCell(cell)) return false;
            int above = Grid.CellAbove(cell);
            if (!Grid.IsValidCell(above)) return false;
            Element lower = Grid.Element[cell];
            Element upper = Grid.Element[above];
            return lower != null && upper != null &&
                   lower.state == Element.State.Liquid && upper.state == Element.State.Liquid &&
                   Grid.Mass[cell] >= 500f && Grid.Mass[above] >= 500f;
        }
    }
}

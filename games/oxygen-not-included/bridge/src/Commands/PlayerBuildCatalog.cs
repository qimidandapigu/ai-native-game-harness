using System;
using System.Collections.Generic;

namespace DoubaoAI.ONI.Commands
{
    internal sealed class PlayerBuildDefinition
    {
        internal string Key;
        internal string DisplayName;
        internal string PrefabId;
    }

    internal static class PlayerBuildCatalog
    {
        private static readonly PlayerBuildDefinition[] Definitions =
        {
            Def("ladder", "梯子", LadderConfig.ID),
            Def("tile", "地砖", TileConfig.ID),
            Def("outhouse", "旱厕", OuthouseConfig.ID),
            Def("flush_toilet", "抽水马桶", FlushToiletConfig.ID),
            Def("wash_basin", "洗手盆", WashBasinConfig.ID),
            Def("bed", "小床", BedConfig.ID),
            Def("research_center", "研究站", ResearchCenterConfig.ID),
            Def("storage_locker", "储物箱", StorageLockerConfig.ID),
            Def("manual_generator", "人力发电机", ManualGeneratorConfig.ID)
        };

        internal static bool TryGet(string key, out PlayerBuildDefinition definition)
        {
            definition = null;
            if (string.IsNullOrWhiteSpace(key)) return false;
            string normalized = key.Trim().ToLowerInvariant();
            foreach (PlayerBuildDefinition candidate in Definitions)
            {
                if (!string.Equals(candidate.Key, normalized, StringComparison.OrdinalIgnoreCase)) continue;
                definition = candidate;
                return true;
            }
            return false;
        }

        private static PlayerBuildDefinition Def(string key, string name, string prefabId)
        {
            return new PlayerBuildDefinition
            {
                Key = key,
                DisplayName = name,
                PrefabId = prefabId
            };
        }
    }
}

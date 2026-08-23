using System;
using System.IO;
using Newtonsoft.Json;
using UnityEngine;

namespace DoubaoAI.ONI
{
    internal static class ConfigManager
    {
        internal static ModConfig Current { get; private set; } = new ModConfig();
        private static string _currentPath;

        internal static ModConfig Load(string contentPath)
        {
            string path = Path.Combine(contentPath, "config.json");
            _currentPath = path;
            try
            {
                if (!File.Exists(path))
                {
                    File.WriteAllText(path, JsonConvert.SerializeObject(new ModConfig(), Formatting.Indented));
                }

                Current = JsonConvert.DeserializeObject<ModConfig>(File.ReadAllText(path)) ?? new ModConfig();
                Current.Normalize();
                Debug.Log("[DoubaoAI] Bridge 配置已加载；模型、语音、截图和记忆由 AIHarness 管理。");
            }
            catch (Exception ex)
            {
                Current = new ModConfig();
                Debug.LogError("[DoubaoAI] 读取配置失败，使用默认值：" + ex.Message);
            }

            return Current;
        }

        internal static void Save()
        {
            if (string.IsNullOrWhiteSpace(_currentPath)) return;
            try
            {
                File.WriteAllText(_currentPath, JsonConvert.SerializeObject(Current, Formatting.Indented));
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[DoubaoAI] 保存精灵跟随目标失败：" + ex.Message);
            }
        }
    }
}

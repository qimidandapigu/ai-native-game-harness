using HarmonyLib;
using UnityEngine;

namespace DoubaoAI.ONI.Patches
{
    [HarmonyPatch(typeof(Game), "OnSpawn")]
    internal static class GameLifecyclePatch
    {
        private static void Postfix(Game __instance)
        {
            if (__instance == null || __instance.gameObject.GetComponent<DoubaoAIRuntime>() != null)
                return;

            __instance.gameObject.AddComponent<DoubaoAIRuntime>();
            Debug.Log("[DoubaoAI] 小精灵已进入当前游戏。按住 Q 说话，松开后发送。");
        }
    }

}

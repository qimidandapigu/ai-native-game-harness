using HarmonyLib;

namespace DoubaoAI.ONI
{
    public sealed class DoubaoAIMod : KMod.UserMod2
    {
        public override void OnLoad(Harmony harmony)
        {
            ModPaths.ContentPath = mod.ContentPath;
            ConfigManager.Load(mod.ContentPath);
            base.OnLoad(harmony);
        }
    }
}

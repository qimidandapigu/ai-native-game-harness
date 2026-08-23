namespace DoubaoAI.ONI
{
    internal sealed class ModConfig
    {
        public string HarnessBridgeRoot { get; set; } = string.Empty;
        public bool DangerAlertsEnabled { get; set; } = true;
        public int DangerAlertCooldownSeconds { get; set; } = 45;
        public int FairyFollowOffsetX { get; set; } = 28;
        public int FairyFollowOffsetY { get; set; } = 34;
        public string FairyFollowDuplicantName { get; set; } = string.Empty;

        public void Normalize()
        {
            DangerAlertCooldownSeconds = System.Math.Max(15, System.Math.Min(600, DangerAlertCooldownSeconds));
            FairyFollowOffsetX = System.Math.Max(-200, System.Math.Min(200, FairyFollowOffsetX));
            FairyFollowOffsetY = System.Math.Max(-200, System.Math.Min(200, FairyFollowOffsetY));
            if (FairyFollowDuplicantName == null) FairyFollowDuplicantName = string.Empty;
            if (HarnessBridgeRoot == null) HarnessBridgeRoot = string.Empty;
        }
    }
}

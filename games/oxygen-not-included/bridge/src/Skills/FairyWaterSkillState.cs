namespace DoubaoAI.ONI.Skills
{
    internal sealed class FairyWaterSkillState
    {
        public bool Learned { get; set; }
        public string StoredElementId { get; set; } = string.Empty;
        public float StoredMassKg { get; set; }
        public float StoredTemperatureKelvin { get; set; }
        public byte StoredDiseaseIndex { get; set; } = byte.MaxValue;
        public int StoredDiseaseCount { get; set; }

        internal void Normalize(float capacityKg)
        {
            if (StoredElementId == null) StoredElementId = string.Empty;
            StoredMassKg = UnityEngine.Mathf.Clamp(StoredMassKg, 0f, capacityKg);
            StoredTemperatureKelvin = UnityEngine.Mathf.Clamp(StoredTemperatureKelvin, 0f, 10000f);
            StoredDiseaseCount = System.Math.Max(0, StoredDiseaseCount);
            if (StoredMassKg <= 0.001f)
            {
                StoredElementId = string.Empty;
                StoredMassKg = 0f;
                StoredTemperatureKelvin = 0f;
                StoredDiseaseIndex = byte.MaxValue;
                StoredDiseaseCount = 0;
            }
        }
    }
}

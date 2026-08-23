using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using DoubaoAI.ONI.Commands;
using Newtonsoft.Json;
using UnityEngine;

namespace DoubaoAI.ONI.Skills
{
    internal sealed class FairyWaterSkillSystem
    {
        internal const float CapacityKg = 1000f;
        internal const float SprayMassKg = 200f;
        private const int MaximumRangeCells = 12;

        private readonly string _statePath;
        private readonly CellAddRemoveSubstanceEvent _absorbEvent =
            new CellAddRemoveSubstanceEvent("XiaoTangYuanAbsorbWater", "小汤圆吸水");
        private FairyWaterSkillState _state;

        internal FairyWaterSkillSystem()
        {
            _statePath = ResolveStatePath();
            _state = Load(_statePath);
        }

        internal bool Learned => _state.Learned;
        internal float StoredMassKg => _state.StoredMassKg;
        internal string StoredElementName => StoredElement() == null ? "无" : StoredElement().name;

        internal bool TryLearnFromContact(MinionIdentity followedMinion)
        {
            if (_state.Learned || followedMinion == null || followedMinion.gameObject == null) return false;
            int origin = Grid.PosToCell(followedMinion.gameObject);
            if (!Grid.IsValidCell(origin)) return false;

            int[] cells =
            {
                origin,
                Grid.OffsetCell(origin, 0, -1),
                Grid.OffsetCell(origin, -1, 0),
                Grid.OffsetCell(origin, 1, 0)
            };
            foreach (int cell in cells)
            {
                if (!Grid.IsValidCell(cell) || Grid.WorldIdx[cell] != Grid.WorldIdx[origin]) continue;
                Element element = Grid.Element[cell];
                if (!IsWater(element) || Grid.Mass[cell] < 1f) continue;
                _state.Learned = true;
                Save();
                return true;
            }
            return false;
        }

        internal PlayerCommandExecutionResult Absorb(int targetCell, MinionIdentity followedMinion)
        {
            PlayerCommandExecutionResult validation = ValidateTarget(targetCell, followedMinion);
            if (validation != null) return validation;
            if (!_state.Learned) return Failure("我还不会吸水。先带我真正碰一次水吧。");

            Element element = Grid.Element[targetCell];
            if (!IsWater(element) || Grid.Mass[targetCell] < 1f)
                return Failure("鼠标指的位置没有足够的水。水、污染水、盐水和浓盐水都可以吸。");
            if (_state.StoredMassKg >= CapacityKg - 0.001f)
                return Failure("我的水肚子已经装满了，先让我喷掉一些吧。");
            if (_state.StoredMassKg > 0.001f && !string.Equals(_state.StoredElementId, element.id.ToString(), StringComparison.Ordinal))
                return Failure("我肚子里还有另一种水，先喷完才能换着吸。");

            float sourceMass = Grid.Mass[targetCell];
            float amount = Mathf.Min(sourceMass, CapacityKg - _state.StoredMassKg);
            float sourceTemperature = Grid.Temperature[targetCell];
            int sourceDiseaseCount = Grid.DiseaseCount[targetCell];
            int absorbedDiseaseCount = sourceMass <= 0f
                ? 0
                : Mathf.RoundToInt(sourceDiseaseCount * Mathf.Clamp01(amount / sourceMass));

            float previousMass = _state.StoredMassKg;
            float combinedMass = previousMass + amount;
            _state.StoredElementId = element.id.ToString();
            _state.StoredTemperatureKelvin = previousMass <= 0.001f
                ? sourceTemperature
                : ((_state.StoredTemperatureKelvin * previousMass) + (sourceTemperature * amount)) / combinedMass;
            _state.StoredDiseaseIndex = Grid.DiseaseIdx[targetCell];
            _state.StoredDiseaseCount += absorbedDiseaseCount;
            _state.StoredMassKg = combinedMass;

            SimMessages.ConsumeMass(targetCell, element.id, amount, (byte)0);
            _absorbEvent.Log(targetCell, element.id, -amount, -1);
            Save();
            return Success(string.Format(CultureInfo.InvariantCulture,
                "咕噜——吸进了 {0:0.#} kg {1}，现在装着 {2:0.#}/{3:0} kg。",
                amount, element.name, _state.StoredMassKg, CapacityKg));
        }

        internal PlayerCommandExecutionResult Spray(int targetCell, MinionIdentity followedMinion)
        {
            PlayerCommandExecutionResult validation = ValidateTarget(targetCell, followedMinion);
            if (validation != null) return validation;
            if (!_state.Learned) return Failure("我还不会喷水。先带我真正碰一次水吧。");
            if (_state.StoredMassKg <= 0.001f) return Failure("我的水肚子是空的，先指着水让我吸水吧。");
            if (Grid.IsSolidCell(targetCell)) return Failure("这里是实心地块，换一个空格子让我喷水。");

            Element stored = StoredElement();
            if (stored == null)
            {
                ClearStoredWater();
                Save();
                return Failure("我记不清肚子里的水是什么了，储水已经安全清空。");
            }
            Element target = Grid.Element[targetCell];
            if (target != null && target.IsLiquid && Grid.Mass[targetCell] > 0.001f && target.id != stored.id)
                return Failure("这里已经有另一种液体，直接混进去会出事，换个空格子吧。");

            float amount = Mathf.Min(SprayMassKg, _state.StoredMassKg);
            int diseaseCount = _state.StoredMassKg <= 0f
                ? 0
                : Mathf.RoundToInt(_state.StoredDiseaseCount * Mathf.Clamp01(amount / _state.StoredMassKg));
            SimMessages.EmitMass(targetCell, stored.idx, amount, _state.StoredTemperatureKelvin,
                _state.StoredDiseaseIndex, diseaseCount);
            _state.StoredMassKg -= amount;
            _state.StoredDiseaseCount = Math.Max(0, _state.StoredDiseaseCount - diseaseCount);
            if (_state.StoredMassKg <= 0.001f) ClearStoredWater();
            Save();
            return Success(string.Format(CultureInfo.InvariantCulture,
                "噗——向目标喷出了 {0:0.#} kg {1}，还剩 {2:0.#} kg。",
                amount, stored.name, _state.StoredMassKg));
        }

        internal string PromptSummary()
        {
            if (!_state.Learned)
                return "小汤圆技能看板: 水团术未学会；跟随复制人接触至少1kg水后自动觉醒。";
            return string.Format(CultureInfo.InvariantCulture,
                "小汤圆技能看板: 水团术已学会；储水={0:0.#}/{1:0}kg，种类={2}；玩家要求吸水时调用 oni_companion_absorb_water，要求喷水或放水时调用 oni_companion_spray_water。",
                _state.StoredMassKg, CapacityKg, StoredElementName);
        }

        private static PlayerCommandExecutionResult ValidateTarget(int targetCell, MinionIdentity followedMinion)
        {
            if (!Grid.IsValidCell(targetCell)) return Failure("鼠标没有指向有效格子。");
            if (followedMinion == null || followedMinion.gameObject == null)
                return Failure("我现在没有可以跟随的复制人。");
            int origin = Grid.PosToCell(followedMinion.gameObject);
            if (!Grid.IsValidCell(origin) || Grid.WorldIdx[origin] != Grid.WorldIdx[targetCell])
                return Failure("目标不在我和搭档所在的世界。");
            Grid.CellToXY(origin, out int originX, out int originY);
            Grid.CellToXY(targetCell, out int targetX, out int targetY);
            if (Math.Abs(originX - targetX) + Math.Abs(originY - targetY) > MaximumRangeCells)
                return Failure("那里太远了，把鼠标移到我附近12格以内吧。");
            return null;
        }

        private static bool IsWater(Element element)
        {
            return element != null && element.IsLiquid && element.HasTag(GameTags.AnyWater);
        }

        private Element StoredElement()
        {
            if (_state.StoredMassKg <= 0.001f || string.IsNullOrWhiteSpace(_state.StoredElementId)) return null;
            if (!Enum.TryParse(_state.StoredElementId, out SimHashes hash)) return null;
            ushort index = ElementLoader.GetElementIndex(hash);
            return index == ushort.MaxValue ? null : ElementLoader.elements[index];
        }

        private void ClearStoredWater()
        {
            _state.StoredElementId = string.Empty;
            _state.StoredMassKg = 0f;
            _state.StoredTemperatureKelvin = 0f;
            _state.StoredDiseaseIndex = byte.MaxValue;
            _state.StoredDiseaseCount = 0;
        }

        private static FairyWaterSkillState Load(string path)
        {
            try
            {
                FairyWaterSkillState state = File.Exists(path)
                    ? JsonConvert.DeserializeObject<FairyWaterSkillState>(File.ReadAllText(path))
                    : null;
                state = state ?? new FairyWaterSkillState();
                state.Normalize(CapacityKg);
                return state;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[DoubaoAI][WaterSkill] 读取技能状态失败：" + ex.Message);
                return new FairyWaterSkillState();
            }
        }

        private void Save()
        {
            try
            {
                _state.Normalize(CapacityKg);
                Directory.CreateDirectory(Path.GetDirectoryName(_statePath));
                string temporary = _statePath + ".tmp";
                File.WriteAllText(temporary, JsonConvert.SerializeObject(_state, Formatting.Indented));
                if (File.Exists(_statePath)) File.Delete(_statePath);
                File.Move(temporary, _statePath);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[DoubaoAI][WaterSkill] 保存技能状态失败：" + ex.Message);
            }
        }

        private static string ResolveStatePath()
        {
            string saveIdentity = "default";
            try
            {
                string raw = SaveLoader.Instance == null
                    ? string.Empty
                    : Convert.ToString(SaveLoader.Instance.GameInfo.colonyGuid, CultureInfo.InvariantCulture);
                if (!string.IsNullOrWhiteSpace(raw))
                {
                    using (SHA256 sha = SHA256.Create())
                    {
                        byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes("oni-water-skill:" + raw));
                        saveIdentity = BitConverter.ToString(digest).Replace("-", string.Empty).ToLowerInvariant();
                    }
                }
            }
            catch { /* fall back to a default state for non-save test scenes */ }
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "XiaoTangYuan", "oni-state");
            return Path.Combine(root, saveIdentity + ".water-skill.json");
        }

        private static PlayerCommandExecutionResult Success(string reply)
        {
            return new PlayerCommandExecutionResult { Success = true, Reply = reply };
        }

        private static PlayerCommandExecutionResult Failure(string reply)
        {
            return new PlayerCommandExecutionResult { Success = false, Reply = reply };
        }
    }
}

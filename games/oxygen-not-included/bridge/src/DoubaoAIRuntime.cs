using System;
using System.Collections.Generic;
using System.IO;
using DoubaoAI.ONI.Assets;
using DoubaoAI.ONI.Commands;
using DoubaoAI.ONI.GameState;
using DoubaoAI.ONI.Harness;
using DoubaoAI.ONI.Skills;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace DoubaoAI.ONI
{
    // Thin game Bridge. AI models, media, memory and credentials live in AIHarness.
    internal sealed class DoubaoAIRuntime : MonoBehaviour
    {
        private OniHarnessBridge _bridge;
        private Texture2D _sprite;
        private Texture2D _fallbackSprite;
        private Font _font;
        private GUIStyle _bodyStyle;
        private GUIStyle _inputStyle;
        private GUIStyle _buttonStyle;
        private GUIStyle _statusStyle;
        private Rect _panelRect;
        private string _input = string.Empty;
        private string _reply = "我是精灵。把鼠标指到目标位置，可以问攻略，也可以让我指挥复制人。";
        private string _status = "正在连接 AIHarness…";
        private bool _panelOpen;
        private bool _busy;
        private float _bubbleUntil;
        private float _nextDangerScanAt;
        private float _lastDangerAlertAt;
        private string _lastDangerSignature;
        private MinionIdentity _followedMinion;
        private MinionIdentity _facingMinion;
        private Vector3 _lastFacingPosition;
        private float _nextFacingSampleAt;
        private float _lastFairyMovementAt;
        private int _facingFrame;
        private FairyWaterSkillSystem _waterSkill;
        private float _nextWaterContactScanAt;
        private int _panelTab;

        private void Awake()
        {
            PlayerCommandExecutor.Reset();
            ModConfig config = ConfigManager.Load(ModPaths.ContentPath);
            _bridge = new OniHarnessBridge(config.HarnessBridgeRoot);
            _bridge.Notification += OnHarnessNotification;
            _bridge.ToolExecution += ExecuteHarnessTool;
            _waterSkill = new FairyWaterSkillSystem();
            string assets = Path.Combine(ModPaths.ContentPath, "assets");
            _sprite = TextureLoader.LoadPng(Path.Combine(assets, "doubao_companion.png"));
            _fallbackSprite = TextureLoader.LoadPng(Path.Combine(assets, "doubao_t.png"));
            try { _font = Font.CreateDynamicFontFromOSFont("Microsoft YaHei UI", 18); } catch { _font = null; }
            _panelRect = new Rect(Mathf.Max(20, Screen.width - 540), 110, 500, 500);
            _bubbleUntil = Time.unscaledTime + 8f;
        }

        private void Update()
        {
            PlayerCommandExecutor.Tick();
            _bridge.Tick();
            GameSnapshot snapshot = SafeCollectSnapshot();
            PlayerCommandSnapshot command = SafeCollectCommandSnapshot();
            _bridge.PublishState(snapshot, command);
            ModConfig config = ConfigManager.Current;
            if (config.DangerAlertsEnabled && Time.unscaledTime >= _nextDangerScanAt)
            {
                _nextDangerScanAt = Time.unscaledTime + 2f;
                PlayerDangerEvent danger = PlayerDangerDetector.Detect();
                if (danger == null) _lastDangerSignature = null;
                else if (!_busy && (danger.Signature != _lastDangerSignature || Time.unscaledTime - _lastDangerAlertAt >= config.DangerAlertCooldownSeconds))
                {
                    _lastDangerSignature = danger.Signature;
                    _lastDangerAlertAt = Time.unscaledTime;
                    _busy = true;
                    _status = "正在生成紧急提醒…";
                    _bridge.Compose(danger.Prompt, snapshot, command);
                }
            }
            if (_panelOpen && Input.GetKeyDown(KeyCode.Escape)) _panelOpen = false;
            if (Time.unscaledTime >= _nextWaterContactScanAt)
            {
                _nextWaterContactScanAt = Time.unscaledTime + 0.5f;
                if (_waterSkill != null && _waterSkill.TryLearnFromContact(ResolveFollowedMinion()))
                {
                    _reply = "哇，我碰到水以后学会水团术了！现在可以对我说“吸这里的水”或“向这里喷水”。";
                    _status = "已觉醒：水团术";
                    _bubbleUntil = Time.unscaledTime + 12f;
                }
            }
        }

        private MinionIdentity ResolveFollowedMinion()
        {
            if (IsLiveMinion(_followedMinion)) return _followedMinion;

            string rememberedName = ConfigManager.Current.FairyFollowDuplicantName.Trim();
            var candidates = new List<MinionIdentity>();
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (!IsLiveMinion(minion)) continue;
                if (rememberedName.Length > 0
                    && string.Equals(SafeMinionName(minion), rememberedName, StringComparison.OrdinalIgnoreCase))
                {
                    _followedMinion = minion;
                    return _followedMinion;
                }
                candidates.Add(minion);
            }

            if (candidates.Count == 0) return null;
            _followedMinion = candidates[UnityEngine.Random.Range(0, candidates.Count)];
            RememberFollowedMinion(_followedMinion);
            return _followedMinion;
        }

        private static string SafeMinionName(MinionIdentity minion)
        {
            try { return (minion.GetProperName() ?? minion.name ?? "未知").Replace("\r", " ").Replace("\n", " ").Trim(); }
            catch { return minion == null ? "未知" : minion.name; }
        }

        private void RememberFollowedMinion(MinionIdentity minion)
        {
            string name = SafeMinionName(minion);
            if (string.Equals(ConfigManager.Current.FairyFollowDuplicantName, name, StringComparison.Ordinal)) return;
            ConfigManager.Current.FairyFollowDuplicantName = name;
            ConfigManager.Save();
        }

        private PlayerCommandExecutionResult ChangeFollowedMinion(int actorId)
        {
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (IsLiveMinion(minion) && PlayerCommandContextCollector.GetId(minion) == actorId)
                {
                    _followedMinion = minion;
                    RememberFollowedMinion(minion);
                    string name = SafeMinionName(minion);
                    _reply = "好吧，以后我就跟着" + name + "。";
                    _bubbleUntil = Time.unscaledTime + 8f;
                    return new PlayerCommandExecutionResult { Success = true, Reply = "小汤圆已改为跟随" + name + "。" };
                }
            }
            return new PlayerCommandExecutionResult { Success = false, Reply = "没有找到指定的存活复制人。" };
        }

        private static bool IsLiveMinion(MinionIdentity candidate)
        {
            if (candidate == null || candidate.gameObject == null) return false;
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == candidate) return true;
            }
            return false;
        }

        private bool TryGetFairyAnchor(out Rect anchor)
        {
            anchor = new Rect();
            MinionIdentity minion = ResolveFollowedMinion();
            CameraController controller = CameraController.Instance;
            Camera camera = controller == null ? null : controller.baseCamera;
            if (minion == null || camera == null) return false;

            Vector3 screen = camera.WorldToScreenPoint(minion.transform.position);
            Vector3 oneCellUp = camera.WorldToScreenPoint(minion.transform.position + Vector3.up);
            const float offscreenMargin = 96f;
            if (screen.z <= 0f
                || screen.x < -offscreenMargin
                || screen.x > Screen.width + offscreenMargin
                || screen.y < -offscreenMargin
                || screen.y > Screen.height + offscreenMargin)
            {
                return false;
            }

            ModConfig config = ConfigManager.Current;
            // Keep the fairy at a stable size in the game world. A fixed pixel size
            // makes it look larger when the camera zooms out and smaller when it zooms in.
            float spriteSize = Mathf.Clamp(Mathf.Abs(oneCellUp.y - screen.y) * 0.8f, 28f, 84f);
            float scale = spriteSize / 72f;
            float idleSway = Mathf.Sin(Time.unscaledTime * 1.25f + 0.8f) * 2.5f * scale;
            float idleBob = Mathf.Sin(Time.unscaledTime * 2.1f) * 5f * scale;
            float x = screen.x + config.FairyFollowOffsetX * scale + idleSway;
            float y = Screen.height - screen.y - spriteSize - config.FairyFollowOffsetY * scale + idleBob;
            anchor = new Rect(
                Mathf.Clamp(x, 8f, Mathf.Max(8f, Screen.width - spriteSize - 8f)),
                Mathf.Clamp(y, 8f, Mathf.Max(8f, Screen.height - spriteSize - 8f)),
                spriteSize,
                spriteSize);
            UpdateFairyFacing(minion);
            return true;
        }

        private void UpdateFairyFacing(MinionIdentity minion)
        {
            if (_facingMinion != minion)
            {
                _facingMinion = minion;
                _lastFacingPosition = minion.transform.position;
                _nextFacingSampleAt = Time.unscaledTime + 0.1f;
                _lastFairyMovementAt = Time.unscaledTime;
                _facingFrame = 0;
                return;
            }

            if (Time.unscaledTime < _nextFacingSampleAt) return;
            _nextFacingSampleAt = Time.unscaledTime + 0.1f;

            Vector3 position = minion.transform.position;
            Vector3 movement = position - _lastFacingPosition;
            _lastFacingPosition = position;
            if (Mathf.Abs(movement.x) < 0.025f && Mathf.Abs(movement.y) < 0.025f)
            {
                if (Time.unscaledTime - _lastFairyMovementAt >= 0.2f) _facingFrame = 0;
                return;
            }

            _lastFairyMovementAt = Time.unscaledTime;

            if (Mathf.Abs(movement.x) >= Mathf.Abs(movement.y))
            {
                // Sprite strip order: front, right, back, left.
                _facingFrame = movement.x > 0f ? 1 : 3;
            }
            else
            {
                // Vertical travel means the duplicant is climbing, so both
                // directions show the companion's back.
                _facingFrame = 2;
            }
        }

        private PlayerCommandExecutionResult ExecuteHarnessTool(string name, JObject args)
        {
            if (name == "oni_companion_follow")
                return ChangeFollowedMinion((int?)args["actorId"] ?? -1);
            if (name == "oni_companion_absorb_water" || name == "oni_companion_spray_water")
            {
                PlayerCommandExecutionResult result = name == "oni_companion_absorb_water"
                    ? _waterSkill.Absorb((int?)args["targetCell"] ?? Grid.InvalidCell, ResolveFollowedMinion())
                    : _waterSkill.Spray((int?)args["targetCell"] ?? Grid.InvalidCell, ResolveFollowedMinion());
                _reply = result.Reply;
                _status = result.Success ? "水团术发动成功" : "水团术没有发动";
                _bubbleUntil = Time.unscaledTime + 10f;
                return result;
            }

            var plan = new PlayerCommandPlan
            {
                Mode = "command",
                ActorScope = ((string)args["actorScope"] ?? "specific").Trim().ToLowerInvariant(),
                ActorId = (int?)args["actorId"] ?? -1,
                TargetCell = (int?)args["targetCell"] ?? Grid.InvalidCell,
                Urgent = (bool?)args["urgent"] ?? false,
                BuildingKey = ((string)args["buildingKey"] ?? string.Empty).Trim().ToLowerInvariant()
            };
            if (name == "oni_move") plan.Action = "move";
            else if (name == "oni_dig") plan.Action = "dig";
            else if (name == "oni_dig_path") plan.Action = "dig_path";
            else if (name == "oni_build") plan.Action = "build";
            else return new PlayerCommandExecutionResult { Success = false, Reply = "未知缺氧工具：" + name };
            return PlayerCommandExecutor.Execute(plan);
        }

        private void OnHarnessNotification(string method, string text)
        {
            if (method == "gateway.ready") { _status = "AIHarness 已连接"; return; }
            if (method == "assistant.status") { _status = text == "recording" ? "正在听你说话…" : "AIHarness 正在思考…"; return; }
            if (method == "assistant.delta" || method == "assistant.text.delta")
            {
                if (!string.IsNullOrWhiteSpace(text)) _reply = text;
                _status = "小汤圆正在回答…";
                _bubbleUntil = Time.unscaledTime + 12f; return;
            }
            if (method == "assistant.present")
            {
                _busy = false; _status = "回答完成";
                _reply = string.IsNullOrWhiteSpace(text) ? "这次没有生成有效回复。" : text;
                _bubbleUntil = Time.unscaledTime + 12f; return;
            }
            if (method == "assistant.error")
            {
                _busy = false; _status = "AIHarness 请求失败";
                _reply = string.IsNullOrWhiteSpace(text) ? "请确认 AIHarness 已启动。" : text;
                _bubbleUntil = Time.unscaledTime + 10f;
            }
        }

        private void OnGUI()
        {
            EnsureStyles();
            bool hasAnchor = TryGetFairyAnchor(out Rect anchor);
            Texture2D shown = _sprite != null ? _sprite : _fallbackSprite;
            if (hasAnchor && shown != null)
            {
                int frameCount = shown.height > 0 && shown.width >= shown.height * 2
                    ? Mathf.Max(1, shown.width / shown.height)
                    : 1;
                if (frameCount == 1) GUI.DrawTexture(anchor, shown, ScaleMode.ScaleToFit, true);
                else
                {
                    float frameWidth = 1f / frameCount;
                    int frame = Mathf.Clamp(_facingFrame, 0, frameCount - 1);
                    GUI.DrawTextureWithTexCoords(anchor, shown, new Rect(frame * frameWidth, 0f, frameWidth, 1f), true);
                }
            }
            if (hasAnchor && GUI.Button(anchor, GUIContent.none, GUIStyle.none)) _panelOpen = !_panelOpen;
            if (hasAnchor && !_panelOpen && Time.unscaledTime < _bubbleUntil && !string.IsNullOrWhiteSpace(_reply))
            {
                Rect bubble = new Rect(Mathf.Max(20, anchor.x - 340), anchor.y + 5, 320, 90);
                GUI.Box(bubble, GUIContent.none);
                GUI.Label(new Rect(bubble.x + 12, bubble.y + 10, bubble.width - 24, bubble.height - 20), _reply, _bodyStyle);
            }
            if (_panelOpen) _panelRect = GUI.Window(854721, _panelRect, DrawPanel, "缺氧 AI 精灵");
        }

        private void DrawPanel(int id)
        {
            if (GUI.Button(new Rect(20, 40, 120, 32), "对话", _buttonStyle)) _panelTab = 0;
            if (GUI.Button(new Rect(150, 40, 120, 32), "技能看板", _buttonStyle)) _panelTab = 1;
            if (_panelTab == 1)
            {
                DrawSkillBoard();
                GUI.DragWindow(new Rect(0, 0, 500, 36));
                return;
            }

            GUI.Label(new Rect(20, 78, 460, 28), _status, _statusStyle);
            GUI.Box(new Rect(20, 112, 460, 216), GUIContent.none);
            GUI.Label(new Rect(34, 126, 432, 188), _reply, _bodyStyle);
            _input = GUI.TextArea(new Rect(20, 344, 460, 72), _input, 600, _inputStyle);
            bool send = GUI.Button(new Rect(350, 432, 130, 36), _busy ? "思考中…" : "发送", _buttonStyle);
            if (GUI.Button(new Rect(20, 432, 128, 36), "重载配置", _buttonStyle)) ConfigManager.Load(ModPaths.ContentPath);
            Event current = Event.current;
            if (current.type == EventType.KeyDown && current.keyCode == KeyCode.Return && (current.control || current.command)) { send = true; current.Use(); }
            if (send && !_busy && !string.IsNullOrWhiteSpace(_input))
            {
                string text = _input.Trim(); _input = string.Empty; _busy = true;
                _status = "正在交给 AIHarness 思考…";
                _bridge.SendChat(text, SafeCollectSnapshot(), SafeCollectCommandSnapshot());
            }
            GUI.DragWindow(new Rect(0, 0, 500, 36));
        }

        private void DrawSkillBoard()
        {
            bool learned = _waterSkill != null && _waterSkill.Learned;
            GUI.Label(new Rect(20, 84, 460, 30), learned ? "水团术 · 已学会" : "水团术 · 尚未学会", _statusStyle);
            GUI.Box(new Rect(20, 120, 460, 300), GUIContent.none);
            string description = learned
                ? string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "储水囊：{0:0.#}/{1:0} kg\n当前液体：{2}\n\n吸水\n鼠标指向12格内的水，对我说“吸这里的水”。最多保存一格水，真实保留种类、温度和病菌。\n\n喷水\n鼠标指向12格内的空格，对我说“向这里喷水”。每次喷出最多{3:0} kg。",
                    _waterSkill.StoredMassKg, FairyWaterSkillSystem.CapacityKg,
                    _waterSkill.StoredElementName, FairyWaterSkillSystem.SprayMassKg)
                : "学习方式\n让跟随的复制人带着我接触水、污染水、盐水或浓盐水。\n\n第一次真正碰到水后，我会自动觉醒吸水和喷水，不需要技能点。";
            GUI.Label(new Rect(36, 138, 428, 264), description, _bodyStyle);
        }

        private GameSnapshot SafeCollectSnapshot()
        {
            try
            {
                GameSnapshot snapshot = GameSnapshotCollector.Collect();
                if (_waterSkill != null)
                    snapshot.PromptContext = (snapshot.PromptContext ?? string.Empty) + _waterSkill.PromptSummary() + "\n";
                return snapshot;
            }
            catch (Exception ex) { return new GameSnapshot { PromptContext = "采集结构化游戏信息失败：" + ex.Message }; }
        }

        private static PlayerCommandSnapshot SafeCollectCommandSnapshot()
        {
            try { return PlayerCommandContextCollector.Collect(); }
            catch { return new PlayerCommandSnapshot(); }
        }

        private void EnsureStyles()
        {
            if (_bodyStyle != null) return;
            Font selected = _font != null ? _font : GUI.skin.font;
            _bodyStyle = new GUIStyle(GUI.skin.label) { font = selected, fontSize = 17, wordWrap = true, normal = { textColor = Color.white } };
            _inputStyle = new GUIStyle(GUI.skin.textArea) { font = selected, fontSize = 17, wordWrap = true, padding = new RectOffset(10, 10, 8, 8) };
            _buttonStyle = new GUIStyle(GUI.skin.button) { font = selected, fontSize = 16, fontStyle = FontStyle.Bold };
            _statusStyle = new GUIStyle(GUI.skin.label) { font = selected, fontSize = 14, normal = { textColor = new Color(0.65f, 0.9f, 1f) } };
        }

        private void OnDestroy()
        {
            PlayerCommandExecutor.Reset();
            if (_bridge != null) _bridge.Dispose();
            if (_sprite != null) Destroy(_sprite);
            if (_fallbackSprite != null) Destroy(_fallbackSprite);
            if (_font != null) Destroy(_font);
        }
    }
}

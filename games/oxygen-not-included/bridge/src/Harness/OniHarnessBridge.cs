using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using DoubaoAI.ONI.Commands;
using DoubaoAI.ONI.GameState;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DoubaoAI.ONI.Harness
{
    // Unity/Mono has inconsistent WebSocket support across ONI releases.  The Mod
    // therefore only owns the game-side file bridge; the TypeScript ONI Adapter
    // owns the Gateway WebSocket and all AI credentials.
    internal sealed class OniHarnessBridge : IDisposable
    {
        private const int MaximumEvents = 200;
        private readonly string _directory;
        private readonly string _outboxPath;
        private readonly string _inboxPath;
        private readonly string _sessionPath;
        private readonly HashSet<string> _seenInbox = new HashSet<string>();
        private readonly List<JObject> _outbox = new List<JObject>();
        private System.DateTime _lastStateAtUtc = System.DateTime.MinValue;
        private string _lastSaveId;

        internal event Action<string, string> Notification;
        internal event Func<string, JObject, PlayerCommandExecutionResult> ToolExecution;

        internal OniHarnessBridge(string root)
        {
            string safeRoot = string.IsNullOrWhiteSpace(root)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "XiaoTangYuan", "oni-bridge")
                : root;
            _directory = Path.Combine(safeRoot, Process.GetCurrentProcess().Id.ToString());
            _outboxPath = Path.Combine(_directory, "outbox.json");
            _inboxPath = Path.Combine(_directory, "inbox.json");
            _sessionPath = Path.Combine(_directory, "session.json");
            Directory.CreateDirectory(_directory);
            WriteSessionIdentity();
        }

        private void WriteSessionIdentity()
        {
            string saveId = CurrentSaveId();
            if (saveId == _lastSaveId && File.Exists(_sessionPath)) return;
            _lastSaveId = saveId;
            WriteAtomically(_sessionPath, new JObject
            {
                ["adapterId"] = "qimidandapigu.oxygen-not-included-fairy",
                ["gameId"] = "oxygen-not-included",
                ["version"] = "0.6.6",
                ["protocolVersion"] = "1.1",
                ["capabilities"] = new JArray("assistant.text-stream"),
                ["processId"] = Process.GetCurrentProcess().Id,
                ["saveId"] = saveId
            });
        }

        private static string CurrentSaveId()
        {
            try
            {
                string raw = SaveLoader.Instance == null
                    ? string.Empty
                    : Convert.ToString(SaveLoader.Instance.GameInfo.colonyGuid);
                if (string.IsNullOrWhiteSpace(raw)) return "default";
                using (SHA256 sha = SHA256.Create())
                {
                    byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes("oni:" + raw));
                    return BitConverter.ToString(digest).Replace("-", string.Empty).ToLowerInvariant();
                }
            }
            catch { return "default"; }
        }

        internal void PublishState(GameSnapshot snapshot, PlayerCommandSnapshot command)
        {
            WriteSessionIdentity();
            if (System.DateTime.UtcNow - _lastStateAtUtc < TimeSpan.FromMilliseconds(500)) return;
            _lastStateAtUtc = System.DateTime.UtcNow;
            Enqueue("state.update", new JObject { ["observation"] = Observation(snapshot, command) });
        }

        internal void SendChat(string text, GameSnapshot snapshot, PlayerCommandSnapshot command)
        {
            Enqueue("chat.send", new JObject {
                ["text"] = text,
                ["context"] = new JObject { ["observation"] = Observation(snapshot, command) }
            });
        }

        internal void Compose(string text, GameSnapshot snapshot, PlayerCommandSnapshot command)
        {
            Enqueue("assistant.compose", new JObject {
                ["text"] = text,
                ["context"] = new JObject { ["observation"] = Observation(snapshot, command) }
            });
        }

        internal void Tick()
        {
            try
            {
                if (!File.Exists(_inboxPath)) return;
                JObject document = JObject.Parse(File.ReadAllText(_inboxPath));
                JArray events = document["events"] as JArray;
                if (events == null) return;
                foreach (JObject item in events.OfType<JObject>())
                {
                    string id = (string)item["id"];
                    string method = (string)item["method"];
                    if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(method) || !_seenInbox.Add(id)) continue;
                    if (method == "tool.execute")
                    {
                        HandleToolExecution(item["params"] as JObject);
                        continue;
                    }
                    string text = (string)item.SelectToken("params.text") ?? (string)item.SelectToken("params.message") ?? (string)item.SelectToken("params.status") ?? string.Empty;
                    Notification?.Invoke(method, text);
                }
            }
            catch (Exception ex) { UnityEngine.Debug.LogWarning("[DoubaoAI][Harness] 读取 Adapter 回复失败：" + ex.Message); }
        }

        private void HandleToolExecution(JObject parameters)
        {
            string callId = (string)parameters?["callId"];
            string name = (string)parameters?["name"];
            JObject arguments = parameters?["args"] as JObject ?? new JObject();
            if (string.IsNullOrWhiteSpace(callId)) return;
            Stopwatch stopwatch = Stopwatch.StartNew();
            try
            {
                PlayerCommandExecutionResult result = ToolExecution == null
                    ? new PlayerCommandExecutionResult { Success = false, Reply = "缺氧 Bridge 没有注册工具执行器。" }
                    : ToolExecution.Invoke(name, arguments);
                stopwatch.Stop();
                Enqueue("tool.result", new JObject {
                    ["callId"] = callId,
                    ["success"] = result != null && result.Success,
                    ["reply"] = result == null ? "工具没有返回结果。" : result.Reply,
                    ["gameExecutionMs"] = Math.Max(0L, (long)Math.Round(stopwatch.Elapsed.TotalMilliseconds))
                });
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                Enqueue("tool.result", new JObject {
                    ["callId"] = callId,
                    ["success"] = false,
                    ["reply"] = "执行失败：" + ex.Message,
                    ["gameExecutionMs"] = Math.Max(0L, (long)Math.Round(stopwatch.Elapsed.TotalMilliseconds))
                });
            }
        }

        private void Enqueue(string method, JObject parameters)
        {
            _outbox.Add(new JObject {
                ["id"] = Guid.NewGuid().ToString("N"), ["method"] = method,
                ["params"] = parameters, ["createdAtUnix"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
            while (_outbox.Count > MaximumEvents) _outbox.RemoveAt(0);
            WriteAtomically(_outboxPath, new JObject { ["events"] = JArray.FromObject(_outbox) });
        }

        private static JObject Observation(GameSnapshot snapshot, PlayerCommandSnapshot command)
        {
            var actors = new JArray();
            if (command != null) foreach (PlayerCommandActor actor in command.Actors)
                actors.Add(new JObject {
                    ["id"] = actor.Id,
                    ["kind"] = "character",
                    ["name"] = actor.Name,
                    ["selected"] = actor.Selected,
                    ["position"] = new JObject { ["space"] = "cell", ["cell"] = actor.Cell },
                    ["reachableFromCursor"] = actor.CanReachMouse
                });
            return new JObject {
                ["schema"] = "ai-native.game-context.v1",
                ["meta"] = new JObject {
                    ["gameId"] = "oxygen-not-included",
                    ["adapterId"] = "qimidandapigu.oxygen-not-included-fairy",
                    ["capturedAt"] = DateTimeOffset.UtcNow.ToString("o"),
                    ["locale"] = "zh-CN"
                },
                ["scene"] = new JObject(),
                ["player"] = new JObject {
                    ["id"] = command == null ? -1 : command.SelectedActorId
                },
                ["entities"] = actors,
                ["objectives"] = new JArray(),
                ["ui"] = new JObject {
                    ["cursor"] = new JObject {
                        ["space"] = "cell",
                        ["cell"] = command == null ? Grid.InvalidCell : command.MouseCell,
                        ["element"] = command == null ? "unknown" : command.MouseElement,
                        ["solid"] = command != null && command.MouseCellSolid
                    }
                },
                ["extensions"] = new JObject {
                    ["oni"] = new JObject {
                        ["summary"] = snapshot == null ? string.Empty : snapshot.PromptContext,
                        ["selectedDuplicantId"] = command == null ? -1 : command.SelectedActorId
                    }
                }
            };
        }

        private static void WriteAtomically(string path, JObject payload)
        {
            string temporary = path + ".tmp";
            File.WriteAllText(temporary, payload.ToString(Formatting.None));
            if (File.Exists(path)) File.Delete(path);
            File.Move(temporary, path);
        }

        public void Dispose() { }
    }
}

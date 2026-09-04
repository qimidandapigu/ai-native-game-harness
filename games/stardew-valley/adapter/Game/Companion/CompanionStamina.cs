using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace StardewAgentMod.Game.Companion
{
    /// <summary>
    /// 豆包的体力池 —— 各"增益功能"(浇水/收割/钓鱼/打怪/凌晨救助)的统一资源。
    ///
    /// 规则(已与用户确认):
    ///   - 上限 15,新存档开局给满。
    ///   - 每过 3 个游戏小时恢复 5 点(从 6:00 起算,9/12/15/18/21/24 点触发)。
    ///   - 每次调用一个增益功能消耗 1 点(批量动作如"浇全场"整体算一次)。
    ///   - 跨天累积:睡觉跨天保留当前剩余值(随存档持久化到独立 json)。
    ///
    /// 持久化独立成文件(saves/&lt;存档名&gt;.stamina.json),不挤进 ChatHistory 的对话快照。
    /// </summary>
    internal sealed class CompanionStamina
    {
        public const int Max = 15;
        private const int RecoverAmount = 5;
        private const int RecoveryIntervalHours = 3;
        private const int RecoveryAnchorHour = 6;

        private readonly IMonitor monitor;
        private int current = Max;

        public CompanionStamina(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        /// <summary>当前体力。</summary>
        public int Current => this.current;

        /// <summary>体力是否还够发动一次增益。</summary>
        public bool HasAny => this.current > 0;

        /// <summary>
        /// 尝试消费 n 点。够则扣掉返回 true;不够原样不动返回 false。
        /// 调用增益功能前 / 真正生效时调用(由各增益模块决定时机)。
        /// </summary>
        public bool TrySpend(int n = 1)
        {
            if (n <= 0) return true;
            if (this.current < n) return false;
            this.current -= n;
            this.monitor.Log($"[体力] -{n} → {this.current}/{Max}", LogLevel.Trace);
            return true;
        }

        /// <summary>异步能力启动后失败时返还预扣体力。</summary>
        public void Refund(int n = 1)
        {
            if (n <= 0) return;
            int before = this.current;
            this.current = Math.Min(Max, this.current + n);
            this.monitor.Log($"[体力] 失败返还 +{this.current - before} → {this.current}/{Max}", LogLevel.Trace);
        }

        /// <summary>挂 GameLoop.TimeChanged:每过 3 个游戏小时恢复 5 点,夹到上限。</summary>
        public void OnTimeChanged(object? sender, TimeChangedEventArgs e)
        {
            // SDV 时间是 HHMM 整数(630, 700, 710...)。只在整点判断恢复窗口。
            if (e.NewTime % 100 != 0) return;

            int hour = e.NewTime / 100;
            if (hour <= RecoveryAnchorHour) return;
            if ((hour - RecoveryAnchorHour) % RecoveryIntervalHours != 0) return;
            if (this.current >= Max) return;

            int before = this.current;
            this.current = Math.Min(Max, this.current + RecoverAmount);
            this.monitor.Log($"[体力] 3小时恢复 +{this.current - before} → {this.current}/{Max}", LogLevel.Trace);
        }

        /// <summary>喂进 system prompt 的体力现状(让豆包没力气时如实拒绝,而不是假答应)。</summary>
        public string PromptStatus() => $"{this.current}/{Max}";

        /// <summary>体力耗尽时的固定拒绝台词,包含距离下一次恢复的游戏时间。</summary>
        public string BuildExhaustedLine(int timeOfDay)
        {
            int waitMinutes = MinutesUntilNextRecovery(timeOfDay);
            return $"我的体力已经耗尽了,还要休息约{FormatDuration(waitMinutes)}的游戏时间,下一次才能恢复{RecoverAmount}点体力。";
        }

        private static int MinutesUntilNextRecovery(int timeOfDay)
        {
            int hour = Math.Max(0, timeOfDay / 100);
            int minute = Math.Clamp(timeOfDay % 100, 0, 59);
            int nowMinutes = hour * 60 + minute;

            for (int recoveryHour = RecoveryAnchorHour + RecoveryIntervalHours;
                 recoveryHour <= 24;
                 recoveryHour += RecoveryIntervalHours)
            {
                int recoveryMinutes = recoveryHour * 60;
                if (recoveryMinutes > nowMinutes)
                    return recoveryMinutes - nowMinutes;
            }

            // Stardew Valley 在 26:00 结束当天,次日从 6:00 开始;下一次恢复点仍是 9:00。
            int minutesUntilDayEnd = Math.Max(0, 26 * 60 - nowMinutes);
            return minutesUntilDayEnd + RecoveryIntervalHours * 60;
        }

        private static string FormatDuration(int totalMinutes)
        {
            int hours = totalMinutes / 60;
            int minutes = totalMinutes % 60;
            if (hours <= 0) return $"{minutes}分钟";
            if (minutes <= 0) return $"{hours}小时";
            return $"{hours}小时{minutes}分钟";
        }

        /// <summary>回到标题时重置为满(下次真正进档会被 LoadFromFile 覆盖)。</summary>
        public void Reset() => this.current = Max;

        /// <summary>进存档时读取;文件不存在(新档/老档没存过)→ 给满。</summary>
        public void LoadFromFile(string path)
        {
            try
            {
                if (!File.Exists(path))
                {
                    this.current = Max;
                    this.monitor.Log($"[体力] 无存档文件,开局给满 {Max}", LogLevel.Trace);
                    return;
                }

                string json = File.ReadAllText(path);
                var snap = JsonSerializer.Deserialize<StaminaSnapshot>(json);
                int v = snap?.Current ?? Max;
                this.current = Math.Max(0, Math.Min(Max, v));
                this.monitor.Log($"[体力] 读档 → {this.current}/{Max}", LogLevel.Trace);
            }
            catch (Exception ex)
            {
                this.current = Max;
                this.monitor.Log($"[体力] 读档失败,给满: {ex.Message}", LogLevel.Warn);
            }
        }

        /// <summary>睡觉存档时写回当前值。</summary>
        public void SaveToFile(string path)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var snap = new StaminaSnapshot { Current = this.current };
                File.WriteAllText(path, JsonSerializer.Serialize(snap));
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[体力] 存档失败: {ex.Message}", LogLevel.Warn);
            }
        }

        private sealed class StaminaSnapshot
        {
            [JsonPropertyName("current")] public int Current { get; set; } = Max;
        }
    }
}

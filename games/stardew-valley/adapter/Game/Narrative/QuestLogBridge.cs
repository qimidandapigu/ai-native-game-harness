using System;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Quests;
using StardewAgentMod.Game.Narrative;

namespace StardewAgentMod.Game.Narrative
{
    internal sealed class QuestLogBridge
    {
        private const int CustomQuestType = 100;
        private readonly IMonitor monitor;

        public QuestLogBridge(IMonitor monitor)
        {
            this.monitor = monitor;
        }

        public void Upsert(QuestInstance instance)
        {
            if (!Context.IsWorldReady || Game1.player == null) return;
            try
            {
                var quest = this.Find(instance.QuestId);
                if (quest == null)
                {
                    quest = new Quest();
                    quest.id.Value = instance.QuestId;
                    quest.questType.Value = CustomQuestType;
                    quest.accepted.Value = true;
                    quest.showNew.Value = true;
                    quest.modData["qimidandapigu.StardewAgent/questInstanceId"] = instance.QuestId;
                    Game1.player.questLog.Add(quest);
                    Game1.addHUDMessage(new HUDMessage("豆包有新的请求", HUDMessage.newQuest_type));
                    this.monitor.Log($"[任务栏] 新增原版任务 {instance.QuestId}", LogLevel.Info);
                }

                quest.questTitle = instance.Title;
                quest.questDescription = instance.Description;
                quest.currentObjective = BuildObjective(instance);
                quest.completed.Value = instance.State == QuestLifecycleState.Completed
                    || instance.State == QuestLifecycleState.Rewarded;
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[任务栏] 同步失败 {instance.QuestId}: {ex.Message}", LogLevel.Warn);
            }
        }

        public void Complete(QuestInstance instance)
        {
            if (!Context.IsWorldReady || Game1.player == null) return;
            try
            {
                var quest = this.Find(instance.QuestId);
                if (quest == null)
                {
                    this.Upsert(instance);
                    quest = this.Find(instance.QuestId);
                }
                if (quest == null) return;

                quest.questTitle = instance.Title;
                quest.questDescription = instance.Description;
                quest.currentObjective = "完成了。豆包学会了新的帮忙方式。";
                quest.completed.Value = true;
                quest.showNew.Value = false;
                Game1.addHUDMessage(new HUDMessage("豆包的请求完成了", HUDMessage.newQuest_type));
                try { Game1.playSound("questcomplete"); } catch { }
                this.monitor.Log($"[任务栏] 标记完成 {instance.QuestId}", LogLevel.Info);
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[任务栏] 完成同步失败 {instance.QuestId}: {ex.Message}", LogLevel.Warn);
            }
        }

        public void Remove(string questId)
        {
            if (!Context.IsWorldReady || Game1.player == null) return;
            try
            {
                var quest = this.Find(questId);
                if (quest != null)
                    Game1.player.questLog.Remove(quest);
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[任务栏] 移除失败 {questId}: {ex.Message}", LogLevel.Warn);
            }
        }

        private Quest? Find(string questId)
        {
            if (Game1.player?.questLog == null) return null;
            foreach (Quest quest in Game1.player.questLog)
            {
                if (quest?.id?.Value == questId)
                    return quest;
                if (quest?.modData != null
                    && quest.modData.TryGetValue("qimidandapigu.StardewAgent/questInstanceId", out string id)
                    && id == questId)
                    return quest;
            }
            return null;
        }

        private static string BuildObjective(QuestInstance instance)
        {
            if (instance.Target <= 0) return instance.Objective;
            int progress = Math.Max(0, Math.Min(instance.Target, instance.Progress));
            return $"{instance.Objective} ({progress}/{instance.Target})";
        }
    }
}

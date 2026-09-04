using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;
using StardewValley;

namespace StardewAgentMod.Game.Narrative
{
    internal static class NarrativeClock
    {
        public static string GameDateKey()
        {
            try
            {
                return $"Y{Game1.year}-{Game1.currentSeason}-{Game1.dayOfMonth}";
            }
            catch
            {
                return DateTime.UtcNow.ToString("yyyy-MM-dd");
            }
        }
    }

    internal enum QuestLifecycleState
    {
        Draft,
        Eligible,
        Offered,
        Accepted,
        Active,
        Negotiating,
        Completed,
        Failed,
        Abandoned,
        Expired,
        Rewarded
    }

    /// <summary>
    /// 小汤圆在星露谷本地保存的关系、技能教学与能力成长状态。
    /// 这里不定义主剧情；跨游戏主剧情仍由 Harness Story Runtime 负责。
    /// </summary>
    internal sealed class CompanionGrowthState
    {
        [JsonPropertyName("version")]
        public int Version { get; set; } = 1;

        [JsonPropertyName("relationshipPoints")]
        public int RelationshipPoints { get; set; }

        [JsonPropertyName("quests")]
        public List<QuestInstance> Quests { get; set; } = new();

        [JsonPropertyName("abilities")]
        public List<AbilityState> Abilities { get; set; } = new();

        [JsonPropertyName("rewardTransactions")]
        public List<RewardTransaction> RewardTransactions { get; set; } = new();

        [JsonPropertyName("recentSemanticEvents")]
        public List<string> RecentSemanticEvents { get; set; } = new();

        public void CopyFrom(CompanionGrowthState other)
        {
            this.Version = other.Version;
            this.RelationshipPoints = other.RelationshipPoints;
            this.Quests = other.Quests ?? new();
            this.Abilities = other.Abilities ?? new();
            this.RewardTransactions = other.RewardTransactions ?? new();
            this.RecentSemanticEvents = other.RecentSemanticEvents ?? new();
        }

        public QuestInstance? FindQuest(string questId)
        {
            foreach (var quest in this.Quests)
            {
                if (quest.QuestId == questId) return quest;
            }
            return null;
        }

        public QuestInstance GetOrCreateQuest(string questId, string templateId)
        {
            var existing = this.FindQuest(questId);
            if (existing != null) return existing;

            var quest = new QuestInstance
            {
                QuestId = questId,
                TemplateId = templateId,
                State = QuestLifecycleState.Draft,
                CreatedGameDate = NarrativeClock.GameDateKey()
            };
            this.Quests.Add(quest);
            return quest;
        }

        public AbilityState GetOrCreateAbility(string abilityId)
        {
            foreach (var ability in this.Abilities)
            {
                if (ability.AbilityId == abilityId) return ability;
            }

            var created = new AbilityState { AbilityId = abilityId };
            this.Abilities.Add(created);
            return created;
        }

        public bool HasRewardTransaction(string transactionId)
        {
            foreach (var tx in this.RewardTransactions)
            {
                if (tx.TransactionId == transactionId && tx.Applied) return true;
            }
            return false;
        }

        public void AddRewardTransaction(string transactionId, string questId, string rewardId)
        {
            if (this.HasRewardTransaction(transactionId)) return;
            this.RewardTransactions.Add(new RewardTransaction
            {
                TransactionId = transactionId,
                QuestId = questId,
                RewardId = rewardId,
                Applied = true,
                AppliedGameDate = NarrativeClock.GameDateKey()
            });
        }

        public void AddSemanticEvent(string eventId)
        {
            if (string.IsNullOrWhiteSpace(eventId)) return;
            this.RecentSemanticEvents.Add($"{NarrativeClock.GameDateKey()}:{eventId}");
            while (this.RecentSemanticEvents.Count > 30)
                this.RecentSemanticEvents.RemoveAt(0);
        }
    }

    internal sealed class QuestInstance
    {
        [JsonPropertyName("questId")]
        public string QuestId { get; set; } = "";

        [JsonPropertyName("templateId")]
        public string TemplateId { get; set; } = "";

        [JsonPropertyName("title")]
        public string Title { get; set; } = "";

        [JsonPropertyName("description")]
        public string Description { get; set; } = "";

        [JsonPropertyName("objective")]
        public string Objective { get; set; } = "";

        [JsonPropertyName("state")]
        public QuestLifecycleState State { get; set; }

        [JsonPropertyName("progress")]
        public int Progress { get; set; }

        [JsonPropertyName("target")]
        public int Target { get; set; }

        [JsonPropertyName("createdGameDate")]
        public string? CreatedGameDate { get; set; }

        [JsonPropertyName("acceptedGameDate")]
        public string? AcceptedGameDate { get; set; }

        [JsonPropertyName("completedGameDate")]
        public string? CompletedGameDate { get; set; }

        [JsonPropertyName("rewardedGameDate")]
        public string? RewardedGameDate { get; set; }

        [JsonPropertyName("history")]
        public List<string> History { get; set; } = new();
    }

    internal sealed class AbilityState
    {
        [JsonPropertyName("abilityId")]
        public string AbilityId { get; set; } = "";

        [JsonPropertyName("unlocked")]
        public bool Unlocked { get; set; }

        [JsonPropertyName("unlockedBy")]
        public string UnlockedBy { get; set; } = "";

        [JsonPropertyName("unlockedAtGameDate")]
        public string? UnlockedAtGameDate { get; set; }

        [JsonPropertyName("lastUsedGameDate")]
        public string? LastUsedGameDate { get; set; }

        [JsonPropertyName("lastUsedDaysPlayed")]
        public int LastUsedDaysPlayed { get; set; }
    }

    internal sealed class RewardTransaction
    {
        [JsonPropertyName("transactionId")]
        public string TransactionId { get; set; } = "";

        [JsonPropertyName("questId")]
        public string QuestId { get; set; } = "";

        [JsonPropertyName("rewardId")]
        public string RewardId { get; set; } = "";

        [JsonPropertyName("applied")]
        public bool Applied { get; set; }

        [JsonPropertyName("appliedGameDate")]
        public string? AppliedGameDate { get; set; }
    }
}

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

    internal sealed class NarrativeState
    {
        [JsonPropertyName("version")]
        public int Version { get; set; } = 1;

        [JsonPropertyName("relationshipPoints")]
        public int RelationshipPoints { get; set; }

        [JsonPropertyName("activeStoryArc")]
        public string ActiveStoryArc { get; set; } = "learning_to_help";

        [JsonPropertyName("storyFlags")]
        public Dictionary<string, bool> StoryFlags { get; set; } = new();

        [JsonPropertyName("completedStoryNodes")]
        public List<string> CompletedStoryNodes { get; set; } = new();

        [JsonPropertyName("quests")]
        public List<QuestInstance> Quests { get; set; } = new();

        [JsonPropertyName("abilities")]
        public List<AbilityState> Abilities { get; set; } = new();

        [JsonPropertyName("rewardTransactions")]
        public List<RewardTransaction> RewardTransactions { get; set; } = new();

        [JsonPropertyName("recentSemanticEvents")]
        public List<string> RecentSemanticEvents { get; set; } = new();

        public bool GetFlag(string flag)
        {
            return this.StoryFlags.TryGetValue(flag, out bool value) && value;
        }

        public void CopyFrom(NarrativeState other)
        {
            this.Version = other.Version;
            this.RelationshipPoints = other.RelationshipPoints;
            this.ActiveStoryArc = other.ActiveStoryArc ?? "learning_to_help";
            this.StoryFlags = other.StoryFlags ?? new();
            this.CompletedStoryNodes = other.CompletedStoryNodes ?? new();
            this.Quests = other.Quests ?? new();
            this.Abilities = other.Abilities ?? new();
            this.RewardTransactions = other.RewardTransactions ?? new();
            this.RecentSemanticEvents = other.RecentSemanticEvents ?? new();
        }

        public void SetFlag(string flag, bool value = true)
        {
            this.StoryFlags[flag] = value;
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

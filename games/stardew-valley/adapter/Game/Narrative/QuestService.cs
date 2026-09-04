using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;
using StardewValley.Tools;
using StardewAgentMod.Game.Abilities;

namespace StardewAgentMod.Game.Narrative
{
    internal sealed class QuestService
    {
        public const string WateringLessonQuestId = "qimidandapigu.StardewAgent.quest.watering_lesson";
        public const string WateringLessonTemplateId = "watering_lesson_v1";
        private const string WateringLessonRewardId = "reward.unlock.water_all.v1";
        private const int WateringLessonTarget = 5;

        public const string HarvestLessonQuestId = "qimidandapigu.StardewAgent.quest.harvest_lesson";
        private const string HarvestLessonTemplateId = "harvest_lesson_v1";
        private const string HarvestLessonRewardId = "reward.unlock.harvest_all.v1";
        private const int HarvestLessonTarget = 3;

        public const string FishingLessonQuestId = "qimidandapigu.StardewAgent.quest.fishing_lesson";
        private const string FishingLessonTemplateId = "fishing_lesson_v1";
        private const string FishingLessonRewardId = "reward.unlock.fish_help.v1";
        private const int FishingLessonTarget = 2;

        public const string CombatLessonQuestId = "qimidandapigu.StardewAgent.quest.combat_lesson";
        private const string CombatLessonTemplateId = "combat_lesson_v1";
        private const string CombatLessonRewardId = "reward.unlock.mine_combat.v1";
        private const int CombatLessonTarget = 3;

        public const string RescueLessonQuestId = "qimidandapigu.StardewAgent.quest.rescue_lesson";
        private const string RescueLessonTemplateId = "rescue_lesson_v1";
        private const string RescueLessonRewardId = "reward.unlock.rescue_home.v1";
        private const int RescueLessonTarget = 1;

        private static readonly string[] UnlockQuestIds =
        {
            WateringLessonQuestId,
            HarvestLessonQuestId,
            FishingLessonQuestId,
            CombatLessonQuestId,
            RescueLessonQuestId
        };

        private readonly IMonitor monitor;
        private readonly NarrativeState state;
        private readonly AbilityRegistry abilities;
        private readonly QuestLogBridge questLog;
        private readonly Action<int, string> recordBond;
        private readonly Func<bool> getEnabled;
        private readonly Action<string> speak;

        private long nextOfferCheckTicks;

        public QuestService(
            IMonitor monitor,
            NarrativeState state,
            AbilityRegistry abilities,
            QuestLogBridge questLog,
            Action<int, string> recordBond,
            Func<bool> getEnabled,
            Action<string> speak)
        {
            this.monitor = monitor;
            this.state = state;
            this.abilities = abilities;
            this.questLog = questLog;
            this.recordBond = recordBond;
            this.getEnabled = getEnabled;
            this.speak = speak;
        }

        public void OnOneSecondUpdate(object? sender, OneSecondUpdateTickedEventArgs e)
        {
            if (!this.getEnabled()) return;
            if (!Context.IsWorldReady) return;
            if (Now() < this.nextOfferCheckTicks) return;
            this.nextOfferCheckTicks = Now() + 5 * 10_000_000L;

            this.TryOfferUnlockLessons();
            this.TryProgressRescueLesson();
        }

        public void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
        {
            if (!Context.IsWorldReady || !this.getEnabled()) return;

            if (this.IsWateringToolUse(e))
                this.AdvanceQuest(WateringLessonQuestId, "manual_water", this.CompleteWateringLesson);

            if (this.IsHarvestAttempt(e))
                this.AdvanceQuest(HarvestLessonQuestId, "manual_harvest", this.CompleteHarvestLesson);

            if (this.IsWeaponUseInMine(e))
                this.AdvanceQuest(CombatLessonQuestId, "manual_weapon", this.CompleteCombatLesson);
        }

        public void OnInventoryChanged(object? sender, InventoryChangedEventArgs e)
        {
            if (!Context.IsWorldReady || !this.getEnabled()) return;
            if (!e.IsLocalPlayer) return;
            if (Game1.player?.CurrentTool is not FishingRod) return;

            int fishAdded = 0;
            foreach (var item in e.Added)
            {
                if (IsFish(item))
                    fishAdded += Math.Max(1, item.Stack);
            }

            for (int i = 0; i < fishAdded; i++)
                this.AdvanceQuest(FishingLessonQuestId, "fish_caught", this.CompleteFishingLesson);
        }

        public void SyncQuestLog()
        {
            foreach (string questId in UnlockQuestIds)
            {
                var quest = this.state.FindQuest(questId);
                if (quest == null) continue;
                if (quest.State is QuestLifecycleState.Active or QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
                    this.questLog.Upsert(quest);
            }
        }

        public void TryOfferUnlockLessons()
        {
            if (this.HasActiveUnlockQuest()) return;

            this.TryOfferWateringLesson();
            if (this.HasActiveUnlockQuest()) return;
            this.TryOfferHarvestLesson();
            if (this.HasActiveUnlockQuest()) return;
            this.TryOfferFishingLesson();
            if (this.HasActiveUnlockQuest()) return;
            this.TryOfferCombatLesson();
            if (this.HasActiveUnlockQuest()) return;
            this.TryOfferRescueLesson();
        }

        public void TryOfferWateringLesson()
        {
            if (this.abilities.CanUseIntent(AbilityRegistry.WaterAll).Allowed) return;
            if (!this.IsSafeIdleWindow()) return;
            if (!this.HasCompanion()) return;

            var quest = this.state.GetOrCreateQuest(WateringLessonQuestId, WateringLessonTemplateId);
            if (quest.State is QuestLifecycleState.Active or QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
                return;

            quest.Title = "豆包的浇水练习";
            quest.Description = "豆包想学会帮你浇水,但她不想在没弄懂农田边界前乱动。先让她看你亲手浇几次。";
            quest.Objective = "在农场手动使用喷壶";
            quest.Target = WateringLessonTarget;
            quest.Progress = Math.Max(0, quest.Progress);
            quest.State = QuestLifecycleState.Active;
            quest.AcceptedGameDate ??= NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:offered");

            this.state.SetFlag("watering_lesson_offered");
            this.state.AddSemanticEvent("WateringTutorialEligible");
            this.questLog.Upsert(quest);
            this.speak("喂,我想学浇水。你先做几次给我看,别笑,我是在研究边界。");
            this.monitor.Log("[叙事] 已发布浇水教学任务", LogLevel.Info);
        }

        public void TryOfferHarvestLesson()
        {
            if (this.abilities.CanUseIntent(AbilityRegistry.HarvestAll).Allowed) return;
            if (!this.abilities.CanUseIntent(AbilityRegistry.WaterAll).Allowed) return;
            if (!this.IsSafeIdleWindow()) return;
            if (!this.HasCompanion()) return;

            int ripeCrops = CountRipeCrops();
            if (ripeCrops <= 0) return;

            var quest = this.state.GetOrCreateQuest(HarvestLessonQuestId, HarvestLessonTemplateId);
            if (quest.State is QuestLifecycleState.Active or QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
                return;

            quest.Title = "豆包的收割练习";
            quest.Description = "豆包怕把没熟的苗一起薅掉。先让她观察你怎样判断成熟作物。";
            quest.Objective = "亲手收获成熟作物";
            quest.Target = HarvestLessonTarget;
            quest.Progress = Math.Max(0, quest.Progress);
            quest.State = QuestLifecycleState.Active;
            quest.AcceptedGameDate ??= NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:offered");

            this.state.SetFlag("harvest_lesson_offered");
            this.state.AddSemanticEvent("HarvestTutorialEligible");
            this.questLog.Upsert(quest);
            this.speak("你收菜的时候慢点,我想看清楚哪些是真的熟了。别让我一口气拔秃你的田。");
            this.monitor.Log("[叙事] 已发布收割练习任务", LogLevel.Info);
        }

        public void TryOfferFishingLesson()
        {
            if (this.abilities.CanUseIntent(AbilityRegistry.FishHelp).Allowed) return;
            if (!this.abilities.CanUseIntent(AbilityRegistry.HarvestAll).Allowed) return;
            if (!this.IsSafeGeneralWindow()) return;
            if (!this.HasCompanion()) return;

            var quest = this.state.GetOrCreateQuest(FishingLessonQuestId, FishingLessonTemplateId);
            if (quest.State is QuestLifecycleState.Active or QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
                return;

            quest.Title = "豆包的浮标练习";
            quest.Description = "豆包觉得钓鱼浮标跳得像在嘲笑她。先让她观察你钓到几条鱼。";
            quest.Objective = "亲手钓到鱼";
            quest.Target = FishingLessonTarget;
            quest.Progress = Math.Max(0, quest.Progress);
            quest.State = QuestLifecycleState.Active;
            quest.AcceptedGameDate ??= NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:offered");

            this.state.SetFlag("fishing_lesson_offered");
            this.state.AddSemanticEvent("FishingTutorialEligible");
            this.questLog.Upsert(quest);
            this.speak("下次钓鱼让我盯着浮标。你先钓几条给我看,我得学会什么时候该收杆。");
            this.monitor.Log("[叙事] 已发布钓鱼练习任务", LogLevel.Info);
        }

        public void TryOfferCombatLesson()
        {
            if (this.abilities.CanUseIntent(AbilityRegistry.MineCombat).Allowed) return;
            if (!this.abilities.CanUseIntent(AbilityRegistry.FishHelp).Allowed) return;
            if (!this.IsMineLocation()) return;
            if (!this.IsSafeGeneralWindow()) return;
            if (!this.HasCompanion()) return;

            var quest = this.state.GetOrCreateQuest(CombatLessonQuestId, CombatLessonTemplateId);
            if (quest.State is QuestLifecycleState.Active or QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
                return;

            quest.Title = "豆包的矿洞胆量练习";
            quest.Description = "豆包一进矿洞就发怵。先让她看你挥几次武器,弄明白怎样不误伤你。";
            quest.Objective = "在矿洞亲自使用武器";
            quest.Target = CombatLessonTarget;
            quest.Progress = Math.Max(0, quest.Progress);
            quest.State = QuestLifecycleState.Active;
            quest.AcceptedGameDate ??= NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:offered");

            this.state.SetFlag("combat_lesson_offered");
            this.state.AddSemanticEvent("CombatTutorialEligible");
            this.questLog.Upsert(quest);
            this.speak("这里阴森森的。你先挥几下武器给我看,我得知道怎么帮忙才不会打到你。");
            this.monitor.Log("[叙事] 已发布战斗练习任务", LogLevel.Info);
        }

        public void TryOfferRescueLesson()
        {
            if (this.abilities.CanUseIntent(AbilityRegistry.RescueHome).Allowed) return;
            if (!this.abilities.CanUseIntent(AbilityRegistry.MineCombat).Allowed) return;
            if (!this.IsSafeGeneralWindow()) return;
            if (!this.HasCompanion()) return;
            if (Game1.timeOfDay < 2200) return;

            var quest = this.state.GetOrCreateQuest(RescueLessonQuestId, RescueLessonTemplateId);
            if (quest.State is QuestLifecycleState.Active or QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
                return;

            quest.Title = "豆包的回家路线练习";
            quest.Description = "豆包不能随便拖着你乱跑。先让她看一次你深夜怎么安全回到床边。";
            quest.Objective = "24:00 后回到自己的家里";
            quest.Target = RescueLessonTarget;
            quest.Progress = Math.Max(0, quest.Progress);
            quest.State = QuestLifecycleState.Active;
            quest.AcceptedGameDate ??= NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:offered");

            this.state.SetFlag("rescue_lesson_offered");
            this.state.AddSemanticEvent("RescueTutorialEligible");
            this.questLog.Upsert(quest);
            this.speak("你老是熬夜。今晚过了半夜自己回家一次,我记住路线以后才敢救你。");
            this.monitor.Log("[叙事] 已发布回家路线练习任务", LogLevel.Info);
        }

        public void CompleteWateringLesson()
        {
            var quest = this.state.GetOrCreateQuest(WateringLessonQuestId, WateringLessonTemplateId);
            if (quest.State is QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
            {
                this.ApplyWateringReward(quest);
                return;
            }

            quest.Progress = quest.Target > 0 ? quest.Target : WateringLessonTarget;
            quest.Target = quest.Target > 0 ? quest.Target : WateringLessonTarget;
            quest.State = QuestLifecycleState.Completed;
            quest.CompletedGameDate = NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:completed");
            this.state.SetFlag("watering_lesson_completed");
            this.state.AddSemanticEvent("WateringTutorialCompleted");
            this.questLog.Complete(quest);
            this.ApplyWateringReward(quest);
        }

        public void CompleteHarvestLesson()
        {
            this.CompleteAbilityLesson(
                HarvestLessonQuestId,
                HarvestLessonTemplateId,
                HarvestLessonTarget,
                "harvest_lesson_completed",
                "HarvestTutorialCompleted",
                quest => this.ApplyAbilityReward(
                    quest,
                    AbilityRegistry.HarvestAll,
                    HarvestLessonRewardId,
                    "ability_harvest_all_unlocked",
                    "[剧情] 豆包通过收割练习学会了在请求后帮农夫批量收成熟作物。",
                    "行,成熟和没熟我分得清了。以后你开口,我只收该收的。"));
        }

        public void CompleteFishingLesson()
        {
            this.CompleteAbilityLesson(
                FishingLessonQuestId,
                FishingLessonTemplateId,
                FishingLessonTarget,
                "fishing_lesson_completed",
                "FishingTutorialCompleted",
                quest => this.ApplyAbilityReward(
                    quest,
                    AbilityRegistry.FishHelp,
                    FishingLessonRewardId,
                    "ability_fish_help_unlocked",
                    "[剧情] 豆包通过浮标练习学会了在请求后帮农夫完成下一次钓鱼收杆。",
                    "哼,浮标那点小动作我看明白了。下一杆你叫我,我帮你盯着。"));
        }

        public void CompleteCombatLesson()
        {
            this.CompleteAbilityLesson(
                CombatLessonQuestId,
                CombatLessonTemplateId,
                CombatLessonTarget,
                "combat_lesson_completed",
                "CombatTutorialCompleted",
                quest => this.ApplyAbilityReward(
                    quest,
                    AbilityRegistry.MineCombat,
                    CombatLessonRewardId,
                    "ability_mine_combat_unlocked",
                    "[剧情] 豆包通过矿洞胆量练习学会了在请求后短时间协助战斗。",
                    "我才不是怕了。下次矿洞里你喊我,我会帮你挡一会儿。"));
        }

        public void CompleteRescueLesson()
        {
            this.CompleteAbilityLesson(
                RescueLessonQuestId,
                RescueLessonTemplateId,
                RescueLessonTarget,
                "rescue_lesson_completed",
                "RescueTutorialCompleted",
                quest => this.ApplyAbilityReward(
                    quest,
                    AbilityRegistry.RescueHome,
                    RescueLessonRewardId,
                    "ability_rescue_home_unlocked",
                    "[剧情] 豆包通过深夜回家练习记住了农夫的回家路线,学会了紧急送农夫回床。",
                    "路线我记住了。以后你真撑不住的时候,我可以把你带回床上,但别故意熬夜考我。"));
        }

        private void ApplyWateringReward(QuestInstance quest)
        {
            string txId = $"{quest.QuestId}:{WateringLessonRewardId}";
            if (this.state.HasRewardTransaction(txId)) return;

            this.abilities.Unlock(AbilityRegistry.WaterAll, quest.QuestId);
            this.state.RelationshipPoints += 10;
            this.state.SetFlag("ability_water_all_unlocked");
            this.state.AddRewardTransaction(txId, quest.QuestId, WateringLessonRewardId);
            quest.State = QuestLifecycleState.Rewarded;
            quest.RewardedGameDate = NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:rewarded:{WateringLessonRewardId}");

            this.recordBond(+2, "[剧情] 豆包通过浇水练习学会了在请求后帮农夫批量浇水。");
            this.speak("行,我懂了。以后你开口让我浇水,我会先看清楚再动手。只限浇水啊,别得寸进尺。");
            this.monitor.Log("[奖励] 解锁请求式批量浇水", LogLevel.Info);
        }

        private void CompleteAbilityLesson(
            string questId,
            string templateId,
            int target,
            string completedFlag,
            string completedEvent,
            Action<QuestInstance> applyReward)
        {
            var quest = this.state.GetOrCreateQuest(questId, templateId);
            if (quest.State is QuestLifecycleState.Completed or QuestLifecycleState.Rewarded)
            {
                applyReward(quest);
                return;
            }

            quest.Progress = quest.Target > 0 ? quest.Target : target;
            quest.Target = quest.Target > 0 ? quest.Target : target;
            quest.State = QuestLifecycleState.Completed;
            quest.CompletedGameDate = NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:completed");
            this.state.SetFlag(completedFlag);
            this.state.AddSemanticEvent(completedEvent);
            this.questLog.Complete(quest);
            applyReward(quest);
        }

        private void ApplyAbilityReward(
            QuestInstance quest,
            string abilityId,
            string rewardId,
            string abilityFlag,
            string historyLine,
            string speakLine)
        {
            string txId = $"{quest.QuestId}:{rewardId}";
            if (this.state.HasRewardTransaction(txId)) return;

            this.abilities.Unlock(abilityId, quest.QuestId);
            this.state.RelationshipPoints += 10;
            this.state.SetFlag(abilityFlag);
            this.state.AddRewardTransaction(txId, quest.QuestId, rewardId);
            quest.State = QuestLifecycleState.Rewarded;
            quest.RewardedGameDate = NarrativeClock.GameDateKey();
            quest.History.Add($"{NarrativeClock.GameDateKey()}:rewarded:{rewardId}");

            this.recordBond(+2, historyLine);
            this.speak(speakLine);
            this.monitor.Log($"[奖励] 解锁能力 {abilityId}", LogLevel.Info);
        }

        private void AdvanceQuest(string questId, string marker, Action complete)
        {
            var quest = this.state.FindQuest(questId);
            if (quest == null || quest.State != QuestLifecycleState.Active) return;

            quest.Progress = Math.Min(quest.Target, quest.Progress + 1);
            quest.History.Add($"{NarrativeClock.GameDateKey()}:{marker}:{quest.Progress}");
            this.monitor.Log($"[任务] {quest.Title} 进度 {quest.Progress}/{quest.Target}", LogLevel.Info);
            this.questLog.Upsert(quest);

            if (quest.Progress >= quest.Target)
                complete();
        }

        private bool HasActiveUnlockQuest()
        {
            foreach (string questId in UnlockQuestIds)
            {
                var quest = this.state.FindQuest(questId);
                if (quest?.State == QuestLifecycleState.Active)
                    return true;
            }

            return false;
        }

        private void TryProgressRescueLesson()
        {
            if (Game1.timeOfDay < 2400) return;
            if (!this.IsAtPlayerHome()) return;
            this.AdvanceQuest(RescueLessonQuestId, "late_home", this.CompleteRescueLesson);
        }

        private bool IsWateringToolUse(ButtonPressedEventArgs e)
        {
            if (Game1.activeClickableMenu != null || Game1.eventUp) return false;
            if (Game1.player?.CurrentTool is not WateringCan) return false;
            if (e.Button != SButton.MouseLeft && e.Button != SButton.C && e.Button != SButton.ControllerA)
                return false;

            string loc = Game1.player.currentLocation?.NameOrUniqueName ?? "";
            return loc.Contains("Farm", StringComparison.OrdinalIgnoreCase)
                || loc.Equals("Greenhouse", StringComparison.OrdinalIgnoreCase);
        }

        private bool IsHarvestAttempt(ButtonPressedEventArgs e)
        {
            if (Game1.activeClickableMenu != null || Game1.eventUp) return false;
            if (e.Button != SButton.MouseLeft && e.Button != SButton.C && e.Button != SButton.ControllerA)
                return false;

            var location = Game1.player?.currentLocation;
            if (location == null) return false;
            if (!IsFarmOrGreenhouse(location)) return false;

            Vector2 tile = e.Cursor.Tile;
            try
            {
                if (location.terrainFeatures.TryGetValue(tile, out var feature)
                    && feature is HoeDirt dirt
                    && dirt.crop != null
                    && dirt.readyForHarvest())
                {
                    return true;
                }

                if (location.objects.TryGetValue(tile, out var obj)
                    && obj is IndoorPot pot
                    && pot.hoeDirt?.Value is HoeDirt potDirt
                    && potDirt.crop != null
                    && potDirt.readyForHarvest())
                {
                    return true;
                }
            }
            catch (Exception ex)
            {
                this.monitor.Log($"[任务] 收割检测失败: {ex.Message}", LogLevel.Trace);
            }

            return false;
        }

        private bool IsWeaponUseInMine(ButtonPressedEventArgs e)
        {
            if (Game1.activeClickableMenu != null || Game1.eventUp) return false;
            if (e.Button != SButton.MouseLeft && e.Button != SButton.C && e.Button != SButton.ControllerA)
                return false;
            if (Game1.player?.CurrentTool is not MeleeWeapon) return false;
            return this.IsMineLocation();
        }

        private static bool IsFish(Item item)
        {
            return item is StardewValley.Object obj && obj.Category == StardewValley.Object.FishCategory;
        }

        private bool IsSafeIdleWindow()
        {
            if (Game1.activeClickableMenu != null) return false;
            if (Game1.eventUp) return false;
            if (Game1.player == null) return false;
            if (Game1.player.health > 0 && Game1.player.health < Game1.player.maxHealth * 0.35) return false;
            if (Game1.currentLocation == null) return false;
            return IsFarmOrGreenhouse(Game1.currentLocation);
        }

        private bool IsSafeGeneralWindow()
        {
            if (Game1.activeClickableMenu != null) return false;
            if (Game1.eventUp) return false;
            if (Game1.player == null) return false;
            if (Game1.player.health > 0 && Game1.player.health < Game1.player.maxHealth * 0.35) return false;
            return Game1.currentLocation != null;
        }

        private static bool IsFarmOrGreenhouse(GameLocation location)
        {
            string name = location.NameOrUniqueName ?? "";
            return name.Contains("Farm", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Greenhouse", StringComparison.OrdinalIgnoreCase);
        }

        private bool IsMineLocation()
        {
            string name = Game1.currentLocation?.NameOrUniqueName ?? "";
            return name.Contains("Mine", StringComparison.OrdinalIgnoreCase)
                || name.Contains("SkullCave", StringComparison.OrdinalIgnoreCase)
                || name.Contains("Volcano", StringComparison.OrdinalIgnoreCase);
        }

        private bool IsAtPlayerHome()
        {
            var who = Game1.player;
            var location = who?.currentLocation;
            if (who == null || location == null) return false;

            try
            {
                var home = Utility.getHomeOfFarmer(who);
                if (home != null && ReferenceEquals(home, location)) return true;
                if (home != null && home.NameOrUniqueName == location.NameOrUniqueName) return true;
            }
            catch
            {
                // Fallback below.
            }

            string name = location.NameOrUniqueName ?? "";
            return name.Contains("FarmHouse", StringComparison.OrdinalIgnoreCase)
                || name.Contains("Cabin", StringComparison.OrdinalIgnoreCase);
        }

        private static int CountRipeCrops()
        {
            GameLocation? location = Game1.currentLocation;
            if (location == null) return 0;
            int count = 0;
            foreach (var pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt { crop: not null } dirt && dirt.readyForHarvest()) count++;
            }
            foreach (var pair in location.Objects.Pairs)
            {
                if (pair.Value is IndoorPot pot
                    && pot.hoeDirt.Value is HoeDirt { crop: not null } dirt
                    && dirt.readyForHarvest()) count++;
            }
            return count;
        }

        private bool HasCompanion()
        {
            var items = Game1.player?.trinketItems;
            return items != null && items.Count > 0 && items[0] != null;
        }

        private static long Now() => Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
    }
}

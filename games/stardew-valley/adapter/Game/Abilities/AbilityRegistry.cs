using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using StardewModdingAPI;
using StardewValley;
using StardewAgentMod.Game.Narrative;

namespace StardewAgentMod.Game.Abilities
{
    internal enum AbilityPermissionLevel
    {
        ObserveOnly,
        SuggestOnly,
        ConfirmBeforeAction,
        AutoLowRisk,
        AutoEmergency
    }

    internal sealed class AbilityDefinition
    {
        public string AbilityId { get; init; } = "";
        public string Intent { get; init; } = "";
        public string DisplayName { get; init; } = "";
        public AbilityPermissionLevel PermissionLevel { get; init; }
        public int CooldownMinutes { get; init; }
        public int Cost { get; init; } = 1;
        public bool RequiresUnlock { get; init; } = true;
        public string LockedLine { get; init; } = "我还没学会这个。";
    }

    internal sealed class AbilityCheckResult
    {
        public bool Allowed { get; init; }
        public string ReasonLine { get; init; } = "";
        public AbilityDefinition? Definition { get; init; }
    }

    internal sealed class AbilityRegistry
    {
        public const string WaterAll = "water_all";
        public const string PlantSeedsAll = "plant_seeds_all";
        public const string HarvestAll = "harvest_all";
        public const string SpeedGrow = "speed_grow";
        public const string ClearDebris = "clear_debris";
        public const string FlightTakeoff = "flight_takeoff";
        public const string FlightLand = "flight_land";
        public const string FishHelp = "fish_help";
        public const string MineCombat = "mine_combat";
        public const string RescueHome = "rescue_home";

        private readonly IMonitor monitor;
        private readonly CompanionGrowthState state;
        private readonly CompanionGrowthSystem growth;
        private readonly Func<bool> unlockAllForTesting;
        private readonly Dictionary<string, AbilityDefinition> byIntent = new();

        public AbilityRegistry(
            IMonitor monitor,
            CompanionGrowthState state,
            CompanionGrowthSystem growth,
            Func<bool>? unlockAllForTesting = null)
        {
            this.monitor = monitor;
            this.state = state;
            this.growth = growth;
            this.unlockAllForTesting = unlockAllForTesting ?? (() => false);
            this.RegisterDefaults();
            this.EnsureStateEntries();
        }

        public IEnumerable<AbilityDefinition> Definitions => this.byIntent.Values;

        private void RegisterDefaults()
        {
            this.Register(new AbilityDefinition
            {
                AbilityId = WaterAll,
                Intent = WaterAll,
                DisplayName = "请求后批量浇水",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                CooldownMinutes = 0,
                Cost = 1,
                LockedLine = "我还没学会安全浇水。先完成《豆包的浇水练习》,在农场或温室用喷壶示范 5 次,之后你叫我我再帮。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = PlantSeedsAll,
                Intent = PlantSeedsAll,
                DisplayName = "请求后批量播种",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 1,
                RequiresUnlock = false,
                LockedLine = "播种这事我还没敢上手。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = HarvestAll,
                Intent = HarvestAll,
                DisplayName = "请求后批量收割",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 1,
                LockedLine = "我还不敢收作物,怕把没熟的苗也拔了。先完成《豆包的收割练习》,亲手收几次成熟作物给我看,我学会后再帮你。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = SpeedGrow,
                Intent = SpeedGrow,
                DisplayName = "请求后催熟作物",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 1,
                RequiresUnlock = false,
                LockedLine = "我现在还不敢乱催苗,怕把地里弄成一锅粥。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = ClearDebris,
                Intent = ClearDebris,
                DisplayName = "清理周围自然障碍",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 1,
                RequiresUnlock = false,
                LockedLine = "我还没学会安全清理农场。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = FlightTakeoff,
                Intent = FlightTakeoff,
                DisplayName = "在室外主地图起飞",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 0,
                RequiresUnlock = false,
                LockedLine = "我还没学会怎么安全带你起飞。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = FlightLand,
                Intent = FlightLand,
                DisplayName = "寻找安全地块缓慢落地",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 0,
                RequiresUnlock = false,
                LockedLine = "我还没学会怎么安全降落。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = FishHelp,
                Intent = FishHelp,
                DisplayName = "钓鱼协助",
                PermissionLevel = AbilityPermissionLevel.ConfirmBeforeAction,
                Cost = 1,
                LockedLine = "浮标我还看不准。先完成《豆包的浮标练习》,你拿鱼竿钓到几条鱼让我观察,我学会后再帮下一杆。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = MineCombat,
                Intent = MineCombat,
                DisplayName = "矿洞战斗协助",
                PermissionLevel = AbilityPermissionLevel.AutoLowRisk,
                Cost = 1,
                LockedLine = "打怪这事我还不敢乱冲。先完成《豆包的矿洞胆量练习》,在矿洞里亲自挥几次武器给我看,我再帮你挡一会儿。"
            });
            this.Register(new AbilityDefinition
            {
                AbilityId = RescueHome,
                Intent = RescueHome,
                DisplayName = "凌晨紧急救助",
                PermissionLevel = AbilityPermissionLevel.AutoEmergency,
                Cost = 1,
                LockedLine = "把你送回家是大事,我还没记住路线。先完成《豆包的回家路线练习》,半夜后自己回家一次,以后撑不住再叫我。"
            });
        }

        private void Register(AbilityDefinition definition)
        {
            if (string.IsNullOrWhiteSpace(definition.Intent)) return;
            this.byIntent[definition.Intent] = definition;
        }

        public void EnsureStateEntries()
        {
            foreach (var definition in this.byIntent.Values)
                this.state.GetOrCreateAbility(definition.AbilityId);
        }

        public AbilityCheckResult CanUseIntent(string intent)
        {
            if (!this.byIntent.TryGetValue(intent, out var definition))
            {
                return new AbilityCheckResult
                {
                    Allowed = false,
                    ReasonLine = "这个动作不在我能做的清单里。"
                };
            }

            bool allUnlocked = this.unlockAllForTesting();
            var ability = this.state.GetOrCreateAbility(definition.AbilityId);
            if (!allUnlocked && definition.RequiresUnlock && !ability.Unlocked)
            {
                return new AbilityCheckResult
                {
                    Allowed = false,
                    Definition = definition,
                    ReasonLine = definition.LockedLine
                };
            }

            if (!allUnlocked && intent == FishHelp && this.growth.Form != CompanionForm.Fishing)
            {
                return new AbilityCheckResult
                {
                    Allowed = false,
                    Definition = definition,
                    ReasonLine = "这项协助还需要小汤圆成长为钓鱼型。"
                };
            }
            if (!allUnlocked && (intent == MineCombat || intent == RescueHome) && this.growth.Form != CompanionForm.Combat)
            {
                return new AbilityCheckResult
                {
                    Allowed = false,
                    Definition = definition,
                    ReasonLine = "这项协助还需要小汤圆成长为战斗型。"
                };
            }

            if (definition.CooldownMinutes > 0 && ability.LastUsedGameDate != null)
            {
                int now = (int)(Game1.stats?.DaysPlayed ?? 0);
                if (ability.LastUsedDaysPlayed > 0 && now - ability.LastUsedDaysPlayed < definition.CooldownMinutes / 60)
                {
                    return new AbilityCheckResult
                    {
                        Allowed = false,
                        Definition = definition,
                        ReasonLine = "这招刚用过,让我缓缓。"
                    };
                }
            }

            return new AbilityCheckResult { Allowed = true, Definition = definition };
        }

        public bool Unlock(string abilityId, string source)
        {
            var ability = this.state.GetOrCreateAbility(abilityId);
            if (ability.Unlocked) return false;

            ability.Unlocked = true;
            ability.UnlockedBy = source;
            ability.UnlockedAtGameDate = NarrativeClock.GameDateKey();
            this.monitor.Log($"[能力] 解锁 {abilityId} via {source}", LogLevel.Info);
            return true;
        }

        public bool Lock(string abilityId)
        {
            var ability = this.state.GetOrCreateAbility(abilityId);
            if (!ability.Unlocked) return false;

            ability.Unlocked = false;
            ability.UnlockedBy = "";
            ability.UnlockedAtGameDate = null;
            this.monitor.Log($"[能力] 锁定 {abilityId}", LogLevel.Info);
            return true;
        }

        public void NoteUsed(string abilityId)
        {
            var ability = this.state.GetOrCreateAbility(abilityId);
            ability.LastUsedGameDate = NarrativeClock.GameDateKey();
            ability.LastUsedDaysPlayed = (int)(Game1.stats?.DaysPlayed ?? 0);
        }

        public IReadOnlyDictionary<string, bool> Snapshot()
        {
            bool allUnlocked = this.unlockAllForTesting();
            return this.byIntent.Values.ToDictionary(
                definition => definition.Intent,
                definition => allUnlocked
                    || !definition.RequiresUnlock
                    || this.state.GetOrCreateAbility(definition.AbilityId).Unlocked,
                StringComparer.Ordinal);
        }

        public string BuildPromptSection()
        {
            bool allUnlocked = this.unlockAllForTesting();
            var sb = new StringBuilder();
            sb.AppendLine("\n\n[能力解锁状态]");
            foreach (var definition in this.byIntent.Values.OrderBy(v => v.DisplayName))
            {
                var ability = this.state.GetOrCreateAbility(definition.AbilityId);
                sb.Append("  - ");
                sb.Append(definition.DisplayName);
                sb.Append(": ");
                sb.Append(allUnlocked || !definition.RequiresUnlock || ability.Unlocked ? "已解锁" : "未解锁");
                sb.AppendLine();
            }
            sb.Append(allUnlocked
                ? "当前为验收测试模式：所有已移植能力均可调用，但地点、目标、体力与安全规则仍然有效。"
                : "未解锁的能力不能假装会做;玩家请求时要角色化拒绝,并说明需要先通过剧情/练习学会。");
            return sb.ToString();
        }
    }
}

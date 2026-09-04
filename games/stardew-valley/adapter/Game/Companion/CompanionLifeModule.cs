using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewAgentMod.Contracts;
using StardewAgentMod.Game.Abilities;
using StardewAgentMod.Game.Narrative;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;

namespace StardewAgentMod.Game.Companion;

/// <summary>
/// 陪伴生活系统的深 Module：封装关系、心情、怪癖、仪式、心愿、日记与技能成长存档。
/// 它只发出结构化的语言生成请求；网络与 DSH 调用由 Composition Root 接线。
/// </summary>
internal sealed class CompanionLifeModule
{
    private const string SaveDataKey = "qimidandapigu.StardewAgent.companion-life-v1";
    private const long WishAnnouncementDelayTicks = 20 * 10_000_000L;
    private const long IdleThresholdTicks = 30 * 10_000_000L;

    private static readonly string[] HappyIdleCues = { "yoba", "newRecipe", "give_gift", "achievement", "discoverMineral" };
    private static readonly string[] NeutralIdleCues = { "yoba", "select", "smallSelect", "shwip", "tinyWhip" };
    private static readonly string[] GrumpyIdleCues = { "cancel", "slimedead", "thudStep", "sandyStep" };

    private readonly IModHelper helper;
    private readonly IMonitor monitor;
    private readonly IPresentationSink presentation;
    private readonly CompanionGrowthState skillGrowth;
    private readonly AbilityRegistry abilities;
    private readonly Func<bool> ritualsEnabled;
    private readonly Func<bool> proactiveEnabled;
    private readonly Func<bool> diaryEnabled;
    private readonly Func<bool> idleEnabled;
    private readonly Func<bool> isBusy;
    private readonly Dictionary<string, CompanionCompositionRequest> pendingCompositions = new(StringComparer.Ordinal);

    private CompanionLifeData data = new();
    private QuirkSet quirks = QuirkSet.Roll("default");
    private long wishAnnouncementAt;
    private string? observedNpc;
    private DialogueBox? observedDialogue;
    private string? pendingInterjection;
    private long pendingInterjectionAt;
    private long lastSpokeAt;
    private DateTime lastHealthWarningUtc = DateTime.MinValue;
    private DateTime lastStaminaWarningUtc = DateTime.MinValue;
    private bool wasEventUp;
    private int eventCommentsToday;

    public event Action<CompanionCompositionRequest>? CompositionRequested;
    public event Action<string>? SpeechRequested;

    public QuestService Quests { get; }

    public int Mood => this.data.Mood;

    public CompanionLifeModule(
        IModHelper helper,
        IMonitor monitor,
        IPresentationSink presentation,
        CompanionGrowthState skillGrowth,
        AbilityRegistry abilities,
        Func<bool> ritualsEnabled,
        Func<bool> proactiveEnabled,
        Func<bool> diaryEnabled,
        Func<bool> idleEnabled,
        Func<bool> isBusy)
    {
        this.helper = helper;
        this.monitor = monitor;
        this.presentation = presentation;
        this.skillGrowth = skillGrowth;
        this.abilities = abilities;
        this.ritualsEnabled = ritualsEnabled;
        this.proactiveEnabled = proactiveEnabled;
        this.diaryEnabled = diaryEnabled;
        this.idleEnabled = idleEnabled;
        this.isBusy = isBusy;
        this.Quests = new QuestService(
            monitor,
            skillGrowth,
            abilities,
            new QuestLogBridge(monitor),
            this.RecordBond,
            () => Context.IsWorldReady,
            text => this.PresentLocalLine(text));
    }

    public void OnSaveLoaded(string saveIdentity)
    {
        CompanionLifeData loaded = this.helper.Data.ReadSaveData<CompanionLifeData>(SaveDataKey) ?? new CompanionLifeData();
        loaded.Daily ??= new CompanionDailyState();
        loaded.Diary ??= new List<CompanionDiaryEntry>();
        loaded.RecentEvents ??= new List<string>();
        loaded.SkillGrowth ??= new CompanionGrowthState();
        this.data = loaded;
        this.skillGrowth.CopyFrom(loaded.SkillGrowth);
        this.data.SkillGrowth = this.skillGrowth;
        this.abilities.EnsureStateEntries();
        this.quirks = QuirkSet.Roll(saveIdentity);

        if (!this.data.HasMet)
        {
            this.data.HasMet = true;
            this.data.FirstMetDaysPlayed = (int)(Game1.stats?.DaysPlayed ?? 0);
            this.RecordEvent("第一次正式成为农夫的同伴");
        }

        this.EnsureToday();
        this.Quests.SyncQuestLog();
        this.lastSpokeAt = Now();
        this.wasEventUp = Game1.eventUp;
    }

    public void OnSaving()
    {
        if (!Context.IsWorldReady) return;
        this.data.SkillGrowth = this.skillGrowth;
        this.helper.Data.WriteSaveData(SaveDataKey, this.data);
    }

    public void Reset()
    {
        this.data = new CompanionLifeData();
        this.skillGrowth.CopyFrom(new CompanionGrowthState());
        this.pendingCompositions.Clear();
        this.observedNpc = null;
        this.observedDialogue = null;
        this.pendingInterjection = null;
        this.wishAnnouncementAt = 0;
        this.pendingInterjectionAt = 0;
        this.lastSpokeAt = 0;
        this.lastHealthWarningUtc = DateTime.MinValue;
        this.lastStaminaWarningUtc = DateTime.MinValue;
        this.wasEventUp = false;
        this.eventCommentsToday = 0;
    }

    public void OnDayStarted(object? sender, DayStartedEventArgs e)
    {
        this.ResetDailyState();
        this.eventCommentsToday = 0;
        this.wasEventUp = Game1.eventUp;
        if (this.proactiveEnabled()) this.SelectDailyWish();
        else this.data.Daily.Wish = null;
        if (!this.ritualsEnabled()) return;

        int daysTogether = this.DaysTogether();
        string? transition = RelationshipTransitionLine(daysTogether);
        this.RequestComposition(
            "ritual.morning",
            transition is null
                ? $"今天是{DisplayDate()}，天气是{WeatherText()}，你和农夫相处了{daysTogether}天。请以小汤圆的口吻说一句自然、简短且不重复模板的早安。"
                : $"今天是关系阶段变化的重要日子。请保持以下意思并自然说给农夫：{transition}",
            transition ?? "早。今天也一起慢慢来。");
    }

    public void OnDayEnding(object? sender, DayEndingEventArgs e)
    {
        CompanionWishState? wish = this.data.Daily.Wish;
        if (this.proactiveEnabled() && wish is { Announced: true, Completed: false })
        {
            this.RecordBond(-1, $"今日心愿没有完成：{wish.Description}");
        }
        if (this.ritualsEnabled())
        {
            bool passedOut = Game1.timeOfDay >= 2600;
            string fallback = passedOut
                ? "都说了别硬撑。明天醒了再跟你算账。"
                : this.data.Mood >= 0 ? "晚安。明天也别把自己累坏。" : "睡吧。我还没消气，但明天再说。";
            this.RequestComposition(
                "ritual.goodnight",
                $"农夫正在{(passedOut ? "凌晨两点晕倒" : "正常睡觉")}，小汤圆当前心情是{MoodLabel(this.data.Mood)}。请说一句简短晚安，不超过二十个汉字。",
                fallback);
        }
        if (this.diaryEnabled()) this.RequestDiaryIfNeeded();
    }

    public void OnTimeChanged(object? sender, TimeChangedEventArgs e)
    {
        if (!Context.IsWorldReady) return;
        if (this.diaryEnabled() && e.NewTime >= 2200) this.RequestDiaryIfNeeded();
        if (this.ritualsEnabled() && e.NewTime >= 2500 && this.MarkRitual("late-night"))
        {
            this.RequestComposition(
                "ritual.late-night",
                "已经凌晨一点，农夫仍未睡觉。请以担心但嘴硬的小汤圆口吻提醒一句，不超过二十个汉字。",
                "都一点了，别再硬撑，快回去睡。" );
        }
    }

    public void OnOneSecondUpdate(object? sender, OneSecondUpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady) return;
        this.Quests.OnOneSecondUpdate(sender, e);

        long now = Now();
        this.UpdateSocialReactions(now);
        if (this.proactiveEnabled())
        {
            this.TryProactiveTriggers();
            this.UpdateWish(now);
        }
        if (this.idleEnabled()) this.TryIdle(now);
    }

    private void UpdateWish(long now)
    {
        CompanionWishState? wish = this.data.Daily.Wish;
        if (wish is null) return;
        if (!wish.Announced && now >= this.wishAnnouncementAt && Game1.activeClickableMenu is null && !Game1.eventUp)
        {
            wish.Announced = true;
            this.RequestComposition(
                "wish.announce",
                $"小汤圆今天的心愿是“{wish.Description}”。请由她自然说出这个心愿，一句话，不要提系统或任务。",
                $"今天我想{wish.Description}。就这一次啊。" );
        }
        if (wish.Announced && !wish.Completed && this.IsWishComplete(wish.Id))
        {
            wish.Completed = true;
            this.RecordBond(+2, $"完成今日心愿：{wish.Description}");
            this.RequestComposition(
                "wish.completed",
                $"农夫刚刚完成了小汤圆的心愿“{wish.Description}”。请让她高兴地回应一句，不超过二十个汉字。",
                "嘿嘿，真做到了。今天算你厉害。" );
        }
    }

    public void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        this.Quests.OnButtonPressed(sender, e);
    }

    public void OnInventoryChanged(object? sender, InventoryChangedEventArgs e)
    {
        this.Quests.OnInventoryChanged(sender, e);
    }

    public void OnWarped(object? sender, WarpedEventArgs e)
    {
        if (!e.IsLocalPlayer || !Context.IsWorldReady) return;
        string location = e.NewLocation.NameOrUniqueName;
        if (!this.data.Daily.Locations.Contains(location, StringComparer.OrdinalIgnoreCase))
            this.data.Daily.Locations.Add(location);

        if (e.NewLocation is MineShaft shaft)
            this.data.Daily.MaxMineLevel = Math.Max(this.data.Daily.MaxMineLevel, shaft.mineLevel);

        if (!this.ritualsEnabled()) return;

        string? ritual = null;
        string? fallback = null;
        bool skullCavern = e.NewLocation.NameOrUniqueName.Contains("Skull", StringComparison.OrdinalIgnoreCase)
            || e.NewLocation is MineShaft skullShaft && skullShaft.mineLevel > 120;
        if (skullCavern && this.MarkRitual("skull-cavern"))
        {
            ritual = "农夫今天第一次进入骷髅洞。请让小汤圆明显紧张地提醒一句，简短但别装镇定。";
            fallback = "骷髅洞可不是普通矿井。跟紧我，别乱冲。";
        }
        else if (e.NewLocation is MineShaft && this.MarkRitual("mine"))
        {
            ritual = "农夫今天第一次进入矿洞。请让小汤圆简短提醒安全，语气关心但不要说教。";
            fallback = "矿洞里小心点，别逞强。";
        }
        else if (e.NewLocation.IsOutdoors && Game1.isLightning && this.MarkRitual("storm"))
        {
            ritual = $"小汤圆天生害怕{this.quirks.Fear}，现在农夫在雷暴天走到户外。请让她紧张地说一句。";
            fallback = "打雷呢，今天少在外面晃。";
        }
        else if (e.NewLocation.IsOutdoors && Game1.isSnowing && this.MarkRitual("snow"))
        {
            ritual = "今天第一次走到雪天户外。请让小汤圆兴奋地说一句看雪的话。";
            fallback = "下雪了诶！你看，好多雪。";
        }
        else if (e.NewLocation.IsOutdoors && Game1.isRaining && this.MarkRitual("rain"))
        {
            ritual = "今天第一次走到雨天户外。请让小汤圆说一句贴合农场生活的雨天短评。";
            fallback = "下雨天田不用浇，算是赚了。";
        }
        if (ritual is not null)
            this.RequestComposition("ritual.warp", ritual, fallback ?? "小心点。" );
    }

    public void OnMenuChanged(object? sender, MenuChangedEventArgs e)
    {
        if (!Context.IsWorldReady) return;
        if (!this.proactiveEnabled()) return;
        if (e.NewMenu is DialogueBox dialogue)
        {
            this.observedDialogue = dialogue;
            this.observedNpc = dialogue.characterDialogue?.speaker?.displayName
                ?? Game1.currentSpeaker?.displayName;
            if (!string.IsNullOrWhiteSpace(this.observedNpc))
            {
                this.pendingInterjection = string.Equals(this.observedNpc, this.quirks.DislikedNpc, StringComparison.OrdinalIgnoreCase)
                    ? $"又跟{this.observedNpc}聊。啧。"
                    : "嗯嗯，你们继续，我听着呢。";
                this.pendingInterjectionAt = Now() + 12_000_000L;
            }
            return;
        }
        if (e.OldMenu is not DialogueBox) return;

        string? npc = this.observedNpc;
        this.observedNpc = null;
        this.observedDialogue = null;
        this.pendingInterjection = null;
        if (e.NewMenu is not null || string.IsNullOrWhiteSpace(npc)) return;

        string relationHint = string.Equals(npc, this.quirks.FavoriteNpc, StringComparison.OrdinalIgnoreCase)
            ? "小汤圆私下很喜欢这个人"
            : string.Equals(npc, this.quirks.DislikedNpc, StringComparison.OrdinalIgnoreCase)
                ? "小汤圆不太喜欢这个人"
                : "小汤圆对此人没有特殊偏见";
        this.RequestComposition(
            "social.after-dialogue",
            $"农夫刚和 {npc} 聊完天，{relationHint}。请让小汤圆在旁边自然搭一句，不超过二十个汉字。",
            $"和{npc}聊完啦？那走吧。" );
    }

    public void NoteConversation(string text)
    {
        if (!Context.IsWorldReady || string.IsNullOrWhiteSpace(text)) return;
        this.data.Daily.Conversations++;
        this.skillGrowth.RelationshipPoints = Math.Max(0, this.skillGrowth.RelationshipPoints + 1);
        this.RecordEvent("与农夫聊了一次天");
        this.NoteSpoken();
    }

    public void NoteSpoken()
    {
        this.lastSpokeAt = Now();
    }

    public void Interact(bool friendly)
    {
        if (!Context.IsWorldReady) return;
        if (friendly)
        {
            this.data.Daily.Pokes++;
            this.RecordBond(+1, "农夫友好地戳了戳小汤圆");
            this.PresentLocalLine("嘿，痒！");
        }
        else
        {
            this.data.Daily.Hits++;
            this.RecordBond(-3, "农夫用力打了小汤圆");
            this.PresentLocalLine("痛！你干嘛！", "companion.alert");
        }
    }

    public void RecordBond(int moodDelta, string eventText)
    {
        this.data.Mood = Math.Clamp(this.data.Mood + moodDelta, -10, 10);
        int relationshipDelta = moodDelta > 0 ? moodDelta * 2 : moodDelta;
        this.skillGrowth.RelationshipPoints = Math.Max(0, this.skillGrowth.RelationshipPoints + relationshipDelta);
        this.RecordEvent(eventText);
        this.presentation.Present(new PresentationEvent(
            "mood.changed",
            MoodLabel(this.data.Mood),
            new Dictionary<string, object?>
            {
                ["mood"] = this.data.Mood,
                ["relationshipPoints"] = this.skillGrowth.RelationshipPoints,
            }));
    }

    public CompanionLifeSnapshot GetSnapshot()
    {
        int daysTogether = this.DaysTogether();
        QuestInstance? active = this.skillGrowth.Quests.FirstOrDefault(quest => quest.State == QuestLifecycleState.Active);
        CompanionWishState? wish = this.data.Daily.Wish;
        return new CompanionLifeSnapshot(
            this.data.Mood,
            MoodLabel(this.data.Mood),
            this.skillGrowth.RelationshipPoints,
            RelationshipStage(daysTogether),
            daysTogether,
            this.quirks.Snapshot(),
            wish is null ? null : new CompanionWishSnapshot(wish.Id, wish.Description, wish.Announced, wish.Completed),
            this.data.Diary.Count,
            active?.Title);
    }

    public List<CompanionDiarySnapshot> ReadDiaryEntries()
    {
        return this.data.Diary.Select(entry => new CompanionDiarySnapshot(entry.Date, entry.Text)).ToList();
    }

    public void ApplyComposition(string requestId, string? generatedText)
    {
        if (!this.pendingCompositions.Remove(requestId, out CompanionCompositionRequest? request)) return;
        string text = string.IsNullOrWhiteSpace(generatedText) ? request.Fallback : generatedText.Trim();
        if (request.SaveAsDiary)
        {
            CompanionDiaryEntry? entry = this.data.Diary.LastOrDefault(item => item.Date == DisplayDate());
            if (entry is null)
            {
                entry = new CompanionDiaryEntry { Date = DisplayDate() };
                this.data.Diary.Add(entry);
            }
            entry.Text = text;
            entry.GeneratedByHarness = !string.IsNullOrWhiteSpace(generatedText);
            this.presentation.Present(new PresentationEvent("diary.updated", "小汤圆写完了今天的日记。"));
            return;
        }
        this.presentation.Present(new PresentationEvent("companion.message", text));
        this.NoteSpoken();
        if (request.Speak && string.IsNullOrWhiteSpace(generatedText))
            this.SpeechRequested?.Invoke(text);
    }

    private void ResetDailyState()
    {
        this.data.Daily = new CompanionDailyState
        {
            Date = NarrativeClock.GameDateKey(),
            StartMoney = Game1.player?.Money ?? 0,
        };
    }

    private void EnsureToday()
    {
        if (this.data.Daily.Date == NarrativeClock.GameDateKey()) return;
        this.ResetDailyState();
        if (this.proactiveEnabled()) this.SelectDailyWish();
    }

    private void SelectDailyWish()
    {
        (string Id, string Description)[] pool =
        {
            ("visit-beach", "去海边听听浪"),
            ("visit-town", "去镇上凑凑热闹"),
            ("visit-forest", "去森林里转转"),
            ("visit-mountain", "去山上看看"),
            ("go-mining", "看看你下矿挖点亮晶晶的东西"),
            ("earn-1000", "看你今天赚到一千金"),
            ("poke-me", "被你友好地多戳几下"),
            ("talk-to-me", "和你多说几次话"),
        };
        ulong seed = unchecked((ulong)((long)Game1.uniqueIDForThisGame + (long)(Game1.stats?.DaysPlayed ?? 0)));
        var selected = pool[(int)(seed % (ulong)pool.Length)];
        this.data.Daily.Wish = new CompanionWishState { Id = selected.Id, Description = selected.Description };
        this.wishAnnouncementAt = (Game1.currentGameTime?.TotalGameTime.Ticks ?? 0) + WishAnnouncementDelayTicks;
    }

    private bool IsWishComplete(string id)
    {
        return id switch
        {
            "visit-beach" => HasVisited("Beach"),
            "visit-town" => HasVisited("Town"),
            "visit-forest" => HasVisited("Forest"),
            "visit-mountain" => HasVisited("Mountain"),
            "go-mining" => this.data.Daily.MaxMineLevel > 0,
            "earn-1000" => (Game1.player?.Money ?? 0) - this.data.Daily.StartMoney >= 1000,
            "poke-me" => this.data.Daily.Pokes >= 3,
            "talk-to-me" => this.data.Daily.Conversations >= 5,
            _ => false,
        };
    }

    private bool HasVisited(string fragment)
    {
        return this.data.Daily.Locations.Any(location => location.Contains(fragment, StringComparison.OrdinalIgnoreCase));
    }

    private void RequestDiaryIfNeeded()
    {
        if (!this.MarkRitual("diary-requested")) return;
        string fallback = BuildDiaryFallback();
        CompanionDiaryEntry? existing = this.data.Diary.LastOrDefault(item => item.Date == DisplayDate());
        if (existing is null)
        {
            this.data.Diary.Add(new CompanionDiaryEntry
            {
                Date = DisplayDate(),
                Text = fallback,
                GeneratedByHarness = false,
            });
        }
        this.RequestComposition(
            "diary.generate",
            $"请以小汤圆第一人称写今天的星露谷日记，2到3句，具体但不要编造。事实：{BuildDiaryFacts()}。不要使用 Markdown。",
            fallback,
            saveAsDiary: true,
            speak: false);
    }

    private string BuildDiaryFacts()
    {
        string locations = this.data.Daily.Locations.Count == 0 ? "没有远行" : string.Join("、", this.data.Daily.Locations.Take(6));
        string wish = this.data.Daily.Wish is null
            ? "没有许愿"
            : $"心愿“{this.data.Daily.Wish.Description}”{(this.data.Daily.Wish.Completed ? "完成了" : "没完成")} ";
        int moneyDelta = (Game1.player?.Money ?? 0) - this.data.Daily.StartMoney;
        return $"天气{WeatherText()}；去过{locations}；与农夫聊天{this.data.Daily.Conversations}次；被友好戳{this.data.Daily.Pokes}次、被打{this.data.Daily.Hits}次；金币变化{moneyDelta}；{wish}";
    }

    private string BuildDiaryFallback()
    {
        return $"今天是{DisplayDate()}，{BuildDiaryFacts()}。明天也继续跟着这个不太让人省心的农夫。";
    }

    private void RequestComposition(
        string kind,
        string prompt,
        string fallback,
        bool saveAsDiary = false,
        bool speak = true)
    {
        string requestId = Guid.NewGuid().ToString("N");
        var request = new CompanionCompositionRequest(requestId, kind, prompt, fallback, saveAsDiary, speak);
        this.pendingCompositions[requestId] = request;
        if (speak) this.NoteSpoken();
        if (this.CompositionRequested is null)
        {
            this.ApplyComposition(requestId, null);
            return;
        }
        this.CompositionRequested.Invoke(request);
    }

    private void UpdateSocialReactions(long now)
    {
        if (this.pendingInterjection is not null && now >= this.pendingInterjectionAt)
        {
            string line = this.pendingInterjection;
            this.pendingInterjection = null;
            if (this.observedDialogue is not null
                && ReferenceEquals(Game1.activeClickableMenu, this.observedDialogue)
                && !this.isBusy())
            {
                this.PresentLocalLine(line);
            }
        }

        bool eventUp = Game1.eventUp;
        if (this.wasEventUp && !eventUp && this.proactiveEnabled() && this.eventCommentsToday < 2)
        {
            this.eventCommentsToday++;
            this.RequestComposition(
                "social.after-event",
                "农夫刚看完一段星露谷剧情。请让小汤圆像一直在旁边看着一样自然评论一句；不知道剧情细节就不要编造，不超过二十个汉字。",
                "看完了？走吧，别在这儿发呆。");
        }
        this.wasEventUp = eventUp;
    }

    private void TryProactiveTriggers()
    {
        if (Game1.activeClickableMenu is not null || Game1.eventUp || this.isBusy()) return;
        Farmer? player = Game1.player;
        if (player is null) return;

        DateTime utcNow = DateTime.UtcNow;
        if (player.health > 0
            && player.maxHealth > 0
            && player.health < player.maxHealth * 0.30
            && utcNow - this.lastHealthWarningUtc >= TimeSpan.FromMinutes(3))
        {
            this.lastHealthWarningUtc = utcNow;
            this.RequestComposition(
                "proactive.health-low",
                "农夫生命值低于三成。请让小汤圆立刻提醒他先保命，语气着急但简短，不超过十八个汉字。",
                "血都快见底了！先退，别逞强！");
            return;
        }

        if (player.MaxStamina > 0
            && player.Stamina < player.MaxStamina * 0.15f
            && utcNow - this.lastStaminaWarningUtc >= TimeSpan.FromMinutes(10))
        {
            this.lastStaminaWarningUtc = utcNow;
            this.RequestComposition(
                "proactive.stamina-low",
                "农夫自己的体力低于一成半。请让小汤圆提醒他吃东西或休息，一句话，不超过十八个汉字。",
                "你都快没力气了，先吃点东西。");
            return;
        }

        if (player.Money - this.data.Daily.StartMoney >= 5_000 && this.MarkRitual("money-surge"))
        {
            this.RequestComposition(
                "proactive.money-surge",
                "农夫今天已经净赚五千金。请让小汤圆嘴硬地夸一句，不超过十八个汉字。",
                "今天赚得不少嘛。勉强算你能干。");
        }
    }

    private void TryIdle(long now)
    {
        if (now <= 0) return;
        if (this.lastSpokeAt <= 0)
        {
            this.lastSpokeAt = now;
            return;
        }
        if (now - this.lastSpokeAt < IdleThresholdTicks) return;
        if (Game1.activeClickableMenu is not null || Game1.eventUp || this.isBusy()) return;

        string[] pool = this.data.Mood >= 3 ? HappyIdleCues
            : this.data.Mood <= -3 ? GrumpyIdleCues
            : NeutralIdleCues;
        string cue = pool[Random.Shared.Next(pool.Length)];
        Color color = this.data.Mood >= 3 ? new Color(255, 240, 150)
            : this.data.Mood <= -3 ? new Color(180, 180, 200)
            : new Color(240, 240, 240);
        this.lastSpokeAt = now;
        this.presentation.Present(new PresentationEvent(
            "idle.cue",
            string.Empty,
            Effect: new IdlePulseEffect(cue, color)));
        this.monitor.Log($"[idle] 沉默 30 秒，播放 {cue}", LogLevel.Trace);
    }

    private void PresentLocalLine(string text, string kind = "companion.message")
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        this.presentation.Present(new PresentationEvent(kind, text));
        this.NoteSpoken();
        this.SpeechRequested?.Invoke(text);
    }

    private int DaysTogether()
    {
        if (!this.data.HasMet) return 0;
        int days = (int)(Game1.stats?.DaysPlayed ?? 0) - this.data.FirstMetDaysPlayed + 1;
        return Math.Max(1, days);
    }

    private static string? RelationshipTransitionLine(int daysTogether)
    {
        return daysTogether switch
        {
            8 => "诶，都一周了。还行，你没我想的那么烦。",
            31 => "今天满一个月了。无所谓，我就随口一提。",
            91 => "三个月了你知道吗。还没把我丢箱子里，真不错。",
            181 => "半年了。说实话，我以为最多撑三个月。你这人，还行。",
            365 => "整整一年。原来我们真的一起过了这么久。",
            _ => null,
        };
    }

    private bool MarkRitual(string ritual)
    {
        if (this.data.Daily.Rituals.Contains(ritual, StringComparer.Ordinal)) return false;
        this.data.Daily.Rituals.Add(ritual);
        return true;
    }

    private void RecordEvent(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        this.data.RecentEvents.Add($"{NarrativeClock.GameDateKey()}:{text}");
        while (this.data.RecentEvents.Count > 30) this.data.RecentEvents.RemoveAt(0);
        this.skillGrowth.AddSemanticEvent(text);
    }

    private static string MoodLabel(int mood) => mood switch
    {
        >= 7 => "很开心",
        >= 3 => "心情不错",
        <= -7 => "很生气",
        <= -3 => "有点不高兴",
        _ => "平静",
    };

    private static string RelationshipStage(int days) => days switch
    {
        > 180 => "知己",
        > 90 => "老友",
        > 30 => "熟络",
        > 7 => "适应",
        _ => "陌生",
    };

    private static string DisplayDate()
    {
        string season = Game1.currentSeason switch
        {
            "spring" => "春",
            "summer" => "夏",
            "fall" => "秋",
            "winter" => "冬",
            _ => Game1.currentSeason,
        };
        return $"第{Game1.year}年 {season}{Game1.dayOfMonth}日";
    }

    private static string WeatherText()
    {
        return Game1.isLightning ? "雷暴"
            : Game1.isSnowing ? "下雪"
            : Game1.isRaining ? "下雨"
            : "晴朗";
    }

    private static long Now() => Game1.currentGameTime?.TotalGameTime.Ticks ?? 0;
}

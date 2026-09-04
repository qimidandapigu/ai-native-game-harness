using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewAgentMod.Contracts;
using StardewAgentMod.Game;
using StardewAgentMod.Game.Abilities;
using StardewAgentMod.Game.Actions;
using StardewAgentMod.Game.Companion;
using StardewAgentMod.Game.Fishing;
using StardewAgentMod.Game.Flight;
using StardewAgentMod.Game.Narrative;
using StardewAgentMod.Harness;
using StardewAgentMod.Presentation;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentMod;

public sealed class ModEntry : Mod
{
    private readonly ConcurrentQueue<Action> mainThreadActions = new();
    private readonly MainThreadDispatcher harnessDispatcher = new();
    private CompanionLocator companion = null!;
    private CompanionGrowthSystem growth = null!;
    private NarrativeState narrative = null!;
    private AbilityRegistry abilities = null!;
    private CompanionLifeModule companionLife = null!;
    private CompanionAppearanceController appearance = null!;
    private CompanionStamina stamina = null!;
    private FlightController flight = null!;
    private FishAssist fishAssist = null!;
    private MineCombatAssist mineCombatAssist = null!;
    private RescueAssist rescueAssist = null!;
    private SpeechBubble speechBubble = null!;
    private CompanionEffects companionEffects = null!;
    private CompanionHud companionHud = null!;
    private BombFishingController bombFishing = null!;
    private IPresentationSink presentation = null!;
    private ModConfig config = null!;
    private GameAgentClient client = null!;
    private StardewGameAdapter gameAdapter = null!;
    private AdapterProtocolClient protocolClient = null!;
    private object? latestObservation;
    private string? currentSaveId;
    private bool textRequestInFlight;
    private bool observationInFlight;
    private bool voiceKeyHeld;
    private Task<bool>? voiceStartTask;
    private string? assistantStatus;
    private long speakingAppearanceSession;

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        if (this.config.BubbleYOffset == ModConfig.LegacyBubbleYOffset)
        {
            this.config.BubbleYOffset = ModConfig.DefaultBubbleYOffset;
            helper.WriteConfig(this.config);
        }
        this.companion = new CompanionLocator(helper, this.Monitor);
        this.growth = new CompanionGrowthSystem(this.companion, this.Monitor);
        this.speechBubble = new SpeechBubble(this.companion.TryGetWorldPosition);
        this.companionEffects = new CompanionEffects(this.companion.TryGetWorldPosition, this.Monitor);
        this.presentation = new GamePresentationSink(this.speechBubble, this.companionEffects, this.Monitor);
        this.stamina = new CompanionStamina(this.Monitor);
        this.narrative = new NarrativeState();
        this.abilities = new AbilityRegistry(
            this.Monitor,
            this.narrative,
            this.growth,
            () => this.config.UnlockAllForTesting);
        this.companionLife = new CompanionLifeModule(
            helper,
            this.Monitor,
            this.presentation,
            this.narrative,
            this.abilities,
            () => this.config.RitualsEnabled,
            () => this.config.ProactiveEnabled,
            () => this.config.DiaryEnabled,
            () => this.config.IdleEnabled,
            () => this.assistantStatus is "recording" or "thinking" or "speaking");
        this.companionLife.CompositionRequested += request => _ = this.ComposeCompanionTextAsync(request);
        this.companionLife.SpeechRequested += text => _ = this.SpeakCompanionTextAsync(text);
        this.appearance = new CompanionAppearanceController(this.companion, this.Monitor);
        this.companionHud = new CompanionHud(
            helper.Input,
            this.companion.TryGetWorldPosition,
            this.companion.TryGetWorldBoundingBox,
            () => this.stamina.Current,
            this.companionLife.GetSnapshot,
            () => string.Equals(this.assistantStatus, "thinking", StringComparison.Ordinal),
            this.companionLife.ReadDiaryEntries,
            this.companionLife.Interact);
        this.bombFishing = new BombFishingController(this.Monitor, helper.Input);
        this.flight = new FlightController(this.Monitor);
        FlightWarpPatches.Apply(this.ModManifest.UniqueID, this.flight, this.Monitor);
        DoubaoMountPatches.Apply(this.ModManifest.UniqueID, this.flight, this.Monitor);
        this.fishAssist = new FishAssist(
            this.Monitor,
            this.stamina,
            () => this.presentation.Present(new PresentationEvent(
                "action.rejected",
                this.stamina.BuildExhaustedLine(Game1.timeOfDay))),
            () => true);
        this.mineCombatAssist = new MineCombatAssist(this.Monitor, () => true);
        this.rescueAssist = new RescueAssist(this.Monitor);
        var actionModule = new StardewActionModule(
            this.Monitor,
            this.abilities,
            this.stamina,
            this.flight,
            this.fishAssist,
            this.mineCombatAssist,
            this.rescueAssist,
            this.presentation);
        this.gameAdapter = new StardewGameAdapter(
            this.growth,
            this.abilities,
            this.companionLife,
            this.stamina,
            this.flight,
            this.mineCombatAssist,
            this.rescueAssist,
            actionModule);
        this.protocolClient = new AdapterProtocolClient(
            this.config.AdapterProtocolUrl,
            this.gameAdapter,
            this.harnessDispatcher,
            this.Monitor);
        this.protocolClient.ConnectionChanged += connected => this.mainThreadActions.Enqueue(() =>
            this.presentation.Present(new PresentationEvent(
                "assistant.status",
                connected ? "Harness 动作通道已连接" : "Harness 动作通道正在重连")));
        this.protocolClient.Start();
        this.client = new GameAgentClient(this.config.GatewayUrl);
        this.client.AdapterProtocolEndpointDiscovered += endpoint => this.mainThreadActions.Enqueue(() =>
        {
            try
            {
                this.protocolClient.UpdateHost(endpoint);
            }
            catch (Exception ex)
            {
                this.Monitor.Log($"[Harness] 拒绝无效的动作通道地址：{ex.Message}", LogLevel.Warn);
            }
        });
        this.client.AssistantStreaming += text => this.mainThreadActions.Enqueue(() =>
        {
            if (!string.IsNullOrWhiteSpace(text)) this.speechBubble.ShowStatus(text);
        });
        this.client.AssistantSpeechCaptionChanged += text => this.mainThreadActions.Enqueue(() =>
        {
            if (!string.IsNullOrWhiteSpace(text)) this.speechBubble.Show(text);
        });
        this.client.AssistantPresented += (text, source) => this.mainThreadActions.Enqueue(() =>
        {
            this.companionLife.NoteSpoken();
            if (string.Equals(source, "voice", StringComparison.Ordinal))
                this.companionLife.NoteConversation(text);
            this.speechBubble.Show(text);
        });
        this.client.AssistantSpeechStarted += () => this.mainThreadActions.Enqueue(this.speechBubble.HoldForSpeech);
        this.client.AssistantSpeechFinished += () => this.mainThreadActions.Enqueue(this.speechBubble.ReleaseAfterSpeech);
        this.client.AssistantStatusChanged += (status, _) => this.mainThreadActions.Enqueue(() =>
        {
            if (string.Equals(this.assistantStatus, status, StringComparison.Ordinal)) return;
            this.assistantStatus = status;
            if (status == "speaking")
            {
                if (this.speakingAppearanceSession == 0)
                {
                    this.speakingAppearanceSession = this.appearance.ReserveSingingSession();
                    this.appearance.BeginSinging(this.speakingAppearanceSession);
                }
            }
            else if (this.speakingAppearanceSession != 0)
            {
                this.appearance.EndSinging(this.speakingAppearanceSession);
                this.speakingAppearanceSession = 0;
            }
            if (status == "ready")
            {
                this.speechBubble.EndStatus();
            }
            else if (status == "recording")
            {
                this.speechBubble.ShowStatus("正在听……");
                Game1.addHUDMessage(new HUDMessage("小汤圆正在听……", HUDMessage.newQuest_type));
            }
            else if (status == "thinking")
            {
                this.speechBubble.ShowStatus("正在思考……");
                Game1.addHUDMessage(new HUDMessage("小汤圆正在思考……", HUDMessage.newQuest_type));
            }
            else if (status == "speaking")
            {
                this.speechBubble.HoldForSpeech();
            }
        });
        this.client.AssistantFailed += message => this.mainThreadActions.Enqueue(() =>
        {
            this.Monitor.Log($"XiaoTangYuan interaction failed: {message}", LogLevel.Warn);
            this.speechBubble.Show($"语音暂时失败：{message}");
            if (Context.IsWorldReady)
                Game1.addHUDMessage(new HUDMessage($"小汤圆：{message}", HUDMessage.error_type));
        });

        helper.Events.Input.ButtonPressed += this.OnButtonPressed;
        helper.Events.Input.ButtonPressed += this.OnVoiceButtonPressed;
        helper.Events.Input.ButtonReleased += this.OnVoiceButtonReleased;
        helper.Events.Input.ButtonPressed += this.companionHud.OnButtonPressed;
        helper.Events.Input.ButtonPressed += this.bombFishing.OnButtonPressed;
        helper.Events.Input.ButtonPressed += this.companionLife.OnButtonPressed;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.UpdateTicked += this.bombFishing.OnUpdateTicked;
        helper.Events.GameLoop.OneSecondUpdateTicked += this.OnOneSecondUpdateTicked;
        helper.Events.GameLoop.OneSecondUpdateTicked += this.companionLife.OnOneSecondUpdate;
        helper.Events.GameLoop.GameLaunched += this.OnGameLaunched;
        helper.Events.GameLoop.SaveLoaded += this.OnSaveLoaded;
        helper.Events.GameLoop.Saving += this.OnSaving;
        helper.Events.GameLoop.DayStarted += this.OnDayStarted;
        helper.Events.GameLoop.DayEnding += this.companionLife.OnDayEnding;
        helper.Events.GameLoop.TimeChanged += this.stamina.OnTimeChanged;
        helper.Events.GameLoop.TimeChanged += this.companionLife.OnTimeChanged;
        helper.Events.Player.Warped += this.OnWarped;
        helper.Events.Player.InventoryChanged += this.companionLife.OnInventoryChanged;
        helper.Events.Display.MenuChanged += this.companionLife.OnMenuChanged;
        helper.Events.Display.RenderedWorld += this.OnRenderedWorld;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;
        helper.ConsoleCommands.Add("xty_growth", "查看小汤圆的三条成长分支进度。", this.OnGrowthCommand);

        this.Monitor.Log(
            $"小汤圆星露谷适配器已加载。按 {this.config.TextChatKey} 输入文字；语音连接 {this.config.GatewayUrl}，动作通道由 Harness 自动发现。",
            LogLevel.Info
        );
    }

    private void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (e.Button != this.config.TextChatKey || !Context.IsWorldReady || this.textRequestInFlight)
            return;
        if (Game1.activeClickableMenu is not null) return;

        this.Helper.Input.Suppress(e.Button);
        Game1.activeClickableMenu = new NamingMenu(this.OnChatSubmitted, "和小汤圆对话", string.Empty);
    }

    private void OnVoiceButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (e.Button != this.config.VoiceChatKey || !Context.IsWorldReady || this.voiceKeyHeld)
            return;
        if (Game1.activeClickableMenu is not null) return;
        if (Game1.chatBox is not null)
        {
            try { if (Game1.chatBox.isActive()) return; }
            catch { }
        }

        this.voiceKeyHeld = true;
        this.speechBubble.ShowStatus("正在连接麦克风……");
        Game1.addHUDMessage(new HUDMessage("小汤圆正在连接麦克风……", HUDMessage.newQuest_type));
        this.voiceStartTask = this.StartVoiceInputAsync();
    }

    private void OnVoiceButtonReleased(object? sender, ButtonReleasedEventArgs e)
    {
        if (e.Button != this.config.VoiceChatKey || !this.voiceKeyHeld) return;
        this.voiceKeyHeld = false;
        Task<bool>? startTask = this.voiceStartTask;
        this.voiceStartTask = null;
        if (startTask is not null) _ = this.StopVoiceInputAsync(startTask);
    }

    private async Task<bool> StartVoiceInputAsync()
    {
        try
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(15));
            await this.client.StartVoiceAsync(timeout.Token).ConfigureAwait(false);
            this.Monitor.Log("[语音] 游戏内 V 键已请求开始录音。", LogLevel.Info);
            return true;
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"[语音] 开始录音失败：{ex.Message}", LogLevel.Warn);
            this.mainThreadActions.Enqueue(() =>
            {
                this.voiceKeyHeld = false;
                this.assistantStatus = "ready";
                this.speechBubble.Show("麦克风启动失败，请检查 Harness 和 macOS 麦克风权限。");
                Game1.addHUDMessage(new HUDMessage(
                    "小汤圆没能开始收听，请检查 Harness 和麦克风权限。",
                    HUDMessage.error_type));
            });
            return false;
        }
    }

    private async Task StopVoiceInputAsync(Task<bool> startTask)
    {
        if (!await startTask.ConfigureAwait(false)) return;
        try
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(15));
            await this.client.StopVoiceAsync(timeout.Token).ConfigureAwait(false);
            this.Monitor.Log("[语音] 游戏内 V 键已请求停止录音。", LogLevel.Info);
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"[语音] 停止录音失败：{ex.Message}", LogLevel.Warn);
            this.mainThreadActions.Enqueue(() =>
            {
                this.assistantStatus = "ready";
                this.speechBubble.Show("语音提交失败，请再按住 V 试一次。");
                Game1.addHUDMessage(new HUDMessage("语音提交失败，请再试一次。", HUDMessage.error_type));
            });
        }
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        GameConfigMenu.TryRegister(
            this.Helper,
            this.ModManifest,
            this.Monitor,
            () => this.config,
            value => this.config = value,
            () =>
            {
                if (Context.IsWorldReady)
                    this.growth.ApplyVisibility(this.config.ShowCompanion);
            });
    }

    private void OnChatSubmitted(string text)
    {
        Game1.exitActiveMenu();
        text = text.Trim();
        if (text.Length == 0) return;

        this.latestObservation = this.CaptureObservation();
        object context = new { observation = this.latestObservation };
        this.textRequestInFlight = true;
        this.assistantStatus = "thinking";
        Game1.addHUDMessage(new HUDMessage("小汤圆正在观察和思考……", HUDMessage.newQuest_type));
        _ = this.SendTextChatAsync(text, context);
    }

    private async Task SendTextChatAsync(string text, object context)
    {
        try
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(120));
            string reply = await this.client.SendChatAsync(text, context, timeout.Token).ConfigureAwait(false);
            this.mainThreadActions.Enqueue(() =>
            {
                this.textRequestInFlight = false;
                this.assistantStatus = "ready";
                this.companionLife.NoteConversation(reply);
                this.speechBubble.Show(reply);
            });
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"XiaoTangYuan text chat failed: {ex}", LogLevel.Error);
            this.mainThreadActions.Enqueue(() =>
            {
                this.textRequestInFlight = false;
                this.assistantStatus = "ready";
                Game1.addHUDMessage(new HUDMessage(
                    "无法连接小汤圆，请确认 AI Native Game Harness 和插件已经启动。",
                    HUDMessage.error_type
                ));
            });
        }
    }

    private void OnOneSecondUpdateTicked(object? sender, OneSecondUpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady) return;
        this.growth.Update();
        if (this.observationInFlight) return;
        this.latestObservation = this.CaptureObservation();
        this.observationInFlight = true;
        _ = this.PublishObservationAsync(this.latestObservation);
    }

    private async Task PublishObservationAsync(object observation)
    {
        try
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(10));
            await this.client.PublishObservationAsync(observation, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"[小汤圆] 状态上报暂时失败：{ex.Message}", LogLevel.Trace);
        }
        finally
        {
            this.mainThreadActions.Enqueue(() => this.observationInFlight = false);
        }
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        this.harnessDispatcher.Drain();
        while (this.mainThreadActions.TryDequeue(out Action? action)) action();
        this.flight.Update();
        this.appearance.SetMountedActive(this.flight.IsAirborne);
        this.appearance.Update();
        this.fishAssist.OnUpdateTicked(sender, e);
        this.mineCombatAssist.OnUpdateTicked(sender, e);
        this.rescueAssist.OnUpdateTicked(sender, e);
    }

    private void OnRenderedWorld(object? sender, RenderedWorldEventArgs e)
    {
        if (!Context.IsWorldReady) return;
        this.bombFishing.Draw(e.SpriteBatch);
        this.flight.Draw(e.SpriteBatch);
        this.companionEffects.Draw(e.SpriteBatch);
        this.companionHud.Draw(e.SpriteBatch);
        this.speechBubble.Draw(e.SpriteBatch, this.config.BubbleYOffset);
    }

    private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(
            Game1.uniqueIDForThisGame.ToString(CultureInfo.InvariantCulture)
        ));
        this.currentSaveId = Convert.ToHexString(digest).ToLowerInvariant();
        this.client.SetSaveId(this.currentSaveId);
        this.gameAdapter.SetSaveId(this.currentSaveId);
        this.stamina.LoadFromFile(this.GetStaminaPath(this.currentSaveId));
        this.growth.OnSaveLoaded(this.config.ShowCompanion);
        this.companionLife.OnSaveLoaded(this.currentSaveId);
        if (this.config.UnlockAllForTesting)
            this.Monitor.Log("[测试] 已临时解锁全部移植能力；存档成长与剧情进度未被改写。", LogLevel.Info);
        this.protocolClient.Reconnect();
    }

    private void OnSaving(object? sender, SavingEventArgs e)
    {
        if (this.currentSaveId is not null)
            this.stamina.SaveToFile(this.GetStaminaPath(this.currentSaveId));
        this.companionLife.OnSaving();
    }

    private void OnDayStarted(object? sender, DayStartedEventArgs e)
    {
        this.growth.OnDayStarted(this.config.ShowCompanion);
        this.rescueAssist.OnDayStarted(sender, e);
        this.companionLife.OnDayStarted(sender, e);
    }

    private void OnWarped(object? sender, WarpedEventArgs e)
    {
        if (!e.IsLocalPlayer) return;
        this.flight.OnWarped(e.OldLocation, e.NewLocation);
        this.appearance.ReapplyOnNextUpdate();
        this.rescueAssist.OnWarped(sender, e);
        this.companionLife.OnWarped(sender, e);
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        this.client.SetSaveId(null);
        this.currentSaveId = null;
        this.gameAdapter.SetSaveId(null);
        this.protocolClient.Reconnect();
        this.textRequestInFlight = false;
        this.observationInFlight = false;
        this.voiceKeyHeld = false;
        this.voiceStartTask = null;
        this.assistantStatus = null;
        this.speakingAppearanceSession = 0;
        this.latestObservation = null;
        this.speechBubble.Clear();
        this.flight.ResetAfterExternalTransition("返回标题");
        this.rescueAssist.OnReturnedToTitle(sender, e);
        this.stamina.Reset();
        this.growth.Reset();
        this.companionLife.Reset();
        this.companionHud.Reset();
        this.companionEffects.Reset();
        this.bombFishing.Reset();
        this.appearance.Reset();
    }

    private object CaptureObservation()
    {
        return GameObservationBuilder.Capture(
            this.growth.GetSnapshot(),
            new CompanionRuntimeSnapshot(
                this.stamina.Current,
                CompanionStamina.Max,
                this.flight.IsAirborne,
                this.flight.IsTransitioning,
                this.mineCombatAssist.IsActive,
                this.rescueAssist.IsActive),
            this.companionLife.GetSnapshot(),
            this.abilities.Snapshot());
    }

    private async Task ComposeCompanionTextAsync(CompanionCompositionRequest request)
    {
        try
        {
            object context = new { observation = this.latestObservation };
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(45));
            string text = await this.client.ComposeAsync(request.Prompt, context, request.Speak, timeout.Token).ConfigureAwait(false);
            this.mainThreadActions.Enqueue(() => this.companionLife.ApplyComposition(request.RequestId, text));
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"[陪伴生成] {request.Kind} 使用本地兜底：{ex.Message}", LogLevel.Trace);
            this.mainThreadActions.Enqueue(() => this.companionLife.ApplyComposition(request.RequestId, null));
        }
    }

    private async Task SpeakCompanionTextAsync(string text)
    {
        try
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(120));
            await this.client.SpeakAsync(text, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"[陪伴语音] 播放失败：{ex.Message}", LogLevel.Trace);
        }
    }

    private string GetStaminaPath(string saveId)
    {
        return Path.Combine(this.Helper.DirectoryPath, "saves", $"{saveId}.stamina.json");
    }

    private void OnGrowthCommand(string command, string[] args)
    {
        if (!Context.IsWorldReady)
        {
            this.Monitor.Log("请先进入一个存档。", LogLevel.Info);
            return;
        }

        string status = this.growth.GetStatusText();
        this.Monitor.Log(status, LogLevel.Info);
        Game1.addHUDMessage(new HUDMessage(status, HUDMessage.newQuest_type));
    }
}

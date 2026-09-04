using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using StardewAgentMod.Contracts;
using StardewAgentMod.Game.Abilities;
using StardewAgentMod.Game.Companion;
using StardewAgentMod.Game.Flight;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentMod.Game.Actions;

internal static class StardewCapabilities
{
    public const string PlantSeedsAll = "stardew.plant_seeds_all";
    public const string WaterAll = "stardew.water_all";
    public const string HarvestAll = "stardew.harvest_all";
    public const string SpeedGrow = "stardew.speed_grow";
    public const string ClearDebris = "stardew.clear_debris";
    public const string FlightTakeoff = "stardew.flight_takeoff";
    public const string FlightLand = "stardew.flight_land";
    public const string FishHelp = "stardew.fish_help";
    public const string MineCombat = "stardew.mine_combat";
    public const string RescueHome = "stardew.rescue_home";
}

internal sealed record GameActionOutcome(
    bool Ok,
    bool ChangedState,
    string Message,
    string? ErrorCode,
    IReadOnlyDictionary<string, object?> Result,
    long GameExecutionMs
)
{
    public static GameActionOutcome Rejected(string code, string message, long elapsedMs = 0) => new(
        false,
        false,
        message,
        code,
        new Dictionary<string, object?> { ["message"] = message },
        elapsedMs
    );
}

/// <summary>
/// 游戏动作的深 Module。调用方只需要 capability 与参数；能力门禁、体力、
/// 主线程游戏规则、异步协助启动和玩家呈现都留在实现内部。
/// </summary>
internal sealed class StardewActionModule
{
    private readonly IMonitor monitor;
    private readonly AbilityRegistry abilities;
    private readonly CompanionStamina stamina;
    private readonly FlightController flight;
    private readonly FishAssist fishAssist;
    private readonly MineCombatAssist mineCombatAssist;
    private readonly RescueAssist rescueAssist;
    private readonly IPresentationSink presentation;
    private readonly Dictionary<string, ICompanionAction> farmActions;

    public StardewActionModule(
        IMonitor monitor,
        AbilityRegistry abilities,
        CompanionStamina stamina,
        FlightController flight,
        FishAssist fishAssist,
        MineCombatAssist mineCombatAssist,
        RescueAssist rescueAssist,
        IPresentationSink presentation)
    {
        this.monitor = monitor;
        this.abilities = abilities;
        this.stamina = stamina;
        this.flight = flight;
        this.fishAssist = fishAssist;
        this.mineCombatAssist = mineCombatAssist;
        this.rescueAssist = rescueAssist;
        this.presentation = presentation;

        var fieldPlanner = new FieldPlanner(monitor);
        this.farmActions = new Dictionary<string, ICompanionAction>(StringComparer.Ordinal)
        {
            [StardewCapabilities.PlantSeedsAll] = new PlantSeedsAction(monitor, fieldPlanner),
            [StardewCapabilities.WaterAll] = new WaterAllAction(),
            [StardewCapabilities.HarvestAll] = new HarvestAllAction(monitor),
            [StardewCapabilities.SpeedGrow] = new SpeedGrowAction(monitor),
            [StardewCapabilities.ClearDebris] = new ClearFarmAreaAction(monitor),
        };
    }

    public GameActionOutcome Execute(string capability, IReadOnlyDictionary<string, object?> arguments)
    {
        _ = arguments;
        var timer = Stopwatch.StartNew();
        if (!Context.IsWorldReady || Game1.player is null || Game1.currentLocation is null)
            return this.Reject("WORLD_NOT_READY", "请先进入一个存档。", timer);

        string? intent = IntentFor(capability);
        if (intent is null)
            return this.Reject("CAPABILITY_UNAVAILABLE", $"不支持的星露谷能力：{capability}", timer);

        AbilityCheckResult ability = this.abilities.CanUseIntent(intent);
        if (!ability.Allowed)
            return this.Reject("ABILITY_LOCKED", ability.ReasonLine, timer);

        if (this.flight.IsAirborne && capability is not StardewCapabilities.FlightLand)
            return this.Reject("FLIGHT_ACTION_BLOCKED", "飞行中只能先安全落地，再执行其他能力。", timer);

        try
        {
            GameActionOutcome outcome = this.farmActions.TryGetValue(capability, out ICompanionAction? action)
                ? this.ExecuteFarmAction(capability, action, timer)
                : capability switch
            {
                StardewCapabilities.FlightTakeoff => this.ExecuteFlight(takeOff: true, timer),
                StardewCapabilities.FlightLand => this.ExecuteFlight(takeOff: false, timer),
                StardewCapabilities.FishHelp => this.ExecuteFishAssist(timer),
                StardewCapabilities.MineCombat => this.ExecuteMineCombat(timer),
                StardewCapabilities.RescueHome => this.ExecuteRescue(timer),
                _ => this.Reject("CAPABILITY_UNAVAILABLE", $"不支持的星露谷能力：{capability}", timer),
            };
            if (outcome.Ok) this.abilities.NoteUsed(intent);
            return outcome;
        }
        catch (Exception ex)
        {
            this.monitor.Log($"[动作] {capability} 执行异常：{ex}", LogLevel.Error);
            return this.Reject("GAME_ACTION_FAILED", ex.Message, timer);
        }
    }

    private GameActionOutcome ExecuteFarmAction(string capability, ICompanionAction action, Stopwatch timer)
    {
        if (!this.stamina.HasAny)
            return this.Reject("STAMINA_EXHAUSTED", this.stamina.BuildExhaustedLine(Game1.timeOfDay), timer);

        ActionResult result = action.Execute(Game1.currentLocation);
        bool changed = result.Count > 0;
        if (!changed)
        {
            string noTargetsMessage = CannedLines.Pick(result.NothingPool);
            this.presentation.Present(new PresentationEvent("companion.message", noTargetsMessage));
            this.monitor.Log($"[动作] {capability} 没有可处理目标", LogLevel.Trace);
            return new GameActionOutcome(
                false,
                false,
                noTargetsMessage,
                "NO_TARGETS",
                new Dictionary<string, object?>
                {
                    ["message"] = noTargetsMessage,
                    ["count"] = 0,
                    ["actionDescription"] = result.ActionDescription,
                    ["stamina"] = this.stamina.Current,
                    ["staminaMax"] = CompanionStamina.Max,
                },
                timer.ElapsedMilliseconds
            );
        }

        if (!this.stamina.TrySpend())
            throw new InvalidOperationException("动作完成时同伴体力状态发生冲突。");

        string message = result.DoneLine ?? CannedLines.Pick(result.DonePool);
        PresentationEffect effect = capability == StardewCapabilities.HarvestAll && result.ItemFlights.Count > 0
            ? new HarvestWhirlwindEffect(
                result.ItemFlights
                    .Select(item => new HarvestWhirlwindItem(item.QualifiedItemId, item.StartWorldPosition))
                    .ToArray(),
                result.Targets,
                result.FxColor)
            : new ActionCastingEffect(result.Targets, result.FxColor);
        this.presentation.Present(new PresentationEvent(
            "action.completed",
            message,
            new Dictionary<string, object?>
            {
                ["capability"] = capability,
                ["count"] = result.Count,
            },
            effect
        ));
        this.monitor.Log($"[动作] {capability} count={result.Count} stamina={this.stamina.Current}/{CompanionStamina.Max}", LogLevel.Info);
        return new GameActionOutcome(
            true,
            changed,
            message,
            null,
            new Dictionary<string, object?>
            {
                ["message"] = message,
                ["count"] = result.Count,
                ["actionDescription"] = result.ActionDescription,
                ["stamina"] = this.stamina.Current,
                ["staminaMax"] = CompanionStamina.Max,
            },
            timer.ElapsedMilliseconds
        );
    }

    private GameActionOutcome ExecuteFlight(bool takeOff, Stopwatch timer)
    {
        bool ok = takeOff
            ? this.flight.TryTakeOff(out string feedback)
            : this.flight.TryLand(out feedback);
        if (!ok) return this.Reject("FLIGHT_REJECTED", feedback, timer);

        this.presentation.Present(new PresentationEvent("action.completed", feedback));
        return new GameActionOutcome(
            true,
            true,
            feedback,
            null,
            new Dictionary<string, object?>
            {
                ["message"] = feedback,
                ["state"] = takeOff ? "taking_off" : "landing",
            },
            timer.ElapsedMilliseconds
        );
    }

    private GameActionOutcome ExecuteFishAssist(Stopwatch timer)
    {
        if (!this.stamina.HasAny)
            return this.Reject("STAMINA_EXHAUSTED", this.stamina.BuildExhaustedLine(Game1.timeOfDay), timer);

        this.fishAssist.Arm();
        const string message = "下一杆钓鱼协助已经准备好，真正咬钩时才会消耗体力。";
        this.presentation.Present(new PresentationEvent("action.completed", message));
        return new GameActionOutcome(
            true,
            true,
            message,
            null,
            new Dictionary<string, object?> { ["message"] = message, ["armed"] = true },
            timer.ElapsedMilliseconds
        );
    }

    private GameActionOutcome ExecuteMineCombat(Stopwatch timer)
    {
        if (!this.stamina.TrySpend())
            return this.Reject("STAMINA_EXHAUSTED", this.stamina.BuildExhaustedLine(Game1.timeOfDay), timer);

        this.mineCombatAssist.Activate();
        const string message = "战斗协助已经开启，接下来约十秒会攻击附近怪物。";
        this.presentation.Present(new PresentationEvent("action.completed", message));
        return new GameActionOutcome(
            true,
            true,
            message,
            null,
            new Dictionary<string, object?>
            {
                ["message"] = message,
                ["active"] = true,
                ["stamina"] = this.stamina.Current,
            },
            timer.ElapsedMilliseconds
        );
    }

    private GameActionOutcome ExecuteRescue(Stopwatch timer)
    {
        if (Game1.timeOfDay < 2400)
            return this.Reject("RESCUE_NOT_NEEDED", "凌晨 0 点后才能启动紧急回家救助。", timer);
        if (!this.stamina.TrySpend())
            return this.Reject("STAMINA_EXHAUSTED", this.stamina.BuildExhaustedLine(Game1.timeOfDay), timer);

        bool started = this.rescueAssist.TryBegin(
            onSleepStarted: () => this.presentation.Present(new PresentationEvent("action.completed", "已经安全回到床边并进入睡眠流程。")),
            onFailed: () =>
            {
                this.stamina.Refund();
                this.presentation.Present(new PresentationEvent("action.rejected", "回家救助没有完成，体力已经返还。"));
            }
        );
        if (!started)
        {
            this.stamina.Refund();
            return this.Reject("RESCUE_REJECTED", "当前游戏状态不允许启动回家救助。", timer);
        }

        const string message = "回家救助已经启动，正在安全传送到床边。";
        this.presentation.Present(new PresentationEvent("action.completed", message));
        return new GameActionOutcome(
            true,
            true,
            message,
            null,
            new Dictionary<string, object?>
            {
                ["message"] = message,
                ["started"] = true,
                ["stamina"] = this.stamina.Current,
            },
            timer.ElapsedMilliseconds
        );
    }

    private GameActionOutcome Reject(string code, string message, Stopwatch timer)
    {
        this.presentation.Present(new PresentationEvent("action.rejected", message));
        this.monitor.Log($"[动作] 拒绝 {code}: {message}", LogLevel.Trace);
        return GameActionOutcome.Rejected(code, message, timer.ElapsedMilliseconds);
    }

    private static string? IntentFor(string capability) => capability switch
    {
        StardewCapabilities.PlantSeedsAll => AbilityRegistry.PlantSeedsAll,
        StardewCapabilities.WaterAll => AbilityRegistry.WaterAll,
        StardewCapabilities.HarvestAll => AbilityRegistry.HarvestAll,
        StardewCapabilities.SpeedGrow => AbilityRegistry.SpeedGrow,
        StardewCapabilities.ClearDebris => AbilityRegistry.ClearDebris,
        StardewCapabilities.FlightTakeoff => AbilityRegistry.FlightTakeoff,
        StardewCapabilities.FlightLand => AbilityRegistry.FlightLand,
        StardewCapabilities.FishHelp => AbilityRegistry.FishHelp,
        StardewCapabilities.MineCombat => AbilityRegistry.MineCombat,
        StardewCapabilities.RescueHome => AbilityRegistry.RescueHome,
        _ => null,
    };
}

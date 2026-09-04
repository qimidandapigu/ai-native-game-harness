using System;
using System.Collections.Generic;
using System.Text.Json;
using StardewAgentMod.Game.Abilities;
using StardewAgentMod.Game.Actions;
using StardewAgentMod.Game.Companion;
using StardewAgentMod.Game.Flight;
using StardewAgentMod.Harness;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentMod.Game;

/// <summary>
/// Adapter Protocol 1.0 的 Stardew 实现。网络细节由 AdapterProtocolClient 隐藏；
/// 本 Module 只负责声明能力、给出权威观察并在主线程执行动作。
/// </summary>
internal sealed class StardewGameAdapter : IAdapterProtocolHandler
{
    public const string GameId = "stardew-valley";
    public const string AdapterId = "qimidandapigu.stardew-agent";
    public const string AdapterVersion = "0.8.2";

    private readonly CompanionGrowthSystem growth;
    private readonly AbilityRegistry abilities;
    private readonly CompanionLifeModule companionLife;
    private readonly CompanionStamina stamina;
    private readonly FlightController flight;
    private readonly MineCombatAssist mineCombat;
    private readonly RescueAssist rescue;
    private readonly StardewActionModule actions;
    private readonly Dictionary<string, object> completed = new(StringComparer.Ordinal);
    private readonly Queue<string> completedOrder = new();

    private string saveId = "title";
    private int revision;

    public StardewGameAdapter(
        CompanionGrowthSystem growth,
        AbilityRegistry abilities,
        CompanionLifeModule companionLife,
        CompanionStamina stamina,
        FlightController flight,
        MineCombatAssist mineCombat,
        RescueAssist rescue,
        StardewActionModule actions)
    {
        this.growth = growth;
        this.abilities = abilities;
        this.companionLife = companionLife;
        this.stamina = stamina;
        this.flight = flight;
        this.mineCombat = mineCombat;
        this.rescue = rescue;
        this.actions = actions;
    }

    public void SetSaveId(string? value)
    {
        this.saveId = string.IsNullOrWhiteSpace(value) ? "title" : value.Trim();
        this.revision = 0;
        this.completed.Clear();
        this.completedOrder.Clear();
    }

    public object Hello()
    {
        return new
        {
            protocolVersion = "1.0",
            adapterId = AdapterId,
            gameId = GameId,
            displayName = "Stardew Valley / 星露谷物语",
            adapterVersion = AdapterVersion,
            capabilities = Capabilities,
        };
    }

    public object Observe()
    {
        object state = Context.IsWorldReady && Game1.player is not null && Game1.currentLocation is not null
            ? GameObservationBuilder.Capture(
                this.growth.GetSnapshot(),
                new CompanionRuntimeSnapshot(
                    this.stamina.Current,
                    CompanionStamina.Max,
                    this.flight.IsAirborne,
                    this.flight.IsTransitioning,
                    this.mineCombat.IsActive,
                    this.rescue.IsActive),
                this.companionLife.GetSnapshot(),
                this.abilities.Snapshot())
            : new
            {
                schema = "ai-native.game-context.v1",
                meta = new { gameId = GameId, adapterId = AdapterId, locale = "zh-CN" },
                ui = new { worldReady = false },
            };

        return new
        {
            gameId = GameId,
            saveId = this.saveId,
            revision = this.revision,
            observedAt = DateTimeOffset.UtcNow.ToString("O"),
            state,
        };
    }

    public object Execute(JsonElement request)
    {
        string requestId = ReadRequiredString(request, "requestId");
        if (this.completed.TryGetValue(requestId, out object? cached)) return cached;

        string gameId = ReadRequiredString(request, "gameId");
        if (!string.Equals(gameId, GameId, StringComparison.Ordinal))
            return this.Cache(requestId, Failure(requestId, this.revision, "GAME_ID_MISMATCH", $"Expected {GameId}, received {gameId}."));

        string capability = ReadRequiredString(request, "capability");
        int? expectedRevision = ReadOptionalRevision(request);
        if (expectedRevision is not null && expectedRevision.Value != this.revision)
        {
            return this.Cache(requestId, Failure(
                requestId,
                this.revision,
                "REVISION_CONFLICT",
                $"Expected revision {expectedRevision.Value}, current revision is {this.revision}."));
        }

        JsonElement argumentsElement = request.TryGetProperty("arguments", out JsonElement rawArguments)
            ? rawArguments
            : default;
        if (argumentsElement.ValueKind != JsonValueKind.Object)
            return this.Cache(requestId, Failure(requestId, this.revision, "INVALID_ARGUMENTS", "Action arguments must be an object."));

        IReadOnlyDictionary<string, object?> arguments = JsonSerializer.Deserialize<Dictionary<string, object?>>(argumentsElement.GetRawText())
            ?? new Dictionary<string, object?>();
        GameActionOutcome outcome = this.actions.Execute(capability, arguments);
        if (outcome.Ok && outcome.ChangedState) this.revision++;

        var result = new Dictionary<string, object?>
        {
            ["requestId"] = requestId,
            ["ok"] = outcome.Ok,
            ["revision"] = this.revision,
            ["result"] = outcome.Result,
            ["timing"] = new Dictionary<string, object?>
            {
                ["gameExecutionMs"] = outcome.GameExecutionMs,
            },
        };
        if (!outcome.Ok)
        {
            result["error"] = new Dictionary<string, object?>
            {
                ["code"] = outcome.ErrorCode ?? "ACTION_REJECTED",
                ["message"] = outcome.Message,
            };
        }
        return this.Cache(requestId, result);
    }

    private object Cache(string requestId, object result)
    {
        this.completed[requestId] = result;
        this.completedOrder.Enqueue(requestId);
        while (this.completedOrder.Count > 128)
            this.completed.Remove(this.completedOrder.Dequeue());
        return result;
    }

    private static object Failure(string requestId, int revision, string code, string message)
    {
        return new
        {
            requestId,
            ok = false,
            revision,
            error = new { code, message },
        };
    }

    private static string ReadRequiredString(JsonElement source, string name)
    {
        if (source.ValueKind != JsonValueKind.Object
            || !source.TryGetProperty(name, out JsonElement value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidOperationException($"{name} must be a non-empty string.");
        }
        return value.GetString()!;
    }

    private static int? ReadOptionalRevision(JsonElement source)
    {
        if (!source.TryGetProperty("expectedRevision", out JsonElement value)) return null;
        if (!value.TryGetInt32(out int revision) || revision < 0)
            throw new InvalidOperationException("expectedRevision must be a non-negative integer.");
        return revision;
    }

    private static readonly object EmptyInputSchema = new
    {
        type = "object",
        additionalProperties = false,
        properties = new Dictionary<string, object>(),
    };

    private static readonly object[] Capabilities =
    {
        Observation("game.state", "当前星露谷存档、玩家、农场、同伴与 UI 的权威观察。"),
        Action(StardewCapabilities.PlantSeedsAll, "把玩家当前选中的种子播到当前地图可用农田；遵守游戏可种植规则。"),
        Action(StardewCapabilities.WaterAll, "浇灌当前地图全部干燥耕地与室内花盆。"),
        Action(StardewCapabilities.HarvestAll, "收获当前地图全部成熟作物，并按背包、箱子、地面顺序安全收纳。"),
        Action(StardewCapabilities.SpeedGrow, "把当前地图未成熟作物推进到睡一夜后可收获，并补水。"),
        Action(StardewCapabilities.ClearDebris, "清理玩家周围八格的农场天然杂物；保护作物、设施、果树、茶树和装有树液采集器的树。"),
        Action(StardewCapabilities.FlightTakeoff, "在允许的室外主地图让玩家乘小汤圆起飞。"),
        Action(StardewCapabilities.FlightLand, "寻找附近安全地块并让玩家缓慢降落。"),
        Action(StardewCapabilities.FishHelp, "挂起一次钓鱼协助，在下一次钓鱼小游戏中自动完美收杆。"),
        Action(StardewCapabilities.MineCombat, "开启约十秒的近身矿洞战斗协助。"),
        Action(StardewCapabilities.RescueHome, "凌晨时把玩家安全送到床边并进入原版睡眠流程。"),
    };

    private static object Observation(string name, string description) => new
    {
        name,
        kind = "observation",
        description,
    };

    private static object Action(string name, string description) => new
    {
        name,
        kind = "action",
        description,
        inputSchema = EmptyInputSchema,
    };
}

internal sealed record CompanionRuntimeSnapshot(
    int Stamina,
    int StaminaMax,
    bool IsAirborne,
    bool IsFlightTransitioning,
    bool IsCombatAssistActive,
    bool IsRescueActive
);

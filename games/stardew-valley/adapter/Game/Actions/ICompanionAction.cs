using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewValley;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>动作层交给表现层的只读物品飞行起点；不携带可变游戏对象。</summary>
    internal sealed record ActionItemFlight(string QualifiedItemId, Vector2 StartWorldPosition);

    /// <summary>
    /// 一个豆包动作执行的结果。
    /// Count = 0 时表示"没活儿可干"(地里没干田 / 没成熟作物),
    /// 此时跳过动画,但仍念 NothingPool 里的一句 "都湿着呢" 之类。
    /// </summary>
    internal sealed class ActionResult
    {
        /// <summary>实际处理的目标数。0 = 没活儿可干。</summary>
        public int Count { get; init; }

        /// <summary>写进 chatlist 的 [行为] 文字。例 "我帮农夫浇了 23 块田"。</summary>
        public string ActionDescription { get; init; } = "";

        /// <summary>目标 tile 中心的世界坐标(CastingFx 用来画光束)。</summary>
        public IReadOnlyList<Vector2> Targets { get; init; } = System.Array.Empty<Vector2>();

        /// <summary>动画主色(浇水蓝、收割金等)。</summary>
        public Color FxColor { get; init; } = Color.White;

        /// <summary>需要由表现层绘制的物品飞行计划；动作层只提供物品 ID 与世界坐标。</summary>
        public IReadOnlyList<ActionItemFlight> ItemFlights { get; init; } = System.Array.Empty<ActionItemFlight>();

        /// <summary>动作成功后(Count > 0)随机抽一条 TTS。</summary>
        public string[] DonePool { get; init; } = System.Array.Empty<string>();

        /// <summary>动作成功后优先使用的动态台词。为空时才从 DonePool 抽一句。</summary>
        public string? DoneLine { get; init; }

        /// <summary>是否即使不是直接语音命令,也在动作完成后说 DoneLine/DonePool。</summary>
        public bool SpeakDoneLineAlways { get; init; }

        /// <summary>动作没活儿干(Count == 0)随机抽一条 TTS。</summary>
        public string[] NothingPool { get; init; } = System.Array.Empty<string>();
    }

    /// <summary>豆包可以执行的动作(浇水、收割、...)。每个动作扫描当前 GameLocation 找目标 + 改 tile 状态。</summary>
    internal interface ICompanionAction
    {
        /// <summary>给 IntentClassifier 用的 intent 名。例 "water_all"、"harvest_all"。</summary>
        string Intent { get; }

        /// <summary>扫描 location 找目标 + 改 tile 状态 + 返回结果。在主线程调用(Game1 非线程安全)。</summary>
        ActionResult Execute(GameLocation location);
    }
}

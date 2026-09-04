using System.Collections.Generic;
using Microsoft.Xna.Framework;

namespace StardewAgentMod.Contracts;

internal sealed record PresentationEvent(
    string Kind,
    string Text,
    IReadOnlyDictionary<string, object?>? Detail = null,
    PresentationEffect? Effect = null
);

/// <summary>游戏接口层交给表现层的只读视觉计划；它不负责修改世界状态。</summary>
internal abstract record PresentationEffect;

internal sealed record ActionCastingEffect(
    IReadOnlyList<Vector2> Targets,
    Color Color
) : PresentationEffect;

internal sealed record HarvestWhirlwindItem(
    string QualifiedItemId,
    Vector2 StartWorldPosition
);

internal sealed record HarvestWhirlwindEffect(
    IReadOnlyList<HarvestWhirlwindItem> Items,
    IReadOnlyList<Vector2> Targets,
    Color Color
) : PresentationEffect;

internal sealed record IdlePulseEffect(
    string SoundCue,
    Color Color
) : PresentationEffect;

internal interface IPresentationSink
{
    void Present(PresentationEvent presentation);
}

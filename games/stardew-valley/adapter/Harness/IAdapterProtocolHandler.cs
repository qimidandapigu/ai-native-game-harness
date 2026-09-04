using System.Text.Json;

namespace StardewAgentMod.Harness;

internal interface IAdapterProtocolHandler
{
    object Hello();

    object Observe();

    object Execute(JsonElement request);
}

using System.Collections.Generic;
using System.Text.Json.Serialization;
using StardewAgentMod.Game.Narrative;

namespace StardewAgentMod.Game.Companion;

internal sealed class CompanionLifeData
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("hasMet")]
    public bool HasMet { get; set; }

    [JsonPropertyName("firstMetDaysPlayed")]
    public int FirstMetDaysPlayed { get; set; }

    [JsonPropertyName("mood")]
    public int Mood { get; set; }

    [JsonPropertyName("daily")]
    public CompanionDailyState Daily { get; set; } = new();

    [JsonPropertyName("diary")]
    public List<CompanionDiaryEntry> Diary { get; set; } = new();

    [JsonPropertyName("recentEvents")]
    public List<string> RecentEvents { get; set; } = new();

    [JsonPropertyName("narrative")]
    public NarrativeState Narrative { get; set; } = new();
}

internal sealed class CompanionDailyState
{
    [JsonPropertyName("date")]
    public string Date { get; set; } = "";

    [JsonPropertyName("startMoney")]
    public int StartMoney { get; set; }

    [JsonPropertyName("pokes")]
    public int Pokes { get; set; }

    [JsonPropertyName("hits")]
    public int Hits { get; set; }

    [JsonPropertyName("conversations")]
    public int Conversations { get; set; }

    [JsonPropertyName("maxMineLevel")]
    public int MaxMineLevel { get; set; }

    [JsonPropertyName("locations")]
    public List<string> Locations { get; set; } = new();

    [JsonPropertyName("rituals")]
    public List<string> Rituals { get; set; } = new();

    [JsonPropertyName("wish")]
    public CompanionWishState? Wish { get; set; }
}

internal sealed class CompanionWishState
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("announced")]
    public bool Announced { get; set; }

    [JsonPropertyName("completed")]
    public bool Completed { get; set; }
}

internal sealed class CompanionDiaryEntry
{
    [JsonPropertyName("date")]
    public string Date { get; set; } = "";

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("generatedByHarness")]
    public bool GeneratedByHarness { get; set; }
}

internal sealed record CompanionQuirkSnapshot(
    string CatchPhrase,
    string Fear,
    string Excitement,
    string FoodPreference,
    string? FavoriteNpc,
    string? DislikedNpc
);

internal sealed record CompanionWishSnapshot(string Id, string Description, bool Announced, bool Completed);

internal sealed record CompanionDiarySnapshot(string Date, string Text);

internal sealed record CompanionLifeSnapshot(
    int Mood,
    string MoodLabel,
    int RelationshipPoints,
    string RelationshipStage,
    int DaysTogether,
    CompanionQuirkSnapshot Quirks,
    CompanionWishSnapshot? Wish,
    int DiaryEntries,
    string? ActiveQuest
);

internal sealed record CompanionCompositionRequest(
    string RequestId,
    string Kind,
    string Prompt,
    string Fallback,
    bool SaveAsDiary = false,
    bool Speak = true
);

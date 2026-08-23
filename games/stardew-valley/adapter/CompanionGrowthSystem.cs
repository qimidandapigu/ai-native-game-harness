using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace StardewAgentMod;

internal enum CompanionForm
{
    Seed,
    Combat,
    Farming,
    Fishing
}

internal sealed record CompanionGrowthSnapshot(
    string Form,
    int Combat,
    int Farming,
    int Fishing,
    int Threshold
);

internal sealed class CompanionGrowthSystem
{
    private const int EvolutionThreshold = 20;
    private const string DataPrefix = "qimidandapigu.StardewAgent/growth/";

    private readonly CompanionLocator companion;
    private readonly IMonitor monitor;
    private readonly Dictionary<string, Dictionary<Vector2, Crop>> knownCrops = new(StringComparer.Ordinal);

    private uint lastMonstersKilled;
    private uint lastSeedsSown;
    private uint lastFishCaught;
    private int combat;
    private int farming;
    private int fishing;
    private bool showCompanion;

    public CompanionForm Form { get; private set; } = CompanionForm.Seed;

    public CompanionGrowthSystem(CompanionLocator companion, IMonitor monitor)
    {
        this.companion = companion;
        this.monitor = monitor;
    }

    public void OnSaveLoaded(bool showCompanion)
    {
        this.showCompanion = showCompanion;
        this.Load();
        this.SnapshotCounters();
        this.knownCrops.Clear();
        this.SnapshotCurrentLocationCrops(waterNewCrops: false);
        this.companion.ApplyEnabled(showCompanion, this.Form);
    }

    public void OnDayStarted(bool showCompanion)
    {
        this.showCompanion = showCompanion;
        this.SnapshotCounters();
        this.knownCrops.Clear();
        this.SnapshotCurrentLocationCrops(waterNewCrops: false);
        this.companion.ApplyEnabled(showCompanion, this.Form);
    }

    public void Update()
    {
        if (!Context.IsWorldReady || Game1.player is null) return;

        uint monstersKilled = Game1.stats.MonstersKilled;
        uint seedsSown = Game1.stats.SeedsSown;
        uint fishCaught = Game1.stats.FishCaught;

        uint monsterDelta = Delta(monstersKilled, this.lastMonstersKilled);
        uint seedDelta = Delta(seedsSown, this.lastSeedsSown);
        uint fishDelta = Delta(fishCaught, this.lastFishCaught);

        this.lastMonstersKilled = monstersKilled;
        this.lastSeedsSown = seedsSown;
        this.lastFishCaught = fishCaught;

        if (monsterDelta > 0)
        {
            this.Award(CompanionForm.Combat, ToInt(monsterDelta));
            if (this.Form == CompanionForm.Combat)
                Game1.player.health = Math.Min(Game1.player.maxHealth, Game1.player.health + ToInt(monsterDelta) * 2);
        }

        if (seedDelta > 0)
            this.Award(CompanionForm.Farming, ToInt(seedDelta));

        if (fishDelta > 0)
        {
            this.Award(CompanionForm.Fishing, ToInt(fishDelta) * 2);
            if (this.Form == CompanionForm.Fishing)
                Game1.player.Stamina = Math.Min(Game1.player.MaxStamina, Game1.player.Stamina + ToInt(fishDelta) * 8f);
        }

        this.SnapshotCurrentLocationCrops(waterNewCrops: this.Form == CompanionForm.Farming);
    }

    public CompanionGrowthSnapshot GetSnapshot()
    {
        return new CompanionGrowthSnapshot(
            this.Form.ToString().ToLowerInvariant(),
            this.combat,
            this.farming,
            this.fishing,
            EvolutionThreshold
        );
    }

    public string GetStatusText()
    {
        if (this.Form != CompanionForm.Seed)
            return $"小汤圆已经进化为{GetDisplayName(this.Form)}。";

        return $"小汤圆尚未定型：战斗 {this.combat}/{EvolutionThreshold}，种植 {this.farming}/{EvolutionThreshold}，钓鱼 {this.fishing}/{EvolutionThreshold}。";
    }

    public void Reset()
    {
        this.Form = CompanionForm.Seed;
        this.combat = 0;
        this.farming = 0;
        this.fishing = 0;
        this.showCompanion = false;
        this.knownCrops.Clear();
    }

    private void Award(CompanionForm path, int amount)
    {
        if (this.Form != CompanionForm.Seed || amount <= 0) return;

        int before;
        int after;
        switch (path)
        {
            case CompanionForm.Combat:
                before = this.combat;
                this.combat = Math.Min(EvolutionThreshold, this.combat + amount);
                after = this.combat;
                break;
            case CompanionForm.Farming:
                before = this.farming;
                this.farming = Math.Min(EvolutionThreshold, this.farming + amount);
                after = this.farming;
                break;
            case CompanionForm.Fishing:
                before = this.fishing;
                this.fishing = Math.Min(EvolutionThreshold, this.fishing + amount);
                after = this.fishing;
                break;
            default:
                return;
        }

        this.Save();
        if (after >= EvolutionThreshold)
        {
            this.Evolve(path);
            return;
        }

        if (before / 5 != after / 5)
            Game1.addHUDMessage(new HUDMessage($"小汤圆的{GetDisplayName(path)}倾向：{after}/{EvolutionThreshold}", HUDMessage.newQuest_type));
    }

    private void Evolve(CompanionForm form)
    {
        this.Form = form;
        this.Save();
        this.companion.ApplyEnabled(this.showCompanion, form);

        string ability = form switch
        {
            CompanionForm.Combat => "以后每次击败怪物都会为你恢复2点生命。",
            CompanionForm.Farming => "以后新种下的作物会被立即浇水。",
            CompanionForm.Fishing => "以后每钓上一条鱼都会恢复8点体力。",
            _ => string.Empty
        };
        string message = $"小汤圆进化为{GetDisplayName(form)}！{ability}";
        Game1.addHUDMessage(new HUDMessage(message, HUDMessage.newQuest_type));
        this.monitor.Log(message, LogLevel.Info);
    }

    private void SnapshotCounters()
    {
        this.lastMonstersKilled = Game1.stats.MonstersKilled;
        this.lastSeedsSown = Game1.stats.SeedsSown;
        this.lastFishCaught = Game1.stats.FishCaught;
    }

    private void SnapshotCurrentLocationCrops(bool waterNewCrops)
    {
        GameLocation? location = Game1.currentLocation;
        if (location is null) return;

        string locationId = location.NameOrUniqueName;
        Dictionary<Vector2, Crop> current = new();
        foreach (var pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is HoeDirt { crop: not null } dirt)
                current[pair.Key] = dirt.crop;
        }

        if (!this.knownCrops.TryGetValue(locationId, out Dictionary<Vector2, Crop>? previous))
        {
            this.knownCrops[locationId] = current;
            return;
        }

        if (waterNewCrops)
        {
            foreach ((Vector2 tile, Crop crop) in current)
            {
                if (previous.TryGetValue(tile, out Crop? oldCrop) && ReferenceEquals(oldCrop, crop)) continue;
                if (location.terrainFeatures.TryGetValue(tile, out var feature) && feature is HoeDirt dirt)
                    dirt.state.Value = 1;
            }
        }

        this.knownCrops[locationId] = current;
    }

    private void Load()
    {
        this.combat = ReadInt("combat");
        this.farming = ReadInt("farming");
        this.fishing = ReadInt("fishing");
        string rawForm = Read("form");
        this.Form = Enum.TryParse(rawForm, ignoreCase: true, out CompanionForm form)
            ? form
            : CompanionForm.Seed;
    }

    private void Save()
    {
        Write("combat", this.combat.ToString());
        Write("farming", this.farming.ToString());
        Write("fishing", this.fishing.ToString());
        Write("form", this.Form.ToString());
    }

    private static uint Delta(uint current, uint previous) => current >= previous ? current - previous : 0;

    private static int ToInt(uint value) => (int)Math.Min(value, int.MaxValue);

    private static string GetDisplayName(CompanionForm form) => form switch
    {
        CompanionForm.Combat => "战斗型",
        CompanionForm.Farming => "种植型",
        CompanionForm.Fishing => "钓鱼型",
        _ => "未定型"
    };

    private static string Read(string name)
    {
        return Game1.player.modData.TryGetValue(DataPrefix + name, out string? value) ? value : string.Empty;
    }

    private static int ReadInt(string name)
    {
        return int.TryParse(Read(name), out int value) ? Math.Clamp(value, 0, EvolutionThreshold) : 0;
    }

    private static void Write(string name, string value)
    {
        Game1.player.modData[DataPrefix + name] = value;
    }
}

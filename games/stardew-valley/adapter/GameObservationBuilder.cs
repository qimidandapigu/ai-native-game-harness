using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewAgentMod.Game;
using StardewAgentMod.Game.Companion;
using StardewValley;
using StardewValley.Monsters;
using StardewValley.TerrainFeatures;

namespace StardewAgentMod;

internal static class GameObservationBuilder
{
    public static object Capture(
        CompanionGrowthSnapshot? companionGrowth = null,
        CompanionRuntimeSnapshot? companionRuntime = null,
        CompanionLifeSnapshot? companionLife = null,
        IReadOnlyDictionary<string, bool>? abilities = null)
    {
        Farmer player = Game1.player;
        GameLocation location = Game1.currentLocation;
        Vector2 playerTile = player.Tile;

        var inventory = player.Items
            .Where(item => item is not null)
            .GroupBy(item => item!.DisplayName)
            .Select(group => new { name = group.Key, count = group.Sum(item => Math.Max(1, item!.Stack)) })
            .Take(12)
            .ToArray();

        var nearbyNpcs = location.characters
            .OfType<NPC>()
            .Where(npc => !npc.IsMonster && Vector2.Distance(npc.Tile, playerTile) <= 12f)
            .OrderBy(npc => Vector2.Distance(npc.Tile, playerTile))
            .Take(8)
            .Select(npc => new
            {
                id = npc.Name,
                kind = "npc",
                name = npc.Name,
                position = new { space = "tile", x = (int)npc.Tile.X, y = (int)npc.Tile.Y },
                relationshipLevel = player.friendshipData.TryGetValue(npc.Name, out Friendship? friendship)
                    ? friendship.Points / 250 : 0
            })
            .ToArray();

        var monsters = location.characters
            .OfType<Monster>()
            .OrderBy(monster => Vector2.Distance(monster.Tile, playerTile))
            .Take(8)
            .Select(monster => new
            {
                id = monster.Name,
                kind = "creature",
                name = monster.Name,
                hostile = true,
                vitals = new { health = new { current = monster.Health } },
                distance = Math.Round(Vector2.Distance(monster.Tile, playerTile), 1)
            })
            .ToArray();

        int tilled = 0;
        int dry = 0;
        int crops = 0;
        int ripe = 0;
        foreach (var pair in location.terrainFeatures.Pairs)
        {
            TerrainFeature feature = pair.Value;
            if (feature is not HoeDirt dirt) continue;
            tilled++;
            if (dirt.state.Value == HoeDirt.dry) dry++;
            if (dirt.crop is null) continue;
            crops++;
            if (dirt.readyForHarvest()) ripe++;
        }

        string weather = Game1.isLightning ? "storm"
            : Game1.isSnowing ? "snow"
            : Game1.isRaining ? "rain"
            : "sunny";

        return new
        {
            schema = "ai-native.game-context.v1",
            meta = new
            {
                gameId = "stardew-valley",
                adapterId = "qimidandapigu.StardewAgent",
                capturedAt = DateTimeOffset.UtcNow,
                locale = "zh-CN"
            },
            scene = new
            {
                location = new
                {
                    id = location.NameOrUniqueName,
                    kind = location.GetType().Name,
                    outdoors = location.IsOutdoors
                },
                clock = new
                {
                    year = Game1.year,
                    season = Game1.currentSeason,
                    day = Game1.dayOfMonth,
                    time = Game1.timeOfDay
                },
                weather = new { kind = weather }
            },
            player = new
            {
                id = "local-player",
                name = player.Name,
                position = new { space = "tile", x = (int)playerTile.X, y = (int)playerTile.Y },
                vitals = new
                {
                    stamina = new { current = (int)player.Stamina, max = (int)player.MaxStamina, ratio = player.MaxStamina > 0 ? player.Stamina / player.MaxStamina : 0 },
                    health = new { current = player.health, max = player.maxHealth, ratio = player.maxHealth > 0 ? (double)player.health / player.maxHealth : 0 }
                },
                inventory = new
                {
                    activeItem = player.CurrentItem?.DisplayName,
                    freeSlots = player.freeSpotsInInventory(),
                    items = inventory
                },
                currency = new { money = player.Money }
            },
            companion = new
            {
                id = "xiaotangyuan",
                present = companionGrowth is not null,
                growth = companionGrowth,
                life = companionLife,
                abilities,
                stamina = companionRuntime is null
                    ? null
                    : new
                    {
                        current = companionRuntime.Stamina,
                        max = companionRuntime.StaminaMax,
                    },
                flight = companionRuntime is null
                    ? null
                    : new
                    {
                        airborne = companionRuntime.IsAirborne,
                        transitioning = companionRuntime.IsFlightTransitioning,
                    },
                assists = companionRuntime is null
                    ? null
                    : new
                    {
                        combatActive = companionRuntime.IsCombatAssistActive,
                        rescueActive = companionRuntime.IsRescueActive,
                    }
            },
            entities = nearbyNpcs.Cast<object>().Concat(monsters).Take(30).ToArray(),
            objectives = player.questLog
                .Where(quest => quest is not null && !quest.completed.Value)
                .Take(8)
                .Select(quest => new { id = quest.id.Value, title = quest.questTitle })
                .ToArray(),
            ui = new
            {
                worldReady = true,
                menuOpen = Game1.activeClickableMenu is not null,
                eventRunning = Game1.eventUp,
                playerControllable = player.CanMove
            },
            extensions = new
            {
                stardew = new
                {
                    farm = new { tilled, dry, crops, ripe },
                    locationObjectCount = location.Objects.Count()
                }
            }
        };
    }
}

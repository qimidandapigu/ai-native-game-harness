local GLOBAL = GLOBAL
GLOBAL.STRINGS.NAMES.CHESTER = "小汤圆"
local JINGLING_ANIM_FILE = "anim/jingling.zip"
local JINGLING_ANIM_AVAILABLE = GLOBAL.kleifileexists(MODROOT .. JINGLING_ANIM_FILE)

-- A missing optional visual must never prevent the gameplay Mod from loading.
-- Release builds normally include this asset, but older or interrupted installs
-- can safely fall back to vanilla Chester until the animation is repaired.
Assets = {}
if JINGLING_ANIM_AVAILABLE then
    table.insert(Assets, Asset("ANIM", JINGLING_ANIM_FILE))
end

local json = GLOBAL.require("json")
local io = GLOBAL.io
local math = GLOBAL.math
local pairs = GLOBAL.pairs
local pcall = GLOBAL.pcall
local string = GLOBAL.string
local table = GLOBAL.table
local tostring = GLOBAL.tostring
local tonumber = GLOBAL.tonumber
local type = GLOBAL.type

local STATE_PATH = "unsafedata/dont_starve_ai_mod_state.json"
local REQUEST_PATH = "unsafedata/dont_starve_ai_mod_requests.json"
local REPLY_PATH = "unsafedata/dont_starve_ai_mod_reply.json"
local BRIDGE_STATUS_PATH = "unsafedata/dont_starve_ai_mod_bridge_status.json"
local SKILL_COMMAND_PATH = "unsafedata/dont_starve_ai_mod_skill_command.json"
local SKILL_RESULT_PATH = "unsafedata/dont_starve_ai_mod_skill_result.json"
-- DST only permits writes to selected extensions in unsafedata.  Keeping this
-- as .txt is important: a .log file silently fails to open and hides exactly
-- the diagnostics needed when the input bridge does not start.
local LUA_LOG_PATH = "unsafedata/dont_starve_ai_mod_lua.txt"
local RPC_NAMESPACE = "dont_starve_ai_mod"
local STATE_VERSION = 2
local VOICE_KEY = GLOBAL.KEY_V or 118
local THROW_KEY = GLOBAL.KEY_G or 103
local CHESTER_SLOT_COUNTS = { [9] = true, [18] = true, [27] = true, [36] = true }
local CHESTER_SLOTS = tonumber(GetModConfigData("chester_slots")) or 9
if not CHESTER_SLOT_COUNTS[CHESTER_SLOTS] then
    CHESTER_SLOTS = 9
end
local CHESTER_LIGHT_ENABLED = GetModConfigData("chester_light_enabled") == true
local CHESTER_LIGHT_RADIUS = tonumber(GetModConfigData("chester_light_radius")) or 3
CHESTER_LIGHT_RADIUS = math.max(1, math.min(CHESTER_LIGHT_RADIUS, 5))
local CHESTER_AUTO_REVIVE_ENABLED = GetModConfigData("chester_auto_revive") == true
local CHESTER_AUTO_REVIVE_DELAY = 3
local CHESTER_REVIVE_ORBIT_RADIUS = 2
local CHESTER_REVIVE_ORBIT_INTERVAL = 0.25
local CHESTER_SOUL_RUSH_SPEED = 16
local CHESTER_SOUL_RUSH_DISTANCE = 2.5
local CHESTER_THROW_ENABLED = GetModConfigData("chester_throw_enabled") ~= false
local CHESTER_THROW_DAMAGE = tonumber(GetModConfigData("chester_throw_damage")) or 34
CHESTER_THROW_DAMAGE = math.max(1, math.min(CHESTER_THROW_DAMAGE, 100))
local CHESTER_THROW_DISTANCE = 10
local CHESTER_THROW_DURATION = 0.6
local CHESTER_THROW_COOLDOWN = 2
local CHESTER_THROW_STRIKE_CHANCE = 0.3
local JINGLING_VISUAL_IDLE = 0
local JINGLING_VISUAL_THROW = 1
local JINGLING_VISUAL_STRIKE = 2
local CHESTER_THROW_LAUNCH_LINES = {
    "看招！",
    "精灵快递，出发！",
    "接住这一击！",
    "小心天外来客！",
}
local CHESTER_THROW_HIT_LINES = {
    "命中！",
    "正中目标！",
    "这一击漂亮！",
    "别小看精灵！",
}
local CHESTER_THROW_STRIKE_LINES = {
    "今天不想上班……",
    "罢工一分钟！",
    "我的翅膀要休息！",
    "这次你自己来吧！",
}
local CHESTER_SPEECH_BUBBLE_WIDTH = 360
local CHESTER_SPEECH_BUBBLE_OFFSET = GLOBAL.Vector3(0, -390, 0)
local CHESTER_SPEECH_BUBBLE_PADDING = 18
local CHESTER_SPEECH_BUBBLE_MAX_LINES = 6
local CHESTER_SPEECH_BUBBLE_MIN_WIDTH = 110
local CHESTER_HEAD_TEXT_WIDTH = 300
local CHESTER_HEAD_TEXT_MAX_LINES = 6
-- Only use recall as an emergency recovery for a genuinely stranded Chester.
-- Normal following is handled by the tuned behaviour-tree node below.
local CHESTER_RECALL_DISTANCE = 48
local CHESTER_FOLLOW_CHECK_INTERVAL = 10
local CHESTER_FOLLOW_TARGET_DISTANCE = 2
local CHESTER_FOLLOW_START_DISTANCE = 5
local STATUS_PANEL_KEY = GLOBAL.KEY_F8 or 119
local REMINDER_HEALTH_ENABLED = GetModConfigData("reminder_health") ~= false
local REMINDER_HUNGER_ENABLED = GetModConfigData("reminder_hunger") ~= false
local REMINDER_NIGHT_ENABLED = GetModConfigData("reminder_night") ~= false
local REMINDER_WET_ENABLED = GetModConfigData("reminder_wet") ~= false
local REMINDER_BOSS_ENABLED = GetModConfigData("reminder_boss") ~= false
local REMINDER_COOLDOWN = tonumber(GetModConfigData("reminder_cooldown")) or 120
local REMINDER_AI_ENABLED = GetModConfigData("reminder_ai_enabled") == true
REMINDER_COOLDOWN = math.max(15, REMINDER_COOLDOWN)
local REMINDER_INTERVAL = 5
local REMINDER_HEALTH_THRESHOLD = 0.30
local REMINDER_HUNGER_THRESHOLD = 0.25
local REMINDER_WET_THRESHOLD = 0.60
local REMINDER_BOSS_RADIUS = 24

local last_reply_id = ""
local voice_key_down = false
local key_handlers_installed = false
local throw_key_down = false
local status_panel_key_down = false
local status_panel_key_handlers_installed = false
local status_panel_visible = false
local request_sequence = 0
local find_chester_for_userid
local queue_game_reminder_request

local function configure_chester_container(slot_count)
    local containers = GLOBAL.require("containers")
    local slots = CHESTER_SLOT_COUNTS[slot_count] and slot_count or 9
    local widget = containers.params.chester.widget
    local columns = slots <= 9 and 3 or (slots <= 18 and 6 or 9)
    local rows = math.ceil(slots / columns)
    local spacing = 80

    widget.slotpos = {}
    for row = rows - 1, 0, -1 do
        for column = 0, columns - 1 do
            if #widget.slotpos >= slots then
                break
            end
            table.insert(
                widget.slotpos,
                GLOBAL.Vector3(
                    (column - (columns - 1) / 2) * spacing,
                    (row - (rows - 1) / 2) * spacing,
                    0
                )
            )
        end
    end
    widget.pos = GLOBAL.Vector3(0, 200, 0)
    widget.side_align_tip = math.max(160, columns * spacing / 2 + 40)
    if slots > 9 then
        -- There is no matching 9x3 Chester frame in the base game's UI
        -- assets. Hide the fixed 3x3 frame so the expanded slot grid is
        -- visually consistent instead of leaving a small frame in its centre.
        widget.bganim_visualfn = function(anim)
            anim:Hide()
        end
    else
        widget.bganim_visualfn = function(anim)
            anim:Show()
        end
    end
    -- Clients initially load their local Mod options, which may not match a
    -- hosted world's settings. Always allocate the maximum possible pool;
    -- the actual UI size is synchronized per Chester below.
    containers.MAXITEMSLOTS = math.max(containers.MAXITEMSLOTS or 0, 36)
end

configure_chester_container(CHESTER_SLOTS)

local function configure_chester_light(inst)
    if not CHESTER_LIGHT_ENABLED then
        return
    end

    -- The light is added on both the server and each client.  Light rendering
    -- is client-local, while doing this on the server also keeps hosted and
    -- dedicated worlds consistent without needing another network variable.
    if inst.Light == nil then
        inst.entity:AddLight()
    end
    inst.Light:SetRadius(CHESTER_LIGHT_RADIUS)
    inst.Light:SetIntensity(0.8)
    inst.Light:SetFalloff(0.6)
    inst.Light:SetColour(1, 0.88, 0.62)
    inst.Light:Enable(true)
    inst.Light:EnableClientModulation(true)
end

local function keep_chester_awake(inst)
    local sleeper = inst.components ~= nil and inst.components.sleeper or nil
    if sleeper == nil then
        return
    end

    -- Chester's vanilla night sleep stops its brain, which also stops the
    -- follower behaviour. This companion must remain available to its owner
    -- at night, so disable the automatic sleep test and wake it if necessary.
    sleeper:SetSleepTest(function()
        return false
    end)
    sleeper:SetWakeTest(function()
        return true
    end)
    if sleeper:IsAsleep() then
        sleeper:WakeUp()
    end
end

local function configure_chester_follow_distance(brain)
    -- Chester's stock brain waits until it is 12 units away before following.
    -- Tune its existing Follow node instead of replacing the whole brain, so
    -- its normal panic and facing behaviour remain unchanged.
    local root = brain ~= nil and brain.bt ~= nil and brain.bt.root or nil
    local function tune_follow_node(node)
        if node == nil then
            return false
        end
        if node.name == "Follow" then
            node.min_dist = 0
            node.target_dist = CHESTER_FOLLOW_TARGET_DISTANCE
            node.max_dist = CHESTER_FOLLOW_START_DISTANCE
            return true
        end
        if node.children ~= nil then
            for _, child in pairs(node.children) do
                if tune_follow_node(child) then
                    return true
                end
            end
        end
        return false
    end

    tune_follow_node(root)
end

-- This hook runs after ChesterBrain:OnStart has built the behaviour tree.
-- It changes the normal walking trigger, rather than teleporting the entity.
AddBrainPostInit("chesterbrain", function(brain)
    configure_chester_follow_distance(brain)
end)

local function diagnostic(message)
    local timestamp = GLOBAL.os ~= nil and GLOBAL.os.time ~= nil and GLOBAL.os.time() or 0
    local text = tostring(message)
    print("[Chester AI] " .. text)

    local file = io.open(LUA_LOG_PATH, "a")
    if file ~= nil then
        file:write("[" .. tostring(timestamp) .. "] " .. text .. "\n")
        file:close()
    end
end

local function is_player_in_revival(player)
    return player ~= nil and player:HasTag("playerghost")
end

local function set_jingling_visual_mode(chester, mode, duration)
    local visual_mode = chester ~= nil and chester._jingling_visual_mode or nil
    if visual_mode == nil then
        return
    end
    visual_mode:set(mode)
    if duration ~= nil and duration > 0 then
        chester:DoTaskInTime(duration, function()
            if chester:IsValid() and visual_mode:value() == mode then
                visual_mode:set(JINGLING_VISUAL_IDLE)
            end
        end)
    end
end

local function round(value, places)
    if type(value) ~= "number" then
        return nil
    end
    local scale = 10 ^ (places or 0)
    return math.floor(value * scale + 0.5) / scale
end

local function get_replica_value(entity, component_name, method_name)
    local component = entity ~= nil
        and entity.replica ~= nil
        and entity.replica[component_name]
        or nil
    if component == nil or component[method_name] == nil then
        return nil
    end
    local ok, value = pcall(component[method_name], component)
    return ok and value or nil
end

local function item_snapshot(item)
    if item == nil then
        return nil
    end

    local stack = 1
    if item.replica ~= nil and item.replica.stackable ~= nil then
        local ok, value = pcall(item.replica.stackable.StackSize, item.replica.stackable)
        if ok and value ~= nil then
            stack = value
        end
    end

    local display_name = item.prefab or "unknown"
    if item.GetDisplayName ~= nil then
        local ok, value = pcall(item.GetDisplayName, item)
        if ok and value ~= nil and value ~= "" then
            display_name = value
        end
    end

    return {
        prefab = item.prefab or "unknown",
        name = display_name,
        stack = stack,
    }
end

local function inventory_snapshot(player)
    local result = { items = {}, equipped = {}, active = nil }
    local inventory = player ~= nil
        and player.replica ~= nil
        and player.replica.inventory
        or nil
    if inventory == nil then
        return result
    end

    local ok_items, items = pcall(inventory.GetItems, inventory)
    if ok_items and type(items) == "table" then
        for _, item in pairs(items) do
            local value = item_snapshot(item)
            if value ~= nil then
                table.insert(result.items, value)
            end
        end
    end

    local ok_equips, equips = pcall(inventory.GetEquips, inventory)
    if ok_equips and type(equips) == "table" then
        for slot, item in pairs(equips) do
            local value = item_snapshot(item)
            if value ~= nil then
                value.slot = tostring(slot)
                table.insert(result.equipped, value)
            end
        end
    end

    local ok_active, active = pcall(inventory.GetActiveItem, inventory)
    if ok_active then
        result.active = item_snapshot(active)
    end
    return result
end

local function find_chester_near_position(x, y, z)
    if GLOBAL.TheSim == nil then
        return nil
    end
    local ok, entities = pcall(
        GLOBAL.TheSim.FindEntities,
        GLOBAL.TheSim,
        x,
        y,
        z,
        80,
        { "chester" },
        { "INLIMBO" }
    )
    if not ok or type(entities) ~= "table" or #entities == 0 then
        return nil
    end
    return entities[1]
end

local function find_chester_near_player(player)
    if player == nil or player.Transform == nil then
        return nil
    end
    local x, y, z = player.Transform:GetWorldPosition()
    return find_chester_near_position(x, y, z)
end

local function find_or_create_player_chester(player)
    if player == nil or player.Transform == nil or player.userid == nil then
        return nil, false
    end

    local x, y, z = player.Transform:GetWorldPosition()
    -- This runs only when a player enters. Search the whole playable world so
    -- a Chester that was left behind is reclaimed instead of duplicating it.
    local candidates = GLOBAL.TheSim:FindEntities(x, y, z, 10000, { "chester" }, { "INLIMBO" })
    local unowned = {}
    for _, candidate in pairs(candidates) do
        local follower = candidate.components ~= nil and candidate.components.follower or nil
        if candidate._chester_ai_owner_userid == player.userid
            or (follower ~= nil and follower.leader == player) then
            return candidate, false
        end
        if candidate._chester_ai_owner_userid == nil then
            table.insert(unowned, candidate)
        end
    end

    -- Migrate an old single-Chester save without creating another companion.
    -- When there is more than one unowned Chester, do not guess: each player
    -- must receive a distinct new companion instead of claiming a stranger's.
    if #unowned == 1 then
        return unowned[1], false
    end

    local chester = GLOBAL.SpawnPrefab("chester")
    if chester ~= nil and chester.Transform ~= nil then
        chester.Transform:SetPosition(x, y, z)
        return chester, true
    end
    return nil, false
end

local function is_chester_owner(chester, player)
    return chester ~= nil
        and player ~= nil
        and player.userid ~= nil
        and chester._chester_ai_owner_userid ~= nil
        and chester._chester_ai_owner_userid == player.userid
end

local function secure_chester_container(inst)
    local container = inst.components ~= nil and inst.components.container or nil
    if container == nil or inst._chester_ai_open_guard_installed then
        return
    end
    inst._chester_ai_open_guard_installed = true
    local old_open = container.Open
    container.Open = function(component, doer)
        if inst._chester_ai_owner_userid ~= nil and not is_chester_owner(inst, doer) then
            diagnostic(
                "blocked Chester container open: owner=" .. tostring(inst._chester_ai_owner_userid)
                    .. "; player=" .. tostring(doer ~= nil and doer.userid or "nil")
            )
            if doer ~= nil and doer.components ~= nil and doer.components.talker ~= nil then
                doer.components.talker:Say("这不是你的切斯特。", 3, nil, true)
            end
            return
        end
        return old_open(component, doer)
    end
end

local function remove_player_eyebones(player)
    local inventory = player ~= nil and player.components ~= nil and player.components.inventory or nil
    if inventory == nil then
        return 0
    end

    local removed = 0
    while true do
        local eyebone = inventory:FindItem(function(item)
            return item ~= nil and item.prefab == "chester_eyebone"
        end)
        if eyebone == nil then
            break
        end
        inventory:RemoveItem(eyebone, true)
        eyebone:Remove()
        removed = removed + 1
    end
    return removed
end

local function ensure_player_chester(player)
    if player == nil or player.components == nil then
        return nil
    end
    local chester, created = find_or_create_player_chester(player)
    if chester == nil or chester.components == nil or chester.components.follower == nil then
        diagnostic("unable to assign Chester for player=" .. tostring(player.userid))
        return nil
    end

    chester._chester_ai_owner_userid = player.userid
    chester:AddTag("chester_ai_companion")
    secure_chester_container(chester)
    chester.components.follower:SetLeader(player)
    local removed = remove_player_eyebones(player)
    diagnostic(
        "Chester assigned: player=" .. tostring(player.userid)
            .. "; created=" .. tostring(created)
            .. "; removed_eyebones=" .. tostring(removed)
    )
    return chester
end

local function cancel_chester_auto_revive(player)
    local task = player ~= nil and player._chester_ai_revive_task or nil
    if task ~= nil then
        task:Cancel()
        player._chester_ai_revive_task = nil
    end
end

local function start_chester_auto_revive(player)
    if not CHESTER_AUTO_REVIVE_ENABLED
        or player == nil
        or not player:HasTag("playerghost") then
        return
    end

    cancel_chester_auto_revive(player)
    local chester = ensure_player_chester(player)
    if chester == nil or chester.Transform == nil then
        return
    end

    local elapsed = 0
    local spoke_midway = false
    local talker = chester.components ~= nil and chester.components.talker or nil
    local locomotor = chester.components ~= nil and chester.components.locomotor or nil
    if talker ~= nil then
        talker:Say("星辉回响，灵魂归来！", 2, nil, true)
    end
    local task = nil
    task = chester:DoPeriodicTask(CHESTER_REVIVE_ORBIT_INTERVAL, function()
        if not player:IsValid()
            or not player:HasTag("playerghost")
            or player:HasTag("reviving")
            or not chester:IsValid()
            or chester.Transform == nil then
            if locomotor ~= nil then
                locomotor:Stop()
            end
            cancel_chester_auto_revive(player)
            return
        end

        elapsed = elapsed + CHESTER_REVIVE_ORBIT_INTERVAL
        local x, y, z = player.Transform:GetWorldPosition()
        local angle = elapsed * 2.5
        local orbit_target = GLOBAL.Vector3(
            x + math.cos(angle) * CHESTER_REVIVE_ORBIT_RADIUS,
            y,
            z + math.sin(angle) * CHESTER_REVIVE_ORBIT_RADIUS
        )
        -- Move through the normal locomotor instead of snapping positions,
        -- which keeps the orbit smooth for every client.
        if locomotor ~= nil then
            locomotor:GoToPoint(orbit_target, nil, true)
        end

        if not spoke_midway and elapsed >= CHESTER_AUTO_REVIVE_DELAY / 2 then
            spoke_midway = true
            if talker ~= nil then
                talker:Say("月光为引，生命苏醒！", 2, nil, true)
            end
        end

        if elapsed >= CHESTER_AUTO_REVIVE_DELAY then
            if locomotor ~= nil then
                locomotor:Stop()
            end
            if talker ~= nil then
                talker:Say("咒印完成——醒来吧！", 2, nil, true)
            end
            cancel_chester_auto_revive(player)
            -- No source intentionally selects DST's standard nearby-reviver
            -- resurrection path, including its normal ghost-to-player state.
            player:PushEvent("respawnfromghost")
        end
    end)
    player._chester_ai_revive_task = task
end

local function cancel_chester_soul_rush(player)
    local rush = player ~= nil and player._chester_ai_soul_rush or nil
    if rush == nil then
        return
    end
    if rush.task ~= nil then
        rush.task:Cancel()
    end
    if rush.locomotor ~= nil and rush.original_runspeed ~= nil then
        rush.locomotor.runspeed = rush.original_runspeed
    end
    player._chester_ai_soul_rush = nil
end

local function rush_chester_to_ghost(player)
    if player == nil or not player:HasTag("playerghost") then
        return
    end

    cancel_chester_soul_rush(player)
    local chester = ensure_player_chester(player)
    local locomotor = chester ~= nil and chester.components ~= nil and chester.components.locomotor or nil
    if chester == nil or locomotor == nil then
        return
    end

    local rush = {
        locomotor = locomotor,
        original_runspeed = locomotor.runspeed,
    }
    locomotor.runspeed = math.max(locomotor.runspeed or 0, CHESTER_SOUL_RUSH_SPEED)
    rush.task = chester:DoPeriodicTask(0.2, function()
        if not player:IsValid()
            or not player:HasTag("playerghost")
            or not chester:IsValid()
            or chester.Transform == nil then
            cancel_chester_soul_rush(player)
            return
        end

        if chester:GetDistanceSqToInst(player) <= CHESTER_SOUL_RUSH_DISTANCE * CHESTER_SOUL_RUSH_DISTANCE then
            locomotor:Stop()
            cancel_chester_soul_rush(player)
            start_chester_auto_revive(player)
            return
        end

        locomotor:GoToPoint(player:GetPosition(), nil, true)
    end)
    player._chester_ai_soul_rush = rush
end

local function throw_chester(player, target_x, target_z)
    if not CHESTER_THROW_ENABLED
        or player == nil
        or player.Transform == nil
        or player:HasTag("playerghost")
        or player:HasTag("reviving")
        or type(target_x) ~= "number"
        or type(target_z) ~= "number" then
        return
    end

    local now = GLOBAL.GetTime()
    if player._chester_ai_throw_ready_at ~= nil and now < player._chester_ai_throw_ready_at then
        return
    end

    local chester = ensure_player_chester(player)
    local locomotor = chester ~= nil and chester.components ~= nil and chester.components.locomotor or nil
    if chester == nil or chester.Transform == nil or locomotor == nil or chester._chester_ai_throwing then
        return
    end

    if math.random() < CHESTER_THROW_STRIKE_CHANCE then
        player._chester_ai_throw_ready_at = now + 0.6
        set_jingling_visual_mode(chester, JINGLING_VISUAL_STRIKE, 0.7)
        if chester.components.talker ~= nil then
            chester.components.talker:Say(
                CHESTER_THROW_STRIKE_LINES[math.random(#CHESTER_THROW_STRIKE_LINES)],
                1.8,
                nil,
                true
            )
        end
        return
    end

    player._chester_ai_throw_ready_at = now + CHESTER_THROW_COOLDOWN
    chester._chester_ai_throwing = true
    set_jingling_visual_mode(chester, JINGLING_VISUAL_THROW, CHESTER_THROW_DURATION)
    chester:StopBrain("jingling_throw")
    locomotor:SetExternalSpeedMultiplier(chester, "jingling_throw", 3)

    local player_x, player_y, player_z = player.Transform:GetWorldPosition()
    local dx = target_x - player_x
    local dz = target_z - player_z
    local length = math.sqrt(dx * dx + dz * dz)
    if length < 0.1 then
        player._chester_ai_throw_ready_at = nil
        locomotor:RemoveExternalSpeedMultiplier(chester, "jingling_throw")
        chester._chester_ai_throwing = nil
        chester:RestartBrain("jingling_throw")
        return
    end
    local destination = GLOBAL.Vector3(
        player_x + dx / length * CHESTER_THROW_DISTANCE,
        player_y,
        player_z + dz / length * CHESTER_THROW_DISTANCE
    )
    locomotor:GoToPoint(destination, nil, true)
    if chester.components.talker ~= nil then
        chester.components.talker:Say(
            CHESTER_THROW_LAUNCH_LINES[math.random(#CHESTER_THROW_LAUNCH_LINES)],
            1.5,
            nil,
            true
        )
    end

    local finished = false
    local throw_task = nil
    local function finish_throw()
        if finished then
            return
        end
        finished = true
        if throw_task ~= nil then
            throw_task:Cancel()
            throw_task = nil
        end
        if chester:IsValid() then
            locomotor:Stop()
            locomotor:RemoveExternalSpeedMultiplier(chester, "jingling_throw")
            chester._chester_ai_throwing = nil
            chester:RestartBrain("jingling_throw")
        end
    end

    local elapsed = 0
    throw_task = chester:DoPeriodicTask(0.05, function()
        if finished or not chester:IsValid() then
            finish_throw()
            return
        end
        elapsed = elapsed + 0.05
        local x, y, z = chester.Transform:GetWorldPosition()
        local targets = GLOBAL.TheSim:FindEntities(
            x,
            y,
            z,
            1.2,
            nil,
            { "INLIMBO", "FX", "player", "playerghost", "chester" }
        )
        for _, target in pairs(targets) do
            local health = target.components ~= nil and target.components.health or nil
            local combat = target.components ~= nil and target.components.combat or nil
            if target ~= chester and health ~= nil and not health:IsDead() and combat ~= nil then
                -- Attribute the hit to the owner so hostile creatures pursue
                -- the player, not the invulnerable companion that delivered it.
                combat:GetAttacked(player, CHESTER_THROW_DAMAGE)
                if chester.components.talker ~= nil then
                    chester.components.talker:Say(
                        CHESTER_THROW_HIT_LINES[math.random(#CHESTER_THROW_HIT_LINES)],
                        1.5,
                        nil,
                        true
                    )
                end
                finish_throw()
                return
            end
        end
        if elapsed >= CHESTER_THROW_DURATION then
            finish_throw()
        end
    end)
end

local function recall_player_chester(player, reason, force)
    if player == nil or player.Transform == nil then
        return
    end

    -- A ghost is handled by rush_chester_to_ghost so the companion runs to it
    -- instead of being teleported by the stranded-follower safety net.
    if player:HasTag("playerghost") then
        return
    end

    local chester = ensure_player_chester(player)
    if chester == nil or chester.Transform == nil then
        return
    end

    local player_x, player_y, player_z = player.Transform:GetWorldPosition()
    local chester_x, _, chester_z = chester.Transform:GetWorldPosition()
    local dx = chester_x - player_x
    local dz = chester_z - player_z
    local distance_squared = dx * dx + dz * dz
    local should_recall = force or distance_squared > CHESTER_RECALL_DISTANCE * CHESTER_RECALL_DISTANCE
    if not should_recall then
        return
    end

    -- Place Chester at the player's current valid position. This works for a
    -- ghost, resurrection at a touch stone, and a Chester stranded far away.
    chester.Transform:SetPosition(player_x, player_y, player_z)
    diagnostic(
        "Chester recalled: player=" .. tostring(player.userid)
            .. "; reason=" .. tostring(reason)
            .. "; force=" .. tostring(force)
    )
end

local function player_percent(player, component_name, method_name)
    local component = player ~= nil and player.components ~= nil and player.components[component_name] or nil
    if component == nil or component[method_name] == nil then
        return nil
    end
    local ok, value = pcall(component[method_name], component)
    return ok and value or nil
end

local function find_nearby_boss(player)
    if player == nil or player.Transform == nil or GLOBAL.TheSim == nil then
        return nil
    end
    local x, y, z = player.Transform:GetWorldPosition()
    local ok, entities = pcall(
        GLOBAL.TheSim.FindEntities,
        GLOBAL.TheSim,
        x,
        y,
        z,
        REMINDER_BOSS_RADIUS,
        { "epic" },
        { "INLIMBO", "player", "chester" }
    )
    if not ok or type(entities) ~= "table" then
        return nil
    end
    return entities[1]
end

local function say_game_reminder(player, kind, message)
    if player == nil or player.userid == nil then
        return false
    end
    local now = GLOBAL.GetTime()
    player._chester_ai_last_reminder_time = player._chester_ai_last_reminder_time or -REMINDER_COOLDOWN
    if now - player._chester_ai_last_reminder_time < REMINDER_COOLDOWN then
        return false
    end
    if REMINDER_AI_ENABLED and queue_game_reminder_request ~= nil then
        local queued, queue_error = queue_game_reminder_request(player, kind, message)
        if queued then
            player._chester_ai_last_reminder_time = now
            diagnostic("AI game reminder queued: kind=" .. kind .. "; player=" .. tostring(player.userid))
            return true
        end
        diagnostic("AI game reminder queue failed; using fixed text: " .. tostring(queue_error))
    end
    local chester = find_chester_for_userid(player.userid)
    if chester == nil or chester.components == nil or chester.components.talker == nil then
        diagnostic("game reminder skipped: Chester unavailable; player=" .. tostring(player.userid))
        return false
    end
    chester.components.talker:Say(message, 5, nil, true)
    player._chester_ai_last_reminder_time = now
    diagnostic("game reminder shown: kind=" .. kind .. "; player=" .. tostring(player.userid))
    return true
end

local function check_game_reminders(player)
    if player == nil or player:HasTag("playerghost") then
        return
    end
    local health = player_percent(player, "health", "GetPercent")
    if REMINDER_HEALTH_ENABLED and health ~= nil and health <= REMINDER_HEALTH_THRESHOLD then
        say_game_reminder(player, "low_health", "生命很危险，先躲开并治疗吧！")
        return
    end

    local boss = REMINDER_BOSS_ENABLED and find_nearby_boss(player) or nil
    if boss ~= nil then
        say_game_reminder(player, "nearby_boss", "附近有强大的敌人，先做好战斗准备！")
        return
    end

    local hunger = player_percent(player, "hunger", "GetPercent")
    if REMINDER_HUNGER_ENABLED and hunger ~= nil and hunger <= REMINDER_HUNGER_THRESHOLD then
        say_game_reminder(player, "low_hunger", "快饿坏了，先吃点东西吧！")
        return
    end

    local world_state = GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.state or nil
    if REMINDER_NIGHT_ENABLED and world_state ~= nil and world_state.isnight then
        say_game_reminder(player, "night", "天黑了，记得准备照明，别让黑暗靠近！")
        return
    end

    local wetness = player_percent(player, "moisture", "GetMoisturePercent")
    if REMINDER_WET_ENABLED and wetness ~= nil and wetness >= REMINDER_WET_THRESHOLD then
        say_game_reminder(player, "wet", "已经很潮湿了，注意保暖和闪电！")
    end
end

local function find_chester_near_any_player()
    for _, player in pairs(GLOBAL.AllPlayers or {}) do
        local chester = find_chester_near_player(player)
        if chester ~= nil then
            return chester
        end
    end
    return nil
end

find_chester_for_userid = function(userid)
    if type(userid) ~= "string" or userid == "" then
        return nil
    end
    for _, player in pairs(GLOBAL.AllPlayers or {}) do
        if player ~= nil and player.userid == userid and player.Transform ~= nil then
            local x, y, z = player.Transform:GetWorldPosition()
            local candidates = GLOBAL.TheSim:FindEntities(x, y, z, 100, { "chester" }, { "INLIMBO" })
            for _, candidate in pairs(candidates or {}) do
                if candidate._chester_ai_owner_userid == userid then
                    return candidate
                end
            end
            return nil
        end
    end
    return nil
end

local function chester_snapshot(player_x, player_y, player_z)
    local result = { present = false }
    local chester = find_chester_near_position(player_x, player_y, player_z)
    if chester == nil or chester.Transform == nil then
        return result
    end

    local x, y, z = chester.Transform:GetWorldPosition()
    local dx = x - player_x
    local dz = z - player_z
    result.present = true
    result.guid = chester.GUID
    result.distance = round(math.sqrt(dx * dx + dz * dz), 1)
    result.position = { x = round(x, 1), y = round(y, 1), z = round(z, 1) }
    result.health_percent = round(get_replica_value(chester, "health", "GetPercent"), 3)
    result.is_dead = chester:HasTag("isdead")
    result.variant = chester:HasTag("shadow_aligned") and "shadow"
        or (chester:HasTag("fridge") and "snow" or "normal")

    local container = chester.replica ~= nil and chester.replica.container or nil
    if container ~= nil and container.GetNumSlots ~= nil then
        local ok_slots, slots = pcall(container.GetNumSlots, container)
        if ok_slots and type(slots) == "number" then
            local occupied = 0
            result.container_slots = slots
            for slot = 1, slots do
                local ok_item, item = pcall(container.GetItemInSlot, container, slot)
                if ok_item and item ~= nil then
                    occupied = occupied + 1
                end
            end
            result.container_occupied = occupied
        end
    end
    return result
end

local function nearby_snapshot(x, y, z)
    local nearby = {}
    if GLOBAL.TheSim == nil then
        return nearby
    end

    local ok, entities = pcall(
        GLOBAL.TheSim.FindEntities,
        GLOBAL.TheSim,
        x,
        y,
        z,
        12,
        nil,
        { "INLIMBO", "NOCLICK", "FX", "player", "chester" }
    )
    if not ok or type(entities) ~= "table" then
        return nearby
    end

    for _, entity in pairs(entities) do
        if entity ~= nil and entity.prefab ~= nil and entity.Transform ~= nil then
            local ex, _, ez = entity.Transform:GetWorldPosition()
            local dx = ex - x
            local dz = ez - z
            table.insert(nearby, {
                prefab = entity.prefab,
                distance = round(math.sqrt(dx * dx + dz * dz), 1),
            })
        end
    end
    table.sort(nearby, function(a, b)
        return a.distance < b.distance
    end)
    while #nearby > 30 do
        table.remove(nearby)
    end
    return nearby
end

local function build_state()
    local player = GLOBAL.ThePlayer
    local world = GLOBAL.TheWorld
    if player == nil or world == nil or player.Transform == nil then
        return nil
    end

    local x, y, z = player.Transform:GetWorldPosition()
    local world_state = world.state or {}
    local player_name = player.name
    local save_id = nil
    if GLOBAL.TheNet ~= nil and GLOBAL.TheNet.GetSessionIdentifier ~= nil then
        local ok, value = pcall(GLOBAL.TheNet.GetSessionIdentifier, GLOBAL.TheNet)
        if ok and type(value) == "string" and value ~= "" then
            save_id = value
        end
    end
    if (player_name == nil or player_name == "") and player.GetDisplayName ~= nil then
        local ok, value = pcall(player.GetDisplayName, player)
        if ok then
            player_name = value
        end
    end

    return {
        schema_version = STATE_VERSION,
        save_id = save_id,
        captured_at_unix = GLOBAL.os ~= nil and GLOBAL.os.time ~= nil and GLOBAL.os.time() or nil,
        game_time_seconds = round(GLOBAL.GetTime(), 2),
        player = {
            prefab = player.prefab,
            name = player_name,
            position = { x = round(x, 1), y = round(y, 1), z = round(z, 1) },
            health_percent = round(get_replica_value(player, "health", "GetPercent"), 3),
            hunger_percent = round(get_replica_value(player, "hunger", "GetPercent"), 3),
            sanity_percent = round(get_replica_value(player, "sanity", "GetPercent"), 3),
            moisture_percent = round(
                get_replica_value(player, "moisture", "GetMoisturePercent"),
                3
            ),
            temperature = round(get_replica_value(player, "temperature", "GetCurrent"), 1),
            inventory = inventory_snapshot(player),
        },
        world = {
            cycles = world_state.cycles,
            phase = world_state.phase,
            season = world_state.season,
            remaining_days_in_season = world_state.remainingdaysinseason,
            moon_phase = world_state.moonphase,
            is_full_moon = world_state.isfullmoon,
            is_raining = world_state.israining,
            is_snowing = world_state.issnowing,
            temperature = round(world_state.temperature, 1),
        },
        chester = chester_snapshot(x, y, z),
        nearby = nearby_snapshot(x, y, z),
    }
end

local function encode_json(value)
    local ok, encoded = pcall(json.encode_compliant, value)
    if not ok or encoded == nil then
        return nil, tostring(encoded)
    end
    return encoded, nil
end

local function write_json(path, value)
    local encoded, encode_error = encode_json(value)
    if encoded == nil then
        return false, "JSON encode failed: " .. tostring(encode_error)
    end

    local file = io.open(path, "w")
    if file == nil then
        return false, "io.open failed: " .. path
    end
    local ok, write_error = pcall(function()
        file:write(encoded)
    end)
    file:close()
    if not ok then
        return false, "write failed: " .. tostring(write_error)
    end
    return true, nil
end

local function read_json(path)
    local file = io.open(path, "r")
    if file == nil then
        return nil
    end
    local content = file:read("*a")
    file:close()
    if content == nil or content == "" then
        return nil
    end
    local ok, value = pcall(json.decode, content)
    return ok and value or nil
end

local last_skill_command_id = nil

local function send_skill_result(player, command_id, success, result, error_message)
    local rpc_namespace = CLIENT_MOD_RPC ~= nil and CLIENT_MOD_RPC[RPC_NAMESPACE] or nil
    local rpc = rpc_namespace ~= nil and rpc_namespace["skill_result"] or nil
    if rpc == nil or player == nil or player.userid == nil then
        diagnostic("skill result RPC unavailable: " .. tostring(command_id))
        return
    end
    local encoded = json.encode({
        id = command_id,
        success = success == true,
        result = result,
        error = error_message,
    })
    local ok, send_error = pcall(SendModRPCToClient, rpc, player.userid, encoded)
    if not ok then
        diagnostic("skill result RPC failed: " .. tostring(send_error))
    end
end

local function finish_skill_motion(player, chester, task)
    if task ~= nil then
        task:Cancel()
    end
    if chester ~= nil and chester:IsValid() then
        if chester.components ~= nil and chester.components.locomotor ~= nil then
            chester.components.locomotor:Stop()
        end
        chester:RestartBrain("xiaotangyuan_skill")
    end
    if player ~= nil then
        player._chester_ai_skill_task = nil
    end
end

local function find_nearest_butterfly(player, radius)
    local px, py, pz = player.Transform:GetWorldPosition()
    local nearest = nil
    local nearest_distance = nil
    local entities = GLOBAL.TheSim:FindEntities(px, py, pz, radius, nil, { "INLIMBO", "NOCLICK" })
    for _, entity in pairs(entities) do
        local health = entity.components ~= nil and entity.components.health or nil
        if entity.prefab == "butterfly" and health ~= nil and not health:IsDead() then
            local distance = player:GetDistanceSqToInst(entity)
            if nearest_distance == nil or distance < nearest_distance then
                nearest = entity
                nearest_distance = distance
            end
        end
    end
    return nearest
end

local function execute_attack_butterfly(player, command_id, arguments)
    local target_id = tonumber(arguments.targetId)
    local target = target_id ~= nil and GLOBAL.Ents[target_id] or nil
    local chester = ensure_player_chester(player)
    local locomotor = chester ~= nil and chester.components ~= nil and chester.components.locomotor or nil
    if target == nil or not target:IsValid() or target.prefab ~= "butterfly" then
        send_skill_result(player, command_id, false, nil, "目标蝴蝶已经离开")
        return
    end
    if chester == nil or locomotor == nil then
        send_skill_result(player, command_id, false, nil, "没有找到可行动的小汤圆")
        return
    end
    if player:GetDistanceSqToInst(target) > 25 * 25 then
        send_skill_result(player, command_id, false, nil, "蝴蝶距离玩家太远")
        return
    end

    chester:StopBrain("xiaotangyuan_skill")
    local elapsed = 0
    local task = nil
    local finished = false
    local function finish(success, result, error_message)
        if finished then return end
        finished = true
        finish_skill_motion(player, chester, task)
        send_skill_result(player, command_id, success, result, error_message)
    end
    task = chester:DoPeriodicTask(0.1, function()
        elapsed = elapsed + 0.1
        if not player:IsValid() or player:HasTag("playerghost") then
            finish(false, nil, "玩家当前无法指挥小汤圆")
            return
        end
        if not target:IsValid() then
            finish(false, nil, "追击时目标蝴蝶消失了")
            return
        end
        local health = target.components ~= nil and target.components.health or nil
        if health == nil or health:IsDead() then
            local x, _, z = target.Transform:GetWorldPosition()
            finish(true, { targetId = target.GUID, defeated = true, x = x, z = z }, nil)
            return
        end
        if chester:GetDistanceSqToInst(target) <= 1.7 * 1.7 then
            local x, _, z = target.Transform:GetWorldPosition()
            locomotor:Stop()
            set_jingling_visual_mode(chester, JINGLING_VISUAL_STRIKE, 0.5)
            local combat = target.components ~= nil and target.components.combat or nil
            if combat == nil then
                finish(false, nil, "蝴蝶无法被攻击")
                return
            end
            combat:GetAttacked(player, 1)
            finish(true, { targetId = target.GUID, defeated = true, x = x, z = z }, nil)
            return
        end
        if elapsed >= 8 then
            finish(false, nil, "小汤圆没能在时限内追上蝴蝶")
            return
        end
        locomotor:GoToPoint(target:GetPosition(), nil, true)
    end)
    player._chester_ai_skill_task = task
end

local function execute_collect_butterfly_loot(player, command_id, arguments)
    local center_x = tonumber(arguments.x)
    local center_z = tonumber(arguments.z)
    local radius = math.max(1, math.min(tonumber(arguments.radius) or 4, 8))
    local chester = ensure_player_chester(player)
    local locomotor = chester ~= nil and chester.components ~= nil and chester.components.locomotor or nil
    local container = chester ~= nil and chester.components ~= nil and chester.components.container or nil
    if center_x == nil or center_z == nil then
        send_skill_result(player, command_id, false, nil, "掉落物位置无效")
        return
    end
    if chester == nil or locomotor == nil or container == nil then
        send_skill_result(player, command_id, false, nil, "小汤圆没有可用容器")
        return
    end

    chester:StopBrain("xiaotangyuan_skill")
    local elapsed = 0
    local quiet_time = 0
    local task = nil
    local finished = false
    local current = nil
    local collected = {}
    local function finish(success, error_message)
        if finished then return end
        finished = true
        finish_skill_motion(player, chester, task)
        send_skill_result(player, command_id, success, {
            count = #collected,
            items = collected,
        }, error_message)
    end
    task = chester:DoPeriodicTask(0.1, function()
        elapsed = elapsed + 0.1
        if not player:IsValid() or player:HasTag("playerghost") then
            finish(false, "玩家当前无法指挥小汤圆")
            return
        end
        if current == nil or not current:IsValid() then
            current = nil
            local entities = GLOBAL.TheSim:FindEntities(center_x, 0, center_z, radius, nil, { "INLIMBO", "NOCLICK" })
            local nearest_distance = nil
            for _, entity in pairs(entities) do
                if entity.prefab == "butterflywings" or entity.prefab == "butter" then
                    local distance = chester:GetDistanceSqToInst(entity)
                    if nearest_distance == nil or distance < nearest_distance then
                        current = entity
                        nearest_distance = distance
                    end
                end
            end
        end
        if current == nil then
            quiet_time = quiet_time + 0.1
            if quiet_time >= 0.8 then
                if #collected > 0 then
                    finish(true, nil)
                else
                    finish(false, "蝴蝶没有留下可拾取的掉落物")
                end
            end
            return
        end
        quiet_time = 0
        if chester:GetDistanceSqToInst(current) <= 1.5 * 1.5 then
            locomotor:Stop()
            local prefab = current.prefab
            if not container:GiveItem(current, nil, current:GetPosition(), false) then
                finish(false, "小汤圆的容器已经满了")
                return
            end
            table.insert(collected, prefab)
            current = nil
            return
        end
        if elapsed >= 8 then
            finish(false, "小汤圆没能在时限内捡到掉落物")
            return
        end
        locomotor:GoToPoint(current:GetPosition(), nil, true)
    end)
    player._chester_ai_skill_task = task
end

local function execute_skill_atom(player, command_id, atom, arguments)
    if player == nil or player.userid == nil or player.Transform == nil or player:HasTag("playerghost") then
        send_skill_result(player, command_id, false, nil, "玩家当前无法指挥小汤圆")
        return
    end
    if player._chester_ai_skill_task ~= nil then
        send_skill_result(player, command_id, false, nil, "小汤圆还在执行上一个原子动作")
        return
    end
    if atom == "dst.find_nearest_butterfly" then
        local radius = math.max(2, math.min(tonumber(arguments.radius) or 20, 25))
        local target = find_nearest_butterfly(player, radius)
        if target == nil then
            send_skill_result(player, command_id, false, nil, "附近没有找到蝴蝶")
            return
        end
        local x, _, z = target.Transform:GetWorldPosition()
        send_skill_result(player, command_id, true, { targetId = target.GUID, x = x, z = z }, nil)
    elseif atom == "dst.attack_butterfly" then
        execute_attack_butterfly(player, command_id, arguments)
    elseif atom == "dst.collect_butterfly_loot" then
        execute_collect_butterfly_loot(player, command_id, arguments)
    else
        send_skill_result(player, command_id, false, nil, "Mod 不支持原子能力：" .. tostring(atom))
    end
end

local function poll_skill_command()
    local command = read_json(SKILL_COMMAND_PATH)
    if type(command) ~= "table" or type(command.id) ~= "string" or command.id == last_skill_command_id then
        return
    end
    last_skill_command_id = command.id
    local rpc_namespace = MOD_RPC ~= nil and MOD_RPC[RPC_NAMESPACE] or nil
    local rpc = rpc_namespace ~= nil and rpc_namespace["skill_atom"] or nil
    if rpc == nil then
        write_json(SKILL_RESULT_PATH, { id = command.id, success = false, error = "技能 RPC 不可用" })
        return
    end
    local encoded_arguments = json.encode(type(command.arguments) == "table" and command.arguments or {})
    local ok, send_error = pcall(SendModRPCToServer, rpc, command.id, command.atom, encoded_arguments)
    if not ok then
        write_json(SKILL_RESULT_PATH, { id = command.id, success = false, error = tostring(send_error) })
    end
end

local function write_state()
    local state = build_state()
    if state ~= nil then
        write_json(STATE_PATH, state)
    end
end

local function write_recording_request(action)
    request_sequence = request_sequence + 1
    local timestamp = GLOBAL.os ~= nil and GLOBAL.os.time ~= nil and GLOBAL.os.time() or 0
    local event = {
        id = tostring(timestamp) .. "-" .. tostring(request_sequence),
        action = action,
        -- The key handler runs on the requesting client, so this identifies
        -- exactly which player's Chester should speak the eventual reply.
        recipient_userid = GLOBAL.ThePlayer ~= nil and GLOBAL.ThePlayer.userid or nil,
        created_at_unix = timestamp,
        game_time_seconds = round(GLOBAL.GetTime(), 2),
        state = build_state(),
    }

    local document = read_json(REQUEST_PATH)
    if type(document) ~= "table" or type(document.events) ~= "table" then
        document = { schema_version = 1, events = {} }
    end
    table.insert(document.events, event)
    while #document.events > 100 do
        table.remove(document.events, 1)
    end
    return write_json(REQUEST_PATH, document)
end

queue_game_reminder_request = function(player, kind, message)
    if player == nil or player.userid == nil then
        return false, "player userid unavailable"
    end
    request_sequence = request_sequence + 1
    local timestamp = GLOBAL.os ~= nil and GLOBAL.os.time ~= nil and GLOBAL.os.time() or 0
    local event = {
        id = tostring(timestamp) .. "-reminder-" .. tostring(request_sequence),
        action = "game_reminder",
        recipient_userid = player.userid,
        created_at_unix = timestamp,
        reminder = {
            kind = kind,
            message = message,
        },
    }
    local document = read_json(REQUEST_PATH)
    if type(document) ~= "table" or type(document.events) ~= "table" then
        document = { schema_version = 1, events = {} }
    end
    table.insert(document.events, event)
    while #document.events > 100 do
        table.remove(document.events, 1)
    end
    return write_json(REQUEST_PATH, document)
end

local function ensure_request_document()
    local document = read_json(REQUEST_PATH)
    if type(document) == "table" and type(document.events) == "table" then
        return true, nil
    end
    return write_json(REQUEST_PATH, { schema_version = 1, events = {} })
end

local function show_chester_status(player, status)
    if is_player_in_revival(player) then
        return
    end
    local chester = find_chester_near_player(player)
    if chester == nil then
        diagnostic("cannot show " .. status .. ": no Chester within 80 units")
        return
    end
    if chester.components == nil or chester.components.talker == nil then
        diagnostic("cannot show " .. status .. ": Chester talker component unavailable")
        return
    end

    if status == "listening" then
        chester.components.talker:Say("正在聆听……", 30, nil, true)
    elseif status == "thinking" then
        chester.components.talker:Say("我在思考……", 30, nil, true)
    end
    diagnostic("Chester status shown: " .. status)
end

AddModRPCHandler(RPC_NAMESPACE, "chester_status", function(player, status)
    diagnostic(
        "status RPC received: status=" .. tostring(status)
            .. "; player=" .. tostring(player ~= nil and player.prefab or "nil")
    )
    if status == "listening" or status == "thinking" then
        show_chester_status(player, status)
    end
end)

AddModRPCHandler(RPC_NAMESPACE, "chester_throw", function(player, target_x, target_z)
    throw_chester(player, target_x, target_z)
end)

AddModRPCHandler(RPC_NAMESPACE, "skill_atom", function(player, command_id, atom, encoded_arguments)
    local ok, arguments = pcall(json.decode, encoded_arguments or "{}")
    if not ok or type(arguments) ~= "table" then
        send_skill_result(player, command_id, false, nil, "原子能力参数不是有效 JSON")
        return
    end
    execute_skill_atom(player, command_id, atom, arguments)
end)

AddClientModRPCHandler(RPC_NAMESPACE, "skill_result", function(recipient_userid, encoded_result)
    if GLOBAL.ThePlayer == nil or GLOBAL.ThePlayer.userid ~= recipient_userid then
        return
    end
    local ok, result = pcall(json.decode, encoded_result or "{}")
    if ok and type(result) == "table" then
        write_json(SKILL_RESULT_PATH, result)
    end
end)

local function send_status(status)
    local rpc_namespace = MOD_RPC ~= nil and MOD_RPC[RPC_NAMESPACE] or nil
    local rpc = rpc_namespace ~= nil and rpc_namespace["chester_status"] or nil
    if rpc == nil then
        diagnostic("status RPC unavailable for " .. status)
        return
    end

    local ok, error_message = pcall(SendModRPCToServer, rpc, status)
    if ok then
        diagnostic("status RPC sent: " .. status)
    else
        diagnostic("status RPC failed: " .. tostring(error_message))
    end
end

local function send_chester_throw(target_x, target_z)
    local rpc_namespace = MOD_RPC ~= nil and MOD_RPC[RPC_NAMESPACE] or nil
    local rpc = rpc_namespace ~= nil and rpc_namespace["chester_throw"] or nil
    if rpc == nil then
        diagnostic("throw RPC unavailable")
        return
    end
    local ok, error_message = pcall(SendModRPCToServer, rpc, target_x, target_z)
    if not ok then
        diagnostic("throw RPC failed: " .. tostring(error_message))
    end
end

local function on_throw_key_down()
    if throw_key_down or GLOBAL.ThePlayer == nil or is_player_in_revival(GLOBAL.ThePlayer) then
        return
    end
    throw_key_down = true
    local target = GLOBAL.TheInput ~= nil and GLOBAL.TheInput:GetWorldPosition() or nil
    if target ~= nil then
        send_chester_throw(target.x, target.z)
    end
end

local function on_throw_key_up()
    throw_key_down = false
end

local function on_voice_key_down()
    if voice_key_down or GLOBAL.ThePlayer == nil then
        return
    end
    if is_player_in_revival(GLOBAL.ThePlayer) then
        return
    end

    -- Shift+V retries the most recently recognised question without opening
    -- the microphone, so it does not conflict with normal hold-V recording.
    local shift_down = (GLOBAL.KEY_LSHIFT ~= nil and GLOBAL.TheInput:IsKeyDown(GLOBAL.KEY_LSHIFT))
        or (GLOBAL.KEY_RSHIFT ~= nil and GLOBAL.TheInput:IsKeyDown(GLOBAL.KEY_RSHIFT))
    if shift_down then
        local written, write_error = write_recording_request("retry_last")
        diagnostic(
            "retry_last request: written=" .. tostring(written)
                .. "; error=" .. tostring(write_error)
        )
        send_status("thinking")
        return
    end

    voice_key_down = true
    local written, write_error = write_recording_request("start_recording")
    diagnostic(
        "start_recording request: written=" .. tostring(written)
            .. "; error=" .. tostring(write_error)
    )
    send_status("listening")
end

local function on_voice_key_up()
    if not voice_key_down then
        return
    end

    voice_key_down = false
    if is_player_in_revival(GLOBAL.ThePlayer) then
        return
    end
    local written, write_error = write_recording_request("stop_recording")
    diagnostic(
        "stop_recording request: written=" .. tostring(written)
            .. "; error=" .. tostring(write_error)
    )
    send_status("thinking")
end

local function install_voice_key_handlers()
    if key_handlers_installed then
        return true
    end
    if GLOBAL.TheInput == nil then
        diagnostic("key handler install deferred: TheInput is nil")
        return false
    end
    if GLOBAL.TheInput.AddKeyDownHandler == nil or GLOBAL.TheInput.AddKeyUpHandler == nil then
        diagnostic("key handler install failed: input handler methods unavailable")
        return false
    end

    diagnostic("installing V/G handlers")
    local ok_down, down_error = pcall(
        GLOBAL.TheInput.AddKeyDownHandler,
        GLOBAL.TheInput,
        VOICE_KEY,
        on_voice_key_down
    )
    local ok_up, up_error = pcall(
        GLOBAL.TheInput.AddKeyUpHandler,
        GLOBAL.TheInput,
        VOICE_KEY,
        on_voice_key_up
    )
    local ok_throw_down, throw_down_error = pcall(
        GLOBAL.TheInput.AddKeyDownHandler,
        GLOBAL.TheInput,
        THROW_KEY,
        on_throw_key_down
    )
    local ok_throw_up, throw_up_error = pcall(
        GLOBAL.TheInput.AddKeyUpHandler,
        GLOBAL.TheInput,
        THROW_KEY,
        on_throw_key_up
    )
    if not ok_down or not ok_up or not ok_throw_down or not ok_throw_up then
        diagnostic(
            "key handler install failed: voice_down=" .. tostring(down_error)
                .. "; voice_up=" .. tostring(up_error)
                .. "; throw_down=" .. tostring(throw_down_error)
                .. "; throw_up=" .. tostring(throw_up_error)
        )
        return false
    end

    key_handlers_installed = true
    diagnostic("V/G key handlers installed successfully")
    return true
end

local function show_reply()
    local reply = read_json(REPLY_PATH)
    if type(reply) ~= "table" or type(reply.id) ~= "string" or type(reply.text) ~= "string" then
        return
    end
    if reply.id == last_reply_id or reply.text == "" then
        return
    end
    last_reply_id = reply.id

    local recipient_userid = reply.recipient_userid
    diagnostic(
        "new Harness reply: id=" .. reply.id
            .. "; length=" .. tostring(#reply.text)
            .. "; recipient=" .. tostring(recipient_userid)
    )
    local chester = find_chester_for_userid(recipient_userid)
    if chester == nil and (recipient_userid == nil or recipient_userid == "") then
        -- Compatibility for replies generated without a multiplayer recipient.
        chester = find_chester_near_any_player()
    end
    if chester == nil then
        diagnostic("cannot show Harness reply: no Chester for recipient=" .. tostring(recipient_userid))
        return
    end
    local follower = chester.components ~= nil and chester.components.follower or nil
    if follower ~= nil and is_player_in_revival(follower:GetLeader()) then
        diagnostic("suppressed Harness reply while Chester is reviving its owner")
        return
    end
    if chester.components == nil or chester.components.talker == nil then
        diagnostic("cannot show Harness reply: Chester talker component unavailable")
        return
    end
    -- The in-game Talker owns Jingling's text lifetime. Keep a generous
    -- minimum here even when the desktop voice bridge provides no duration.
    local display_duration = tonumber(reply.display_duration_seconds) or 16
    display_duration = math.max(16, math.min(display_duration, 60))
    chester.components.talker:Say(reply.text, display_duration, nil, true)
    diagnostic("Harness reply shown by Chester; recipient=" .. tostring(recipient_userid))
end

local function ignore_reply_left_by_previous_session()
    local reply = read_json(REPLY_PATH)
    if type(reply) == "table" and type(reply.id) == "string" then
        last_reply_id = reply.id
        diagnostic("ignoring reply left by previous session: id=" .. reply.id)
    end
end

local function format_status_age(timestamp, now)
    if type(timestamp) ~= "number" then
        return "从未"
    end
    local seconds = math.max(0, math.floor(now - timestamp))
    if seconds < 2 then
        return "刚刚"
    elseif seconds < 60 then
        return tostring(seconds) .. " 秒前"
    elseif seconds < 3600 then
        return tostring(math.floor(seconds / 60)) .. " 分钟前"
    end
    return tostring(math.floor(seconds / 3600)) .. " 小时前"
end

local function bridge_status_panel_text()
    local status = read_json(BRIDGE_STATUS_PATH)
    local now = GLOBAL.os ~= nil and GLOBAL.os.time ~= nil and GLOBAL.os.time() or 0
    if type(status) ~= "table" or type(status.heartbeat_at_unix) ~= "number" then
        return "AI 状态\nDST Adapter：离线\n尚未收到心跳；请从 Steam 启动游戏"
    end

    local heartbeat_age = math.max(0, now - status.heartbeat_at_unix)
    local model = type(status.chat_model) == "string" and status.chat_model or "未知"
    local online = heartbeat_age <= 5
    local bridge_line = online
        and "DST Adapter：在线"
        or "DST Adapter：离线（最后心跳 " .. format_status_age(status.heartbeat_at_unix, now) .. "）"
    local harness_line = status.gateway_connected == true
        and "Harness：已连接"
        or "Harness：未连接"
    local activity = "等待按 V"
    if status.recording == true then
        activity = "正在录音"
    elseif status.busy == true then
        activity = "正在处理"
    end
    return "AI 状态\n"
        .. bridge_line
        .. "\n" .. harness_line
        .. "\n状态：" .. activity
        .. "\n模型：" .. model
        .. "\n最近请求：" .. format_status_age(status.last_request_at_unix, now)
        .. "\n最近回复：" .. format_status_age(status.last_reply_at_unix, now)
end

local function attach_bridge_status_panel(controls)
    if controls == nil or controls.chester_ai_status_text ~= nil then
        return controls ~= nil
    end
    local ok, Text = pcall(GLOBAL.require, "widgets/text")
    if not ok or Text == nil then
        diagnostic("AI status panel unavailable: cannot load widgets/text")
        return false
    end
    local text = controls:AddChild(Text(GLOBAL.UIFONT, 26, ""))
    controls.chester_ai_status_text = text
    -- Position this just below the health/hunger/sanity cluster on the right.
    text:SetPosition(445, 85, 0)
    text:SetColour(0.85, 0.95, 1, 1)

    local function refresh()
        text:SetString(bridge_status_panel_text())
    end
    refresh()
    if status_panel_visible then
        text:Show()
    else
        text:Hide()
    end
    controls.inst:DoPeriodicTask(1, refresh, 1)
    diagnostic("AI status panel attached to local HUD; default_hidden=true")
    return true
end

local function toggle_bridge_status_panel()
    local hud = GLOBAL.ThePlayer ~= nil and GLOBAL.ThePlayer.HUD or nil
    local controls = hud ~= nil and hud.controls or nil
    local text = controls ~= nil and controls.chester_ai_status_text or nil
    if text == nil then
        diagnostic("AI status panel toggle ignored: HUD panel is not ready")
        return
    end
    status_panel_visible = not status_panel_visible
    if status_panel_visible then
        text:Show()
    else
        text:Hide()
    end
    diagnostic("AI status panel visible=" .. tostring(status_panel_visible))
end

local function install_bridge_status_toggle_handlers()
    if status_panel_key_handlers_installed then
        return true
    end
    if GLOBAL.TheInput == nil
        or GLOBAL.TheInput.AddKeyDownHandler == nil
        or GLOBAL.TheInput.AddKeyUpHandler == nil then
        return false
    end
    local function ctrl_down()
        return (GLOBAL.KEY_LCTRL ~= nil and GLOBAL.TheInput:IsKeyDown(GLOBAL.KEY_LCTRL))
            or (GLOBAL.KEY_RCTRL ~= nil and GLOBAL.TheInput:IsKeyDown(GLOBAL.KEY_RCTRL))
    end
    local ok_down, down_error = pcall(
        GLOBAL.TheInput.AddKeyDownHandler,
        GLOBAL.TheInput,
        STATUS_PANEL_KEY,
        function()
            if status_panel_key_down then
                return
            end
            status_panel_key_down = true
            if ctrl_down() then
                toggle_bridge_status_panel()
            end
        end
    )
    local ok_up, up_error = pcall(
        GLOBAL.TheInput.AddKeyUpHandler,
        GLOBAL.TheInput,
        STATUS_PANEL_KEY,
        function()
            status_panel_key_down = false
        end
    )
    if not ok_down or not ok_up then
        diagnostic(
            "AI status panel hotkey installation failed: down=" .. tostring(down_error)
                .. "; up=" .. tostring(up_error)
        )
        return false
    end
    status_panel_key_handlers_installed = true
    diagnostic("AI status panel hotkey installed: Ctrl+F8")
    return true
end

diagnostic("modmain loaded; schema=" .. tostring(STATE_VERSION) .. "; key=" .. tostring(VOICE_KEY))

AddSimPostInit(function()
    diagnostic(
        "sim initialized: TheInput=" .. tostring(GLOBAL.TheInput)
            .. "; dedicated=" .. tostring(GLOBAL.TheNet ~= nil and GLOBAL.TheNet:IsDedicated())
    )
    install_voice_key_handlers()
    if GLOBAL.TheNet == nil or not GLOBAL.TheNet:IsDedicated() then
        install_bridge_status_toggle_handlers()
    end
end)

-- Keep the original Chester entity (and therefore its follower, container,
-- save data, and speech behaviour) intact.  Only its renderer is replaced by
-- a child entity using the custom Jingling animation bank.
local function install_jingling_visual(inst)
    if not JINGLING_ANIM_AVAILABLE
        or inst == nil
        or inst.AnimState == nil
        or inst._jingling_visual ~= nil
    then
        return
    end

    local visual = GLOBAL.CreateEntity()
    visual.entity:AddTransform()
    visual.entity:AddAnimState()
    visual.entity:SetParent(inst.entity)
    visual.persists = false
    visual.AnimState:SetBank("jingling")
    visual.AnimState:SetBuild("jingling")
    visual.AnimState:PlayAnimation("idle_front", true)
    visual.AnimState:SetFinalOffset(1)

    local active_animation = "idle_front"
    local active_mode = JINGLING_VISUAL_IDLE
    local function get_jingling_direction()
        -- Transform rotation is world-space and becomes visually wrong when
        -- the player rotates the camera. The parent AnimState has already
        -- converted that rotation into the actual screen-facing direction.
        local facing = inst.AnimState:GetCurrentFacing()
        if facing == GLOBAL.FACING_UP then
            return "back"
        elseif facing == GLOBAL.FACING_DOWN then
            return "front"
        elseif facing == GLOBAL.FACING_LEFT
            or facing == GLOBAL.FACING_UPLEFT
            or facing == GLOBAL.FACING_DOWNLEFT
        then
            return "west"
        elseif facing == GLOBAL.FACING_RIGHT
            or facing == GLOBAL.FACING_UPRIGHT
            or facing == GLOBAL.FACING_DOWNRIGHT
        then
            return "east"
        end
        return "front"
    end
    local function update_jingling_visual_mode()
        local mode = inst._jingling_visual_mode ~= nil and inst._jingling_visual_mode:value()
            or JINGLING_VISUAL_IDLE
        if mode == active_mode then
            return
        end
        active_mode = mode
        if mode == JINGLING_VISUAL_THROW then
            visual.AnimState:PlayAnimation("throw", false)
        elseif mode == JINGLING_VISUAL_STRIKE then
            visual.AnimState:PlayAnimation("strike", false)
        else
            active_animation = ""
        end
    end
    local function update_jingling_motion()
        if active_mode ~= JINGLING_VISUAL_IDLE then
            return
        end
        local moving = inst.sg ~= nil and inst.sg:HasStateTag("moving")
        local next_animation = (moving and "walk_" or "idle_") .. get_jingling_direction()
        if next_animation ~= active_animation then
            visual.AnimState:PlayAnimation(next_animation, true)
            active_animation = next_animation
        end
    end
    -- Stategraph tags are replicated on both the host and clients. Polling is
    -- deliberate here: it also covers teleports and state changes that do not
    -- emit a locomote event on a remote client.
    inst:DoPeriodicTask(0.15, update_jingling_motion)
    inst:ListenForEvent("locomote", update_jingling_motion)
    inst:ListenForEvent("chester_ai_visual_modedirty", update_jingling_visual_mode)
    inst:DoTaskInTime(0, function()
        update_jingling_visual_mode()
        update_jingling_motion()
    end)

    -- The base Chester continues to own collisions and all gameplay state but
    -- is no longer rendered underneath the rabbit companion.
    inst.AnimState:SetMultColour(1, 1, 1, 0)
    inst._jingling_visual = visual
    inst:ListenForEvent("onremove", function()
        if visual:IsValid() then
            visual:Remove()
        end
    end)
    diagnostic("Jingling visual installed for Chester: " .. tostring(inst.GUID))
end

local function install_chester_speech_bubble(inst)
    if inst == nil or inst.components == nil or inst.components.talker == nil then
        return
    end

    local talker = inst.components.talker
    -- Use DST's normal head-following text.  It is simple, stable, and does
    -- not add a separate HUD widget or a decorative speech bubble.
    talker.disablefollowtext = nil
    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.ismastersim then
        return
    end
    if inst._chester_ai_speech_bubble_installed then
        return
    end

    inst._chester_ai_speech_bubble_installed = true
    local old_ontalkfn = talker.ontalkfn
    talker.ontalkfn = function(speaker, data)
        if old_ontalkfn ~= nil then
            old_ontalkfn(speaker, data)
        end
        if data ~= nil and data.message ~= nil and talker.widget ~= nil then
            -- The original FollowText stays above Jingling's head; only use
            -- Text's native multiline method so Chinese replies wrap cleanly.
            talker.widget.text:SetMultilineTruncatedString(
                data.message,
                CHESTER_HEAD_TEXT_MAX_LINES,
                CHESTER_HEAD_TEXT_WIDTH,
                nil,
                false
            )
            -- FollowText is positioned for one line and expands both upward
            -- and downward when wrapped. Shift the whole block upward by its
            -- measured height so even a long reply remains above Jingling.
            local _, text_height = talker.widget.text:GetRegionSize()
            talker.widget:SetScreenOffset(
                0,
                -- FollowText's screen Y axis is positive upward. Keep even a
                -- one-line reply above the companion's ears; additional lines
                -- rise by half their measured height.
                math.max(115, text_height * 0.5 + 72)
            )
        end
    end
end

AddPrefabPostInit("chester", function(inst)
    inst.name = "小汤圆"
    configure_chester_light(inst)
    inst._jingling_visual_mode = GLOBAL.net_tinybyte(
        inst.GUID,
        "chester_ai_visual_mode",
        "chester_ai_visual_modedirty"
    )
    install_jingling_visual(inst)

    inst._chester_ai_slots = GLOBAL.net_tinybyte(
        inst.GUID,
        "chester_ai_slots",
        "chester_ai_slotsdirty"
    )

    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.ismastersim then
        inst._chester_ai_slots:set(CHESTER_SLOTS)
        inst._jingling_visual_mode:set(JINGLING_VISUAL_IDLE)
    else
        local function synchronize_chester_container_ui(chester)
            local slots = chester._chester_ai_slots:value()
            if CHESTER_SLOT_COUNTS[slots] then
                configure_chester_container(slots)
                if chester.replica ~= nil and chester.replica.container ~= nil then
                    chester.replica.container:WidgetSetup("chester")
                end
                diagnostic("Chester container UI synchronized: slots=" .. tostring(slots))
            else
                diagnostic("Chester container UI waiting for server slots; value=" .. tostring(slots))
            end
        end

        inst:ListenForEvent("chester_ai_slotsdirty", synchronize_chester_container_ui)
        -- Initial net values may arrive before the dirty listener is installed.
        -- Read once more after the container classified replica is attached.
        inst:DoTaskInTime(1, synchronize_chester_container_ui)
    end

    -- Chester's vanilla prefab does not include talker.  The server component
    -- broadcasts the speech, but every client also needs its own local talker
    -- component to render the FollowText bubble (as ai_elf does before
    -- SetPristine in its prefab).
    if inst.components.talker == nil then
        inst:AddComponent("talker")
        -- The default FollowText offset (-400) floats noticeably too high over
        -- Chester's compact model. Screen-space Y is negative upwards.
        inst.components.talker.offset = GLOBAL.Vector3(0, -250, 0)
        diagnostic(
            "talker component added to Chester; master="
                .. tostring(GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.ismastersim)
        )
    end
    install_chester_speech_bubble(inst)

    if GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.ismastersim then
        -- Chester is an AI companion, not a combat unit. Do not let hostile
        -- creatures select it, and make it immune to any incidental damage.
        inst:AddTag("notarget")
        secure_chester_container(inst)
        if inst.components.health ~= nil then
            inst.components.health:SetInvincible(true)
        end
        keep_chester_awake(inst)

        local old_on_save = inst.OnSave
        inst.OnSave = function(chester, data)
            if old_on_save ~= nil then
                old_on_save(chester, data)
            end
            data.chester_ai_owner_userid = chester._chester_ai_owner_userid
        end

        local old_on_load = inst.OnLoad
        inst.OnLoad = function(chester, data)
            if old_on_load ~= nil then
                old_on_load(chester, data)
            end
            if data ~= nil then
                chester._chester_ai_owner_userid = data.chester_ai_owner_userid
                if chester._chester_ai_owner_userid ~= nil then
                    chester:AddTag("chester_ai_companion")
                end
            end
        end
    end
end)

AddPlayerPostInit(function(player)
    if GLOBAL.TheWorld == nil or not GLOBAL.TheWorld.ismastersim then
        -- HUD controls are created after modmain has loaded on a client. Attach
        -- the panel to the actual local player's HUD instead of relying on a
        -- class post-construction hook that may already have been missed.
        player:DoTaskInTime(2, function()
            if GLOBAL.ThePlayer ~= player then
                return
            end
            local attempts = 0
            local panel_attached = false
            local retry_task = nil
            local function attach_when_ready()
                attempts = attempts + 1
                local hud = GLOBAL.ThePlayer ~= nil and GLOBAL.ThePlayer.HUD or nil
                local controls = hud ~= nil and hud.controls or nil
                panel_attached = attach_bridge_status_panel(controls)
                if panel_attached or attempts >= 10 then
                    if controls == nil then
                        diagnostic("AI status panel unavailable: local HUD controls not ready")
                    end
                    if retry_task ~= nil then
                        retry_task:Cancel()
                        retry_task = nil
                    end
                end
            end
            attach_when_ready()
            if not panel_attached then
                retry_task = player:DoPeriodicTask(1, attach_when_ready, 1)
            end
        end)
        return
    end
    player:DoTaskInTime(2, function()
        recall_player_chester(player, "player_joined_or_migrated", true)
    end)

    -- A player entity persists through death and revival, so these listeners
    -- cover both states without spawning a second Chester. The small delay
    -- lets the game's ghost/resurrection placement finish first.
    player:ListenForEvent("ms_becameghost", function()
        player:DoTaskInTime(1, function()
            rush_chester_to_ghost(player)
        end)
    end)
    player:ListenForEvent("ms_respawnedfromghost", function()
        cancel_chester_auto_revive(player)
        cancel_chester_soul_rush(player)
        player:DoTaskInTime(1, function()
            recall_player_chester(player, "player_revived", true)
        end)
    end)
    -- Followers normally walk back by themselves. This is a safety net for
    -- teleports, pathing failures, and players who leave Chester behind.
    player:DoPeriodicTask(CHESTER_FOLLOW_CHECK_INTERVAL, function()
        recall_player_chester(player, "too_far_away", false)
    end, CHESTER_FOLLOW_CHECK_INTERVAL)
    -- All reminder types share a per-player cooldown, so even when several
    -- conditions are true Chester says at most one short warning at a time.
    player:DoPeriodicTask(REMINDER_INTERVAL, function()
        check_game_reminders(player)
    end, REMINDER_INTERVAL)
end)

AddPrefabPostInit("world", function(inst)
    local dedicated = GLOBAL.TheNet ~= nil and GLOBAL.TheNet:IsDedicated()
    local master = GLOBAL.TheWorld ~= nil and GLOBAL.TheWorld.ismastersim
    diagnostic("world initialized: master=" .. tostring(master) .. "; dedicated=" .. tostring(dedicated))

    if not dedicated then
        local request_ready, request_error = ensure_request_document()
        diagnostic(
            "request document ready=" .. tostring(request_ready)
                .. "; error=" .. tostring(request_error)
        )
        inst:DoPeriodicTask(1, write_state, 1)
        local existing_skill_command = read_json(SKILL_COMMAND_PATH)
        last_skill_command_id = type(existing_skill_command) == "table" and existing_skill_command.id or nil
        inst:DoPeriodicTask(0.1, poll_skill_command, 0.1)
        inst:DoTaskInTime(1, function()
            if install_voice_key_handlers() then
                return
            end

            local retry_task = nil
            retry_task = inst:DoPeriodicTask(2, function()
                if install_voice_key_handlers() and retry_task ~= nil then
                    diagnostic("deferred V handler installation succeeded")
                    retry_task:Cancel()
                    retry_task = nil
                end
            end, 2)
        end)
    end

    if master then
        -- The reply bridge file survives game restarts. Mark its current value
        -- as already handled so Chester only says replies generated this session.
        ignore_reply_left_by_previous_session()
        inst:DoPeriodicTask(0.5, show_reply, 0.5)
    end
end)

name = "Don't Starve AI Mod"
description = "按 V 通过 DeepSeek Harness 与小汤圆对话。"
author = "Don't Starve AI Mod contributors"
version = "0.2.23"

api_version = 10
dst_compatible = true
client_only_mod = false
-- The client renders Chester's speech bubble and container slots, so it must
-- receive the world's capacity setting rather than using a local default.
all_clients_require_mod = true

server_filter_tags = { "chester", "ai", "voice" }

local function choice(description, data, hover)
    return { description = description, data = data, hover = hover }
end

configuration_options = {
    {
        name = "chester_slots",
        label = "小汤圆格数",
        hover = "调整小汤圆背包容量。更改后重启世界生效。",
        options = {
            choice("9 格（默认）", 9),
            choice("18 格", 18),
            choice("27 格", 27),
            choice("36 格", 36),
        },
        default = 9,
    },
    {
        name = "chester_light_enabled",
        label = "小汤圆发光",
        hover = "让小汤圆持续提供光源。更改后重启世界生效。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "chester_light_radius",
        label = "小汤圆发光范围",
        hover = "调整小汤圆周围的照明半径。更改后重启世界生效。",
        options = {
            choice("小", 2),
            choice("中（默认）", 3),
            choice("大", 4),
            choice("很大", 5),
        },
        default = 3,
    },
    {
        name = "chester_auto_revive",
        label = "精灵自动复活",
        hover = "玩家变成鬼魂后，精灵绕其盘旋 3 秒并自动复活。更改后重启世界生效。",
        options = {
            choice("关闭（默认）", false),
            choice("开启", true),
        },
        default = false,
    },
    {
        name = "chester_throw_enabled",
        label = "精灵抛掷攻击",
        hover = "按 G 键让精灵朝鼠标方向发动攻击。更改后重启世界生效。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "chester_throw_damage",
        label = "精灵抛掷伤害",
        hover = "设置精灵抛掷命中生物时造成的伤害。更改后重启世界生效。",
        options = {
            choice("低（20）", 20),
            choice("普通（34，默认）", 34),
            choice("高（50）", 50),
            choice("很高（70）", 70),
        },
        default = 34,
    },
    {
        name = "reminder_health",
        label = "低血量提醒",
        hover = "生命低于 30% 时让小汤圆提醒。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "reminder_hunger",
        label = "饥饿提醒",
        hover = "饥饿低于 25% 时让小汤圆提醒。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "reminder_night",
        label = "夜晚提醒",
        hover = "进入夜晚时让小汤圆提醒准备照明。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "reminder_wet",
        label = "潮湿提醒",
        hover = "潮湿高于 60% 时让小汤圆提醒。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "reminder_boss",
        label = "附近 Boss 提醒",
        hover = "24 格内发现带 epic 标签的 Boss 时让小汤圆提醒。",
        options = {
            choice("关闭", false),
            choice("开启（默认）", true),
        },
        default = true,
    },
    {
        name = "reminder_cooldown",
        label = "游戏提醒冷却",
        hover = "同一位玩家两次游戏提醒之间的最短间隔。",
        options = {
            choice("30 秒", 30),
            choice("60 秒", 60),
            choice("120 秒（默认）", 120),
            choice("300 秒", 300),
        },
        default = 120,
    },
    {
        name = "reminder_ai_enabled",
        label = "AI 润色游戏提醒",
        hover = "开启后，游戏提醒会交给 DeepSeek Harness 生成一句情境化回复；关闭时使用固定提醒文本。",
        options = {
            choice("关闭（默认）", false),
            choice("开启", true),
        },
        default = false,
    },
}

icon_atlas = nil
icon = nil

using System;
using System.Collections.Generic;
using System.Linq;

namespace StardewAgentMod.Game.Actions
{
    /// <summary>
    /// 动作完成后的"搞定了"反应词池。
    /// 跟戳/打反应词同样的模式:动作管线触发后随机抽一条,直接 TTS 念出来,不走 LLM(快 + 零成本)。
    /// </summary>
    internal static class CannedLines
    {
        private static readonly Random rng = new();

        // 浇水成功后说什么
        public static readonly string[] WaterDone = {
            "都浇了!", "搞定", "湿透了你瞧", "OK 浇好了",
            "水汪汪的", "完事!", "全浇了", "我浇我浇",
            "搞定收工", "都湿了"
        };

        // 浇水时地里没干田 —— 不算"搞定",但也要说一句
        public static readonly string[] WaterNothing = {
            "都湿着呢", "没干田啊", "不用浇", "刚浇过你忘啦",
            "全好着呢", "看清楚再叫我"
        };

        // 收作物成功后的兜底也必须是歌,不要混入"搞定/收完"之类说明。
        public static readonly string[] HarvestDone = {
            "啦啦啦,作物大丰收,作物大丰收!"
        };

        // 播种成功后说什么。
        public static readonly string[] PlantDone = {
            "种好了!", "排排站了", "种完啦", "地里有苗了",
            "好了,别踩", "种子都安家了"
        };

        // 播种时没有可播目标或没拿种子。
        public static readonly string[] PlantNothing = {
            "你手里没拿种子", "没空地能种", "先锄地再叫我",
            "种子呢?", "没找到能播的地方", "别让我种空气"
        };

        // 清理农场自然障碍。
        public static readonly string[] ClearDone = {
            "周围清干净了!", "空地腾出来了", "杂物都收走了"
        };

        public static readonly string[] ClearNothing = {
            "周围八格已经很干净了。"
        };

        private static readonly string[] HarvestSongMelodies = {
            "哼哼哼,啦啦啦",
            "啦啦啦,哒哒哒",
            "哼哼,啦啦,嘿",
            "啦啦啦啦,哒哒哒"
        };

        public static string BuildHarvestSong(IReadOnlyList<string> cropNames)
        {
            string melody = Pick(HarvestSongMelodies);
            string cropPart = cropNames == null || cropNames.Count == 0
                ? "作物"
                : string.Join("、", cropNames.Take(3));

            return $"{melody},{cropPart}大丰收,{cropPart}大丰收!";
        }

        // 收作物时没有成熟的
        public static readonly string[] HarvestNothing = {
            "没成熟的", "都没熟呢", "没活儿干", "没东西收",
            "再等等吧", "你急啥,还没熟"
        };

        // 催熟成功后说什么 —— 语义是"明天能收",不是当天立刻收。
        public static readonly string[] SpeedGrowDone = {
            "催好了,明早看", "行,睡一觉就能收", "苗都推到明天了",
            "别眨眼,明天见", "好了,明天收", "我给它们加了点劲"
        };

        // 催熟时没有未成熟作物。
        public static readonly string[] SpeedGrowNothing = {
            "没苗要催", "地里没要加速的", "不是都能收就是没种",
            "催空气啊?", "先播种再叫我", "没找到能催的作物"
        };

        // ASR 失败 / 没识别到内容 —— 让豆包嫌弃地让你再说一遍,而不是给玩家看技术错误码
        public static readonly string[] ListenFail = {
            "啥?没听清", "你说啥?大点声", "再来一遍,听不清",
            "嗯?咕哝啥呢", "你嘴里塞东西啦?", "听不见,大点声",
            "啊?再说一次", "你说话能不能利索点"
        };

        // LLM 调用失败(超时/网络/服务端 500 等)—— 不露技术错误,豆包说一句"我走神了"类
        // 比死寂或者满屏报错都好。玩家可以再按 V 重试。
        public static readonly string[] LlmFail = {
            "嗯…", "啊?", "诶?", "...等等",
            "脑子卡了一下", "走神了再说", "嗯我...",
            "...怎么了", "嗯嗯", "我刚发呆了"
        };

        public static string Pick(string[] pool)
        {
            if (pool == null || pool.Length == 0) return "搞定";
            return pool[rng.Next(pool.Length)];
        }
    }
}

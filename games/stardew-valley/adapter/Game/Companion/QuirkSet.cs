using System;
using System.Text;

namespace StardewAgentMod.Game.Companion
{
    /// <summary>
    /// 每只豆包的"出厂性格" -- 同一个存档永远一样,不同存档各不相同。
    ///
    /// 实现:用存档文件夹名做稳定 hash 当随机种子(注意不能用 string.GetHashCode,
    /// .NET Core 对字符串哈希做了进程级随机化,重启就变;手写 31 进制稳定 hash)。
    /// 好处:不用持久化,删了记忆 JSON 性格也不丢 -- 性格是"天生的",记忆才是"后天的"。
    ///
    /// 注入方式:拼一段 [你的怪癖] 进 system prompt,LLM 在对话里自然流露;
    /// 个别怪癖(怕雷暴)另接主动说话触发器。
    /// </summary>
    internal sealed class QuirkSet
    {
        public string? FavoriteNpc;   // 60% 概率有
        public string? DislikedNpc;   // 60% 概率有(跟喜欢的不同人)
        public string CatchPhrase = "";
        public string Fear = "";
        public string Excitement = "";
        public string FoodPref = "";

        private static readonly string[] Npcs =
        {
            "Abigail", "Sam", "Sebastian", "Penny", "Maru", "Haley",
            "Emily", "Leah", "Alex", "Elliott", "Harvey", "Shane",
            "Lewis", "Marnie", "Gus", "Linus", "Robin", "Clint"
        };

        private static readonly string[] CatchPhrases =
        {
            "我跟你说啊...", "诶呀...", "啧啧啧...", "你猜怎么着...",
            "听我说...", "嗯哼,然后呢...", "我看是...", "我就觉得..."
        };

        private static readonly string[] Fears =
        {
            "雷暴", "鬼魂", "史莱姆", "深矿洞(60层以下)", "蝙蝠", "黑漆漆的下水道"
        };

        private static readonly string[] Excitements =
        {
            "鸡(看见就想凑近)", "亮晶晶的宝石", "兔子", "花田",
            "大鱼", "篝火", "星星", "牛"
        };

        private static readonly string[] FoodPrefs =
        {
            "甜食党(看农夫吃甜的就眼馋)", "咸口党", "闻不得辣", "什么都吃,不挑"
        };

        /// <summary>用存档名 roll 一套怪癖。同名存档永远同结果。</summary>
        public static QuirkSet Roll(string saveFolderName)
        {
            var rng = new Random(StableHash(saveFolderName));
            var q = new QuirkSet
            {
                CatchPhrase = CatchPhrases[rng.Next(CatchPhrases.Length)],
                Fear = Fears[rng.Next(Fears.Length)],
                Excitement = Excitements[rng.Next(Excitements.Length)],
                FoodPref = FoodPrefs[rng.Next(FoodPrefs.Length)]
            };
            if (rng.NextDouble() < 0.6)
                q.FavoriteNpc = Npcs[rng.Next(Npcs.Length)];
            if (rng.NextDouble() < 0.6)
            {
                string pick = Npcs[rng.Next(Npcs.Length)];
                if (pick != q.FavoriteNpc) q.DislikedNpc = pick;
            }
            return q;
        }

        public CompanionQuirkSnapshot Snapshot() => new(this.CatchPhrase, this.Fear, this.Excitement, this.FoodPref, this.FavoriteNpc, this.DislikedNpc);

        /// <summary>拼进 system prompt 的怪癖段。</summary>
        public string BuildPromptSection()
        {
            var sb = new StringBuilder();
            sb.Append("\n\n[你的怪癖](天生性格,不要直接对农夫报菜名,通过言行自然流露):");
            if (this.FavoriteNpc != null)
                sb.Append($"\n  - 你私下喜欢 {this.FavoriteNpc},聊到或见到 ta 时语气会软,可以委婉夸一句");
            if (this.DislikedNpc != null)
                sb.Append($"\n  - 你看 {this.DislikedNpc} 不顺眼,聊到时可以阴阳怪气一下");
            sb.Append($"\n  - 你的口头禅:\"{this.CatchPhrase}\"(偶尔用,每 5-10 句一次,别滥用)");
            sb.Append($"\n  - 你怕:{this.Fear}。涉及时语气紧张甚至想躲");
            sb.Append($"\n  - 你迷:{this.Excitement}。涉及时藏不住兴奋");
            sb.Append($"\n  - 饮食观:{this.FoodPref}");
            return sb.ToString();
        }

        /// <summary>稳定字符串 hash(31 进制),跨进程跨重启不变。</summary>
        private static int StableHash(string s)
        {
            unchecked
            {
                int h = 17;
                foreach (char c in s ?? "") h = h * 31 + c;
                return h;
            }
        }
    }
}

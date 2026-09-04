using System;
using System.Threading;
using StardewModdingAPI;

namespace StardewAgentMod.Game.Companion
{
    internal enum CompanionAppearance
    {
        Normal,
        Singing,
        Mounted
    }

    /// <summary>
    /// 把主 Mod 的运行状态映射到 TrinketTinker AltVariant。
    /// TTS 回调只改原子标记;真正的游戏对象反射调用统一留在 UpdateTicked 主线程。
    /// </summary>
    internal sealed class CompanionAppearanceController
    {
        public const string SingingVariantKey = "DOUBAO_SINGING";
        public const string RiderVariantKey = "DOUBAO_RIDER";

        private readonly CompanionLocator tracker;
        private readonly IMonitor monitor;

        private long nextSingingSession;
        private long invalidatedSingingSessions;
        private long activeSingingSession;
        private int mountedActive;
        private CompanionAppearance? appliedAppearance;

        public CompanionAppearanceController(CompanionLocator tracker, IMonitor monitor)
        {
            this.tracker = tracker;
            this.monitor = monitor;
        }

        /// <summary>为一次尚未开始播放的歌曲生成唯一会话号。</summary>
        public long ReserveSingingSession()
        {
            return Interlocked.Increment(ref this.nextSingingSession);
        }

        /// <summary>后台播放线程调用;只有未被生命周期 Reset 作废的会话才能生效。</summary>
        public void BeginSinging(long session)
        {
            if (session <= Volatile.Read(ref this.invalidatedSingingSessions)) return;
            Volatile.Write(ref this.activeSingingSession, session);
        }

        /// <summary>后台播放线程调用;旧语音结束不能误清掉后开始的新歌曲。</summary>
        public void EndSinging(long session)
        {
            Interlocked.CompareExchange(ref this.activeSingingSession, 0L, session);
        }

        /// <summary>由主线程根据飞行状态机更新;骑乘时先隐藏跟随实体,避免与真实坐骑重复。</summary>
        public void SetMountedActive(bool active)
        {
            Volatile.Write(ref this.mountedActive, active ? 1 : 0);
        }

        /// <summary>由 ModEntry.UpdateTicked 在主线程调用。</summary>
        public void Update()
        {
            CompanionAppearance desired = Volatile.Read(ref this.mountedActive) != 0
                ? CompanionAppearance.Mounted
                : Volatile.Read(ref this.activeSingingSession) != 0
                    ? CompanionAppearance.Singing
                    : CompanionAppearance.Normal;

            string key = desired switch
            {
                CompanionAppearance.Singing => SingingVariantKey,
                CompanionAppearance.Mounted => RiderVariantKey,
                _ => ""
            };

            this.tracker.TrySetCompanionHidden(desired == CompanionAppearance.Mounted);
            if (!this.tracker.TrySetAltVariant(key)) return;
            if (this.appliedAppearance == desired) return;

            this.appliedAppearance = desired;
            this.monitor.Log($"[贴图] 豆包外观切换为 {GetDisplayName(desired)}", LogLevel.Trace);
        }

        /// <summary>
        /// TrinketTinker 会在主人换图时重新检查 AltVariant 条件。
        /// 保留当前业务状态,只让下一次主线程 Update 重新把对应贴图写回去。
        /// </summary>
        public void ReapplyOnNextUpdate()
        {
            this.tracker.ResetAppearanceCache();
            this.appliedAppearance = null;
        }

        /// <summary>清理跨存档/过夜状态,并尽力把仍存在的同伴立即还原成正常贴图。</summary>
        public void Reset()
        {
            long issued = Volatile.Read(ref this.nextSingingSession);
            Volatile.Write(ref this.invalidatedSingingSessions, issued);
            Interlocked.Exchange(ref this.activeSingingSession, 0L);
            Volatile.Write(ref this.mountedActive, 0);

            this.tracker.TrySetCompanionHidden(false);
            this.tracker.TrySetAltVariant("");
            this.tracker.ResetAppearanceCache();
            this.appliedAppearance = null;
        }

        private static string GetDisplayName(CompanionAppearance appearance)
        {
            return appearance switch
            {
                CompanionAppearance.Singing => "唱歌",
                CompanionAppearance.Mounted => "骑乘隐藏",
                _ => "正常"
            };
        }
    }
}

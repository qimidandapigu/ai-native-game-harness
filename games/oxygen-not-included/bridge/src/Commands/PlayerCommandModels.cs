using System.Collections.Generic;

namespace DoubaoAI.ONI.Commands
{
    internal sealed class PlayerCommandActor
    {
        internal int Id;
        internal string Name;
        internal int Cell;
        internal bool Selected;
        internal bool CanReachMouse;
    }

    internal sealed class PlayerCommandSnapshot
    {
        internal int MouseCell = Grid.InvalidCell;
        internal string MouseElement = "未知";
        internal bool MouseCellSolid;
        internal int SelectedActorId = -1;
        internal List<PlayerCommandActor> Actors = new List<PlayerCommandActor>();
    }

    internal sealed class PlayerCommandPlan
    {
        public string Mode { get; set; }
        public string Action { get; set; }
        public string ActorScope { get; set; }
        public int ActorId { get; set; }
        public string ActorName { get; set; }
        public string BuildingKey { get; set; }
        public int TargetCell { get; set; }
        public bool Urgent { get; set; }
        public string Reply { get; set; }
    }

    internal sealed class PlayerCommandExecutionResult
    {
        internal bool Success;
        internal string Reply;
    }
}

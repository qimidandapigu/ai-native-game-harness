using System;
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;

namespace DoubaoAI.ONI.Commands
{
    internal static class PlayerCommandExecutor
    {
        private static readonly System.Reflection.FieldInfo ConstructableBuildChore =
            AccessTools.Field(typeof(Constructable), "buildChore");
        private static readonly System.Reflection.FieldInfo ConstructableFetchList =
            AccessTools.Field(typeof(Constructable), "fetchList");
        private static readonly List<ActiveDigPathPlan> ActiveDigPaths = new List<ActiveDigPathPlan>();
        private static float _nextDigPathTick;

        private sealed class ActiveDigPathPlan
        {
            internal int ActorId;
            internal string ActorName;
            internal bool Colony;
            internal bool Urgent;
            internal int TargetCell;
            internal List<int> Route;
            internal int Index = 1;
            internal float LastProgressAt;
        }

        internal static void Tick()
        {
            if (Time.unscaledTime < _nextDigPathTick) return;
            _nextDigPathTick = Time.unscaledTime + 0.35f;
            for (int i = ActiveDigPaths.Count - 1; i >= 0; i--)
            {
                ActiveDigPathPlan plan = ActiveDigPaths[i];
                try
                {
                    if (!AdvanceDigPath(plan)) continue;
                    ActiveDigPaths.RemoveAt(i);
                    Debug.Log("[DoubaoAI][Command] 分阶段挖路完成：target=" + plan.TargetCell);
                }
                catch (Exception ex)
                {
                    ActiveDigPaths.RemoveAt(i);
                    Debug.LogWarning("[DoubaoAI][Command] 分阶段挖路中止：target=" + plan.TargetCell +
                                     "，error=" + ex.Message);
                }
            }
        }

        internal static void Reset()
        {
            ActiveDigPaths.Clear();
            _nextDigPathTick = 0f;
        }

        internal static PlayerCommandExecutionResult Execute(PlayerCommandPlan plan)
        {
            if (plan == null) return Fail("这条命令没有解析成功，再说一次吧。");
            if (plan.Mode == "clarify")
            {
                Debug.Log("[DoubaoAI][Command] 命令需要补充人物：action=" + plan.Action);
                return Fail(string.IsNullOrWhiteSpace(plan.Reply)
                    ? "你想让哪位复制人来做？可以说名字，或者先选中他。"
                    : plan.Reply);
            }

            if (plan.ActorScope == "colony")
            {
                PlayerCommandExecutionResult colonyResult = ExecuteColony(plan);
                Debug.Log("[DoubaoAI][Command] scope=colony, action=" + plan.Action +
                          ", cell=" + plan.TargetCell +
                          ", success=" + colonyResult.Success +
                          ", result=" + colonyResult.Reply);
                return colonyResult;
            }

            MinionIdentity actor = FindActor(plan.ActorId, plan.ActorName);
            if (actor == null)
                return Fail("我没找到你点名的复制人。先选中他，或者再说一次完整名字。");
            if (!Grid.IsValidCell(plan.TargetCell))
                return Fail("鼠标没有指在当前星球的有效格子上。");

            string name = SafeName(actor);
            PlayerCommandExecutionResult result;
            if (plan.Action == "move") result = Move(actor, plan.TargetCell);
            else if (plan.Action == "dig") result = Dig(actor, plan.TargetCell, plan.Urgent);
            else if (plan.Action == "dig_path") result = StartDigPath(actor, plan.TargetCell, plan.Urgent);
            else result = Build(actor, plan.TargetCell, plan.BuildingKey, plan.Urgent);
            Debug.Log("[DoubaoAI][Command] actor=" + name +
                      ", action=" + plan.Action +
                      ", cell=" + plan.TargetCell +
                      ", success=" + result.Success +
                      ", result=" + result.Reply);
            return result;
        }

        private static PlayerCommandExecutionResult ExecuteColony(PlayerCommandPlan plan)
        {
            if (!Grid.IsValidCell(plan.TargetCell))
                return Fail("鼠标没有指在当前星球的有效格子上。");
            if (plan.Action == "move")
                return Fail("不能让所有人挤到同一个格子。请点名一个人移动，或者让大家执行具体工作。");
            if (plan.Action == "dig") return DigColony(plan.TargetCell, plan.Urgent);
            if (plan.Action == "dig_path") return StartDigPath(null, plan.TargetCell, plan.Urgent);
            return BuildColony(plan.TargetCell, plan.BuildingKey, plan.Urgent);
        }

        private static PlayerCommandExecutionResult DigColony(int cell, bool urgent)
        {
            if (!Grid.IsSolidCell(cell)) return Fail("鼠标这格不是可挖的实体。");
            if (Grid.Foundation[cell] || !Diggable.IsDiggable(cell) || Diggable.Undiggable(Grid.Element[cell]))
                return Fail("鼠标这格不能挖。");
            GameObject order = Grid.Objects[cell, (int)ObjectLayer.DigPlacer];
            bool created = order == null;
            if (order == null)
            {
                order = CreateDigOrder(cell);
                if (order == null) return Fail("创建公共挖掘差事失败了。");
            }
            Diggable target = order.GetComponent<Diggable>();
            if (target == null || !CanReachApproachable(null, target))
            {
                if (created) order.Trigger((int)GameHashes.Cancel);
                return Fail("这格虽然能挖，但目前没有复制人能站到施工位置。请从可达边缘开始，或者说“把这里挖通”。");
            }
            SetPriority(order, urgent ? 9 : 7);
            return Ok("已经在这里创建公共挖掘任务了，能挖的人会按优先级领取。");
        }

        private static PlayerCommandExecutionResult StartDigPath(MinionIdentity actor, int targetCell, bool urgent)
        {
            if (!Grid.IsValidCell(targetCell)) return Fail("鼠标没有指在当前星球的有效格子上。");
            List<int> route;
            int startCell;
            if (!TryFindDigRoute(actor, targetCell, 32, out route, out startCell))
                return Fail("附近找不到能从当前殖民地接上的施工入口。请把鼠标放到更靠近基地的目标上。");
            if (route.Count <= 1) return Fail("目标已经可以直接到达，不需要再挖路。");
            if (route.Count > 48) return Fail("这条路线超过 48 格，请分成两段下令。");

            int actorId = actor == null ? -1 : PlayerCommandContextCollector.GetId(actor);
            for (int i = ActiveDigPaths.Count - 1; i >= 0; i--)
            {
                ActiveDigPathPlan existing = ActiveDigPaths[i];
                if ((actor == null && existing.Colony) || (!existing.Colony && existing.ActorId == actorId))
                    ActiveDigPaths.RemoveAt(i);
            }
            var plan = new ActiveDigPathPlan
            {
                ActorId = actorId,
                ActorName = actor == null ? string.Empty : SafeName(actor),
                Colony = actor == null,
                Urgent = urgent,
                TargetCell = targetCell,
                Route = route,
                LastProgressAt = Time.unscaledTime
            };
            ActiveDigPaths.Add(plan);
            AdvanceDigPath(plan);

            int ladderSegments = 0;
            for (int i = 1; i < route.Count; i++)
                if (NeedsLadder(route[i - 1], route[i])) ladderSegments++;
            string who = actor == null ? "殖民地" : SafeName(actor);
            return Ok("已为" + who + "启动分阶段施工：先挖可达的一段，遇到高差或悬空处会补梯子，再继续向鼠标位置推进。" +
                      (ladderSegments > 0 ? "预计需要约" + ladderSegments + "段梯子。" : string.Empty));
        }

        private static bool AdvanceDigPath(ActiveDigPathPlan plan)
        {
            if (plan == null || plan.Route == null) return true;
            MinionIdentity actor = plan.Colony ? null : FindActor(plan.ActorId, plan.ActorName);
            if (!plan.Colony && actor == null)
            {
                Debug.LogWarning("[DoubaoAI][Command] 分阶段挖路中止：找不到指定复制人 " + plan.ActorName);
                return true;
            }

            while (plan.Index < plan.Route.Count)
            {
                int previous = plan.Route[plan.Index - 1];
                int cell = plan.Route[plan.Index];
                bool needsLadder = NeedsLadder(previous, cell);

                if (Grid.IsSolidCell(cell))
                {
                    if (!EnsureRouteDig(plan, actor, cell)) return false;
                    plan.LastProgressAt = Time.unscaledTime;
                    continue;
                }

                int px;
                int py;
                int cx;
                int cy;
                Grid.CellToXY(previous, out px, out py);
                Grid.CellToXY(cell, out cx, out cy);
                if (py == cy)
                {
                    int head = Grid.CellAbove(cell);
                    if (Grid.IsValidCell(head) && Grid.WorldIdx[head] == Grid.WorldIdx[plan.TargetCell] &&
                        Grid.IsSolidCell(head))
                    {
                        if (!IsDiggableCell(head))
                        {
                            Debug.LogWarning("[DoubaoAI][Command] 分阶段挖路中止：通道上方不可挖，cell=" + head);
                            return true;
                        }
                        if (!EnsureRouteDig(plan, actor, head)) return false;
                        plan.LastProgressAt = Time.unscaledTime;
                        continue;
                    }
                }

                if (needsLadder && !EnsureRouteLadder(plan, actor, cell)) return false;
                plan.Index++;
                plan.LastProgressAt = Time.unscaledTime;
                Debug.Log("[DoubaoAI][Command] 分阶段挖路推进：step=" + plan.Index + "/" + plan.Route.Count +
                          "，cell=" + cell + "，ladder=" + needsLadder);
            }
            return true;
        }

        private static bool EnsureRouteDig(ActiveDigPathPlan plan, MinionIdentity actor, int cell)
        {
            if (!Grid.IsSolidCell(cell)) return true;
            if (!IsDiggableCell(cell)) return false;
            GameObject order = Grid.Objects[cell, (int)ObjectLayer.DigPlacer];
            if (order == null) order = CreateDigOrder(cell);
            Diggable diggable = order == null ? null : order.GetComponent<Diggable>();
            if (diggable == null || diggable.chore == null) return false;
            SetPriority(order, plan.Urgent ? 9 : 7);
            if (!CanReachApproachable(actor, diggable)) return false;
            if (actor != null)
            {
                SetOverride(actor, diggable.chore);
                AssignSingleChore(actor, diggable.chore, true);
            }
            else if (!AssignColonyChore(diggable.chore)) return false;
            return false;
        }

        private static bool EnsureRouteLadder(ActiveDigPathPlan plan, MinionIdentity actor, int cell)
        {
            if (!Grid.IsValidCell(cell) || Grid.IsSolidCell(cell)) return false;
            BuildingDef def = global::Assets.GetBuildingDef(LadderConfig.ID);
            if (def == null) return false;
            GameObject existing = Grid.Objects[cell, (int)def.ObjectLayer];
            if (existing != null)
            {
                BuildingComplete complete = existing.GetComponent<BuildingComplete>();
                if (complete != null && complete.Def == def) return true;
                Constructable existingConstructable = existing.GetComponent<Constructable>();
                if (existingConstructable != null)
                {
                    SetPriority(existing, plan.Urgent ? 9 : 7);
                    if (actor != null) AssignBuildChores(actor, existingConstructable, true);
                    else AssignColonyBuild(existingConstructable);
                }
                return false;
            }

            string reason;
            if (!def.IsValidPlaceLocation(null, cell, Orientation.Neutral, false, out reason, false))
            {
                // A solid floor is already enough for a horizontal entrance;
                // only abort if this cell is genuinely needed for climbing.
                Debug.LogWarning("[DoubaoAI][Command] 梯子位置暂不可建：cell=" + cell + "，reason=" + ShortReason(reason));
                return false;
            }
            List<Tag> materials = actor == null ? ChooseColonyMaterials(cell, def) : ChooseMaterials(actor, def);
            if (materials.Count == 0) return false;
            GameObject order = def.TryPlace(null, Grid.CellToPosCBC(cell, def.SceneLayer),
                Orientation.Neutral, materials, null, false);
            Constructable constructable = order == null ? null : order.GetComponent<Constructable>();
            if (constructable == null) return false;
            SetPriority(order, plan.Urgent ? 9 : 7);
            if (actor != null) AssignBuildChores(actor, constructable, true);
            else AssignColonyBuild(constructable);
            Debug.Log("[DoubaoAI][Command] 分阶段挖路创建梯子：cell=" + cell);
            return false;
        }

        private static bool NeedsLadder(int previous, int current)
        {
            int px;
            int py;
            int cx;
            int cy;
            Grid.CellToXY(previous, out px, out py);
            Grid.CellToXY(current, out cx, out cy);
            if (py != cy) return true;
            int below = Grid.CellBelow(current);
            return !Grid.IsValidCell(below) || !Grid.IsSolidCell(below);
        }

        private static PlayerCommandExecutionResult DigPath(MinionIdentity actor, int targetCell, bool urgent)
        {
            if (!Grid.IsValidCell(targetCell)) return Fail("鼠标没有指在当前星球的有效格子上。");
            List<int> route;
            int startCell;
            if (!TryFindDigRoute(actor, targetCell, 32, out route, out startCell))
                return Fail("附近找不到能从当前殖民地接上的挖掘入口。先把鼠标放到更靠近基地的墙体上吧。");

            int sx;
            int sy;
            int tx;
            int ty;
            Grid.CellToXY(startCell, out sx, out sy);
            Grid.CellToXY(targetCell, out tx, out ty);
            if (Math.Abs(ty - sy) > 2)
                return Fail("目标和可达入口高度相差太大，光挖不能形成可走通道，需要先规划梯子。");

            var digCells = new List<int>();
            var seen = new HashSet<int>();
            for (int i = 0; i < route.Count; i++)
            {
                int cell = route[i];
                if (Grid.IsSolidCell(cell) && IsDiggableCell(cell) && seen.Add(cell)) digCells.Add(cell);
                if (i == 0) continue;
                int previousX;
                int previousY;
                int currentX;
                int currentY;
                Grid.CellToXY(route[i - 1], out previousX, out previousY);
                Grid.CellToXY(cell, out currentX, out currentY);
                if (previousY != currentY) continue;
                int head = Grid.CellAbove(cell);
                if (Grid.IsValidCell(head) && Grid.WorldIdx[head] == Grid.WorldIdx[targetCell] &&
                    Grid.IsSolidCell(head))
                {
                    if (!IsDiggableCell(head))
                        return Fail("通道上方有不能挖的方块，无法生成两格高的通路。");
                    if (seen.Add(head)) digCells.Add(head);
                }
            }
            if (digCells.Count == 0)
                return Fail("从基地到鼠标位置已经是通的，不需要再挖。");
            if (digCells.Count > 48)
                return Fail("这条通道超过 48 格，范围太大。请把目标分成两段下令。");

            int created = 0;
            Chore firstChore = null;
            foreach (int cell in digCells)
            {
                GameObject order = Grid.Objects[cell, (int)ObjectLayer.DigPlacer];
                if (order == null)
                {
                    order = CreateDigOrder(cell);
                    if (order == null) continue;
                    created++;
                }
                SetPriority(order, urgent ? 9 : 7);
                Diggable diggable = order.GetComponent<Diggable>();
                if (diggable == null || diggable.chore == null) continue;
                if (firstChore == null) firstChore = diggable.chore;
                if (actor != null) SetOverride(actor, diggable.chore);
            }
            if (created == 0 && firstChore == null)
                return Fail("连续挖掘任务没有创建成功。");
            if (actor != null && firstChore != null && urgent)
                AssignSingleChore(actor, firstChore, true);

            string who = actor == null ? "殖民地" : SafeName(actor);
            return Ok("已经从可达入口开始，为" + who + "连续标记了" + digCells.Count +
                      "格挖掘；入口挖开后，后面的任务会依次变得可达。");
        }

        private static PlayerCommandExecutionResult BuildColony(int cell, string action, bool urgent)
        {
            string buildingName = GetBuildingName(action);
            BuildingDef def = ResolveBuildingDef(action);
            if (def == null) return Fail("没有找到对应的建筑定义。");
            string reason;
            if (!def.IsValidPlaceLocation(null, cell, Orientation.Neutral, false, out reason, false))
                return Fail("这里不能建" + buildingName + "。" + ShortReason(reason));
            List<Tag> materials = ChooseColonyMaterials(cell, def);
            if (materials.Count == 0) return Fail("殖民地没有足够的可用建造材料。");
            GameObject order = def.TryPlace(null, Grid.CellToPosCBC(cell, def.SceneLayer),
                Orientation.Neutral, materials, null, false);
            if (order == null) return Fail("公共施工任务没有创建成功。");
            SetPriority(order, urgent ? 9 : 7);
            Constructable constructable = order.GetComponent<Constructable>();
            if (constructable != null) AssignColonyBuild(constructable);
            return Ok("已经在这里创建公共" + buildingName +
                      "施工任务了，合适的人会来完成。");
        }

        private static PlayerCommandExecutionResult Move(MinionIdentity actor, int cell)
        {
            if (Grid.IsSolidCell(cell)) return Fail("那里是实心格，" + SafeName(actor) + "走不过去。");
            Navigator navigator = actor.GetComponent<Navigator>();
            if (navigator == null || navigator.GetNavigationCost(cell) < 0)
                return Fail(SafeName(actor) + "现在到不了那里，先把路线打通吧。");
            MoveToLocationMonitor.Instance monitor = actor.GetSMI<MoveToLocationMonitor.Instance>();
            if (monitor == null) return Fail("没能取得" + SafeName(actor) + "的移动控制器。");
            monitor.MoveToLocation(cell);
            return Ok("好，已经让" + SafeName(actor) + "移动到鼠标位置了。");
        }

        private static PlayerCommandExecutionResult Dig(MinionIdentity actor, int cell, bool urgent)
        {
            if (!Grid.IsSolidCell(cell)) return Fail("鼠标这格不是可挖的实体。");
            if (Grid.Foundation[cell] || !Diggable.IsDiggable(cell) || Diggable.Undiggable(Grid.Element[cell]))
                return Fail("鼠标这格不能挖。");

            GameObject order = Grid.Objects[cell, (int)ObjectLayer.DigPlacer];
            bool created = false;
            if (order == null)
            {
                order = Util.KInstantiate(global::Assets.GetPrefab(new Tag("DigPlacer")));
                Diggable createdDiggable = order == null ? null : order.GetComponent<Diggable>();
                if (createdDiggable == null)
                {
                    if (order != null) Util.KDestroyGameObject(order);
                    return Fail("创建挖掘差事失败了。");
                }
                createdDiggable.digTypeFlags = (int)Diggable.DiggableType.Tile;
                order.SetActive(true);
                Grid.Objects[cell, (int)ObjectLayer.DigPlacer] = order;
                order.transform.SetPosition(Grid.CellToPosCBC(cell, Grid.SceneLayer.Move));
                created = true;
            }

            Diggable diggable = order.GetComponent<Diggable>();
            if (diggable == null || diggable.chore == null ||
                !AssignSingleChore(actor, diggable.chore, urgent))
            {
                if (created) order.Trigger((int)GameHashes.Cancel);
                return Fail(SafeName(actor) + "现在无法领取这项挖掘，可能是路线或技能不满足。");
            }
            SetPriority(order, urgent ? 9 : 7);
            return Ok("已经把这格挖掘只交给" + SafeName(actor) + "了。" +
                      (urgent ? "我让他立刻处理。" : "他完成当前要紧的事后会去。"));
        }

        private static PlayerCommandExecutionResult Build(
            MinionIdentity actor,
            int cell,
            string action,
            bool urgent)
        {
            string buildingName = GetBuildingName(action);
            BuildingDef def = ResolveBuildingDef(action);
            if (def == null) return Fail("没有找到对应的建筑定义。");
            string reason;
            if (!def.IsValidPlaceLocation(null, cell, Orientation.Neutral, false, out reason, false))
                return Fail("这里不能建" + buildingName + "。" + ShortReason(reason));

            List<Tag> materials = ChooseMaterials(actor, def);
            if (materials.Count == 0)
                return Fail("没有找到" + SafeName(actor) + "能够取得的建造材料。");
            Vector3 position = Grid.CellToPosCBC(cell, def.SceneLayer);
            GameObject order = def.TryPlace(null, position, Orientation.Neutral, materials, null, false);
            if (order == null) return Fail("施工任务没有创建成功。");

            Navigator navigator = actor.GetComponent<Navigator>();
            Constructable constructable = order.GetComponent<Constructable>();
            if (navigator == null || constructable == null || !navigator.CanReach(constructable))
            {
                order.Trigger((int)GameHashes.Cancel);
                return Fail(SafeName(actor) + "无法到达这个施工位置。");
            }
            if (!AssignBuildChores(actor, constructable, urgent))
            {
                order.Trigger((int)GameHashes.Cancel);
                return Fail(SafeName(actor) + "目前无法领取这项施工。");
            }
            SetPriority(order, urgent ? 9 : 7);
            return Ok("已经让" + SafeName(actor) + "在这里建" + buildingName + "了。");
        }

        private static bool AssignSingleChore(MinionIdentity actor, Chore chore, bool urgent)
        {
            if (actor == null || chore == null) return false;
            ChoreConsumer consumer = actor.GetComponent<ChoreConsumer>();
            ChoreDriver driver = actor.GetComponent<ChoreDriver>();
            StandardChoreBase standard = chore as StandardChoreBase;
            if (consumer == null || driver == null || standard == null) return false;
            standard.SetOverrideTarget(consumer);
            consumer.consumerState.Refresh();
            var context = new Chore.Precondition.Context(chore, consumer.consumerState, true);
            context.RunPreconditions();
            context.FinishPreconditions();
            if (!context.IsSuccess()) return false;
            if (urgent && driver.GetCurrentChore() != chore) driver.SetChore(context);
            return true;
        }

        private static bool AssignBuildChores(MinionIdentity actor, Constructable constructable, bool urgent)
        {
            var chores = new List<Chore>();
            if (ConstructableFetchList != null)
            {
                FetchList2 fetchList = ConstructableFetchList.GetValue(constructable) as FetchList2;
                if (fetchList != null)
                    foreach (FetchOrder2 fetchOrder in fetchList.FetchOrders)
                        foreach (FetchChore fetchChore in fetchOrder.Chores)
                            if (fetchChore != null) chores.Add(fetchChore);
            }
            if (ConstructableBuildChore != null)
            {
                Chore build = ConstructableBuildChore.GetValue(constructable) as Chore;
                if (build != null) chores.Add(build);
            }
            bool assigned = false;
            foreach (Chore chore in chores)
            {
                if (!AssignSingleChore(actor, chore, urgent && !assigned)) continue;
                assigned = true;
            }
            return assigned;
        }

        private static bool AssignColonyChore(Chore chore)
        {
            if (chore == null) return false;
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                if (AssignSingleChore(minion, chore, true)) return true;
            }
            return false;
        }

        private static bool AssignColonyBuild(Constructable constructable)
        {
            if (constructable == null) return false;
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                Navigator navigator = minion.GetComponent<Navigator>();
                if (navigator == null || !navigator.CanReach(constructable)) continue;
                if (AssignBuildChores(minion, constructable, true)) return true;
            }
            return false;
        }

        private static List<Tag> ChooseMaterials(MinionIdentity actor, BuildingDef def)
        {
            var selected = new List<Tag>();
            WorldContainer world = actor == null ? null : actor.gameObject.GetMyWorld();
            Navigator navigator = actor == null ? null : actor.GetComponent<Navigator>();
            if (def == null || world == null || navigator == null || def.MaterialCategory == null) return selected;
            for (int i = 0; i < def.MaterialCategory.Length; i++)
            {
                Tag best = Tag.Invalid;
                float bestAmount = 0f;
                float required = def.Mass != null && i < def.Mass.Length ? def.Mass[i] : 0f;
                foreach (Tag option in MaterialSelector.GetValidMaterials(def.MaterialCategory[i]))
                {
                    ICollection<Pickupable> pickupables = world.worldInventory.GetPickupables(option, false);
                    float reachable = 0f;
                    if (pickupables != null)
                        foreach (Pickupable pickupable in pickupables)
                            if (pickupable != null && navigator.CanReach(pickupable)) reachable += pickupable.TotalAmount;
                    if (reachable >= required && reachable > bestAmount)
                    {
                        best = option;
                        bestAmount = reachable;
                    }
                }
                if (!best.IsValid) return new List<Tag>();
                selected.Add(best);
            }
            return selected;
        }

        private static List<Tag> ChooseColonyMaterials(int cell, BuildingDef def)
        {
            var selected = new List<Tag>();
            if (def == null || def.MaterialCategory == null || ClusterManager.Instance == null ||
                !Grid.IsValidCell(cell)) return selected;
            WorldContainer world = ClusterManager.Instance.GetWorld(Grid.WorldIdx[cell]);
            if (world == null) return selected;
            for (int i = 0; i < def.MaterialCategory.Length; i++)
            {
                Tag best = Tag.Invalid;
                float bestAmount = 0f;
                float required = def.Mass != null && i < def.Mass.Length ? def.Mass[i] : 0f;
                foreach (Tag option in MaterialSelector.GetValidMaterials(def.MaterialCategory[i]))
                {
                    float amount = 0f;
                    ICollection<Pickupable> pickupables = world.worldInventory.GetPickupables(option, true);
                    if (pickupables != null)
                    {
                        foreach (Pickupable pickupable in pickupables)
                            if (pickupable != null) amount += pickupable.TotalAmount;
                    }
                    Debug.Log("[DoubaoAI][Command] 公共建造材料：building=" + def.PrefabID +
                              "，category=" + def.MaterialCategory[i] + "，option=" + option +
                              "，available=" + amount + "，required=" + required);
                    if (amount >= required && amount > bestAmount)
                    {
                        best = option;
                        bestAmount = amount;
                    }
                }
                if (!best.IsValid)
                {
                    Debug.LogWarning("[DoubaoAI][Command] 公共建造材料不足：building=" + def.PrefabID +
                                     "，category=" + def.MaterialCategory[i] + "，required=" + required);
                    return new List<Tag>();
                }
                selected.Add(best);
            }
            return selected;
        }

        private static bool TryFindDigRoute(
            MinionIdentity actor,
            int targetCell,
            int maximumRadius,
            out List<int> route,
            out int startCell)
        {
            route = new List<int>();
            startCell = Grid.InvalidCell;
            if (!Grid.IsValidCell(targetCell)) return false;
            byte world = Grid.WorldIdx[targetCell];
            var pending = new Queue<int>();
            var previous = new Dictionary<int, int>();
            var distance = new Dictionary<int, int>();
            pending.Enqueue(targetCell);
            previous[targetCell] = Grid.InvalidCell;
            distance[targetCell] = 0;
            int targetX;
            int targetY;
            Grid.CellToXY(targetCell, out targetX, out targetY);
            int bestScore = int.MaxValue;

            while (pending.Count > 0 && previous.Count <= 3500)
            {
                int cell = pending.Dequeue();
                int depth = distance[cell];
                int x;
                int y;
                Grid.CellToXY(cell, out x, out y);
                if (!Grid.IsSolidCell(cell) && CanReachOpenCell(actor, cell))
                {
                    int score = depth + Math.Abs(y - targetY) * 7;
                    if (score < bestScore)
                    {
                        bestScore = score;
                        startCell = cell;
                    }
                }
                if (depth >= maximumRadius) continue;
                int[] neighbours =
                {
                    Grid.CellLeft(cell), Grid.CellRight(cell),
                    Grid.CellAbove(cell), Grid.CellBelow(cell)
                };
                foreach (int next in neighbours)
                {
                    if (!Grid.IsValidCell(next) || Grid.WorldIdx[next] != world || previous.ContainsKey(next)) continue;
                    int nx;
                    int ny;
                    Grid.CellToXY(next, out nx, out ny);
                    if (Math.Abs(nx - targetX) + Math.Abs(ny - targetY) > maximumRadius) continue;
                    if (Grid.IsSolidCell(next) && !IsDiggableCell(next)) continue;
                    previous[next] = cell;
                    distance[next] = depth + 1;
                    pending.Enqueue(next);
                }
            }
            if (!Grid.IsValidCell(startCell)) return false;
            int cursor = startCell;
            route.Add(cursor);
            while (cursor != targetCell)
            {
                int next;
                if (!previous.TryGetValue(cursor, out next) || !Grid.IsValidCell(next)) return false;
                cursor = next;
                route.Add(cursor);
                if (route.Count > maximumRadius + 1) return false;
            }
            return true;
        }

        private static bool CanReachDigCell(MinionIdentity actor, int cell)
        {
            if (!IsDiggableCell(cell)) return false;
            int[] workCells =
            {
                Grid.CellLeft(cell), Grid.CellRight(cell),
                Grid.CellAbove(cell), Grid.CellBelow(cell)
            };
            foreach (int workCell in workCells)
                if (CanReachOpenCell(actor, workCell)) return true;
            return false;
        }

        private static bool CanReachApproachable(MinionIdentity actor, IApproachable target)
        {
            if (target == null) return false;
            if (actor != null)
            {
                Navigator navigator = actor.GetComponent<Navigator>();
                return navigator != null && navigator.CanReach(target);
            }
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                Navigator navigator = minion.GetComponent<Navigator>();
                if (navigator != null && navigator.CanReach(target)) return true;
            }
            return false;
        }

        private static bool CanReachOpenCell(MinionIdentity actor, int cell)
        {
            if (!Grid.IsValidCell(cell) || Grid.IsSolidCell(cell)) return false;
            if (actor != null)
            {
                Navigator navigator = actor.GetComponent<Navigator>();
                return navigator != null && navigator.GetNavigationCost(cell) >= 0;
            }
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                Navigator navigator = minion.GetComponent<Navigator>();
                if (navigator != null && navigator.GetNavigationCost(cell) >= 0) return true;
            }
            return false;
        }

        private static bool IsDiggableCell(int cell)
        {
            return Grid.IsValidCell(cell) && Grid.IsSolidCell(cell) && !Grid.Foundation[cell] &&
                   Diggable.IsDiggable(cell) && !Diggable.Undiggable(Grid.Element[cell]);
        }

        private static GameObject CreateDigOrder(int cell)
        {
            if (!IsDiggableCell(cell)) return null;
            GameObject existing = Grid.Objects[cell, (int)ObjectLayer.DigPlacer];
            if (existing != null) return existing;
            GameObject order = Util.KInstantiate(global::Assets.GetPrefab(new Tag("DigPlacer")));
            Diggable diggable = order == null ? null : order.GetComponent<Diggable>();
            if (diggable == null)
            {
                if (order != null) Util.KDestroyGameObject(order);
                return null;
            }
            diggable.digTypeFlags = (int)Diggable.DiggableType.Tile;
            order.SetActive(true);
            Grid.Objects[cell, (int)ObjectLayer.DigPlacer] = order;
            order.transform.SetPosition(Grid.CellToPosCBC(cell, Grid.SceneLayer.Move));
            return order;
        }

        private static void SetOverride(MinionIdentity actor, Chore chore)
        {
            if (actor == null || chore == null) return;
            ChoreConsumer consumer = actor.GetComponent<ChoreConsumer>();
            StandardChoreBase standard = chore as StandardChoreBase;
            if (consumer != null && standard != null) standard.SetOverrideTarget(consumer);
        }

        private static MinionIdentity FindActor(int id, string name)
        {
            MinionIdentity nameMatch = null;
            foreach (MinionIdentity minion in Components.LiveMinionIdentities.Items)
            {
                if (minion == null) continue;
                if (PlayerCommandContextCollector.GetId(minion) == id) return minion;
                if (!string.IsNullOrWhiteSpace(name) &&
                    string.Equals(SafeName(minion), name.Trim(), StringComparison.OrdinalIgnoreCase))
                    nameMatch = minion;
            }
            return nameMatch;
        }

        private static void SetPriority(GameObject order, int value)
        {
            Prioritizable priority = order == null ? null : order.GetComponent<Prioritizable>();
            if (priority != null)
                priority.SetMasterPriority(new PrioritySetting(PriorityScreen.PriorityClass.basic, value));
        }

        private static BuildingDef ResolveBuildingDef(string buildingKey)
        {
            PlayerBuildDefinition definition;
            return PlayerBuildCatalog.TryGet(buildingKey, out definition)
                ? global::Assets.GetBuildingDef(definition.PrefabId)
                : null;
        }

        private static string GetBuildingName(string buildingKey)
        {
            PlayerBuildDefinition definition;
            return PlayerBuildCatalog.TryGet(buildingKey, out definition)
                ? definition.DisplayName
                : "建筑";
        }

        private static string SafeName(MinionIdentity actor)
        {
            try { return actor.GetProperName(); }
            catch { return actor == null ? "复制人" : actor.name; }
        }

        private static string ShortReason(string reason)
        {
            if (string.IsNullOrWhiteSpace(reason)) return string.Empty;
            reason = reason.Replace("\r", " ").Replace("\n", " ").Trim();
            return "（" + (reason.Length > 60 ? reason.Substring(0, 60) : reason) + "）";
        }

        private static PlayerCommandExecutionResult Ok(string reply)
        {
            return new PlayerCommandExecutionResult { Success = true, Reply = reply };
        }

        private static PlayerCommandExecutionResult Fail(string reply)
        {
            return new PlayerCommandExecutionResult { Success = false, Reply = reply };
        }
    }
}

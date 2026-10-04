import { blocks, containers, equipment, recordAudit, tasks, voyages } from './domain.js';
import type { YardTask } from './domain.js';

/**
 * 场桥作业波次（job wave）批处理与路线校验
 *
 * 波次把可关联的 rehandle / deliver / load 任务绑定到同一台场桥上，按
 *   1. 堆位层级（同排高层箱必须先翻走，才能取低层箱）
 *   2. 堆位占用（同槽先取后放、目标槽空闲、目标层高、冷藏/危险品资质）
 *   3. 箱子当前状态（海关、箱态、航次）与任务前置关系（同箱链）
 * 推导 DAG 并做带模拟的拓扑排序，输出可执行顺序、逐点阻塞点与包含跨区移机的预计耗时。
 *
 * 执行阶段采用单调状态机：pending -> running -> done | failed | skipped，
 * 任一任务失败立即冻结全部后续任务，不允许误放行；恢复时按现场实况重算剩余路线。
 */

export type WaveStatus = 'validated' | 'running' | 'paused' | 'completed' | 'failed';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type WaveKind = 'rehandle' | 'deliver' | 'load';
export type BlockingSeverity = 'error' | 'warning' | 'info';
export type BlockingCode =
  | 'tier-order' | 'slot-occupied' | 'tier-limit' | 'unsupported-slot' | 'block-full'
  | 'reefer-plug' | 'hazmat-block' | 'crane-unreachable' | 'container-state'
  | 'customs-hold' | 'voyage-not-ready' | 'cycle-detected' | 'cross-zone-travel'
  | 'failed-predecessor' | 'duplicate-container' | 'task-state' | 'equipment-state';

export interface BlockingPoint {
  code: BlockingCode;
  severity: BlockingSeverity;
  at: 'header' | 'task';
  taskId?: string;
  blockerTaskId?: string;
  message: string;
  resolution: string;
}

export interface WaveStep {
  sequence: number;
  taskId: string;
  containerId: string;
  kind: WaveKind;
  from: string;
  to: string;
  estimatedMinutes: number;
  travelMinutes: number;
  travelLabel: string;
  prerequisites: string[];
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
  blockingPoints: BlockingPoint[];
}

export interface JobWave {
  id: string;
  name: string;
  equipmentId: string;
  status: WaveStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  taskIds: string[];
  steps: WaveStep[];
  blockingPoints: BlockingPoint[];
  estimatedMinutes: number;
  remainingMinutes: number;
  elapsedMinutes: number;
  failedAt?: string;
  failureReason?: string;
  interruptedAtSequence?: number;
}

export interface PlanInput { equipmentId: string; taskIds: string[]; }
interface PlanContext {
  tasks: YardTask[];
  byId: Map<string, YardTask>;
  containerOf: Map<string, string>;
  edges: Map<string, Set<string>>;
  edgeReasons: Map<string, BlockingPoint[]>;
  hardErrors: BlockingPoint[];
}

export const WAVE_KINDS: WaveKind[] = ['rehandle', 'deliver', 'load'];

const SLOT_RE = /^([A-Z]\d{2})-R(\d{2})-T(\d)$/;
const GATES = ['南闸口', '北闸口', '闸口'];

interface SlotRef { blockId: string; row: number; tier: number; key: string; }
const parseSlot = (value: string): SlotRef | undefined => {
  const match = value.match(SLOT_RE);
  if (!match) return undefined;
  return { blockId: match[1], row: Number(match[2]), tier: Number(match[3]), key: `${match[1]}-R${match[2]}` };
};
const blockOf = (anchor: string) => anchor.match(/^([A-Z]\d{2})(?:-R\d{2})?(?:-T\d)?$/)?.[1];
const isGate = (anchor: string) => GATES.includes(anchor);
const isBerth = (anchor: string) => /^B\d{2}\b/.test(anchor) && !blockOf(anchor);

/** 跨区/移机耗时：设备从一个锚点移动到下一作业锚点的时间（分钟）。 */
export function travelMinutes(fromAnchor: string, toAnchor: string): { minutes: number; label: string; crossZone: boolean } {
  if (!fromAnchor || fromAnchor === toAnchor) return { minutes: 0, label: '设备已就位', crossZone: false };
  const fb = blockOf(fromAnchor); const tb = blockOf(toAnchor);
  const sameBlock = fb && fb === tb;
  if (sameBlock) {
    const fs = parseSlot(fromAnchor); const ts = parseSlot(toAnchor);
    if (fs && ts && fs.row === ts.row) return { minutes: 2, label: `同排移机 ${fb} ${fs.row} 排`, crossZone: false };
    return { minutes: 4, label: `同区跨排移机 ${fb}`, crossZone: false };
  }
  if (isGate(toAnchor) || isGate(fromAnchor)) return { minutes: 6, label: `${fromAnchor} → ${toAnchor}（往返闸口）`, crossZone: true };
  if (isBerth(toAnchor) || isBerth(fromAnchor)) return { minutes: 9, label: `${fromAnchor} → ${toAnchor}（岸桥交接位）`, crossZone: true };
  const fZone = blocks.find(b => b.id === fb)?.zone ?? fromAnchor;
  const tZone = blocks.find(b => b.id === tb)?.zone ?? toAnchor;
  return { minutes: 8, label: `${fromAnchor} → ${toAnchor}（跨区移机 ${fZone} → ${tZone}）`, crossZone: true };
}

function bp(code: BlockingCode, severity: BlockingSeverity, message: string, resolution: string, at: 'header' | 'task' = 'task', taskId?: string, blockerTaskId?: string): BlockingPoint {
  return { code, severity, at, taskId, blockerTaskId, message, resolution };
}
const addEdge = (ctx: PlanContext, before: string, after: string, point: BlockingPoint) => {
  if (before === after) return;
  if (!ctx.edges.has(after)) ctx.edges.set(after, new Set());
  ctx.edges.get(after)!.add(before);
  const key = `${before}->${after}`;
  const list = ctx.edgeReasons.get(key);
  if (list) list.push(point); else ctx.edgeReasons.set(key, [point]);
};

// ---------- 计划阶段：前置关系 DAG ----------

function buildContext(taskIds: string[]): PlanContext | { headerErrors: BlockingPoint[] } {
  const headerErrors: BlockingPoint[] = [];
  const unique = [...new Set(taskIds)];
  if (!unique.length) headerErrors.push(bp('task-state', 'error', '波次至少包含一个任务', '请选择 rehandle / deliver / load 任务', 'header'));
  const picked = unique.map(id => tasks.find(t => t.id === id)).filter((t): t is YardTask => Boolean(t));
  if (picked.length < unique.length) headerErrors.push(bp('task-state', 'error', '存在已被删除的任务，无法组波', '刷新任务列表后重新选择', 'header'));
  const ctx: PlanContext = {
    tasks: picked, byId: new Map(picked.map(t => [t.id, t])), containerOf: new Map(picked.map(t => [t.id, t.containerId])),
    edges: new Map(), edgeReasons: new Map(), hardErrors: [],
  };
  const seenContainer = new Map<string, string>();
  for (const task of picked) {
    if (!WAVE_KINDS.includes(task.kind as WaveKind)) {
      ctx.hardErrors.push(bp('task-state', 'error', `${task.id}（${task.kind}）不属于 rehandle/deliver/load，不能进入场桥波次`, '将该任务从波次中移除，走专用作业通道', 'task', task.id));
    }
    if (['done'].includes(task.status)) {
      ctx.hardErrors.push(bp('task-state', 'error', `${task.id} 已完成，不能重复纳入波次`, '选择未完成的同类任务', 'task', task.id));
    }
    const prev = seenContainer.get(task.containerId);
    if (prev) {
      ctx.hardErrors.push(bp('duplicate-container', 'error', `箱 ${task.containerId} 被 ${prev} 与 ${task.id} 重复包含`, '同一波次中每个箱只能出现一次，请拆分为两个波次', 'task', task.id, prev));
    } else seenContainer.set(task.containerId, task.id);
  }
  // 前置关系推导
  for (const task of picked) {
    const from = parseSlot(task.from);
    // 1) 同排压箱：起点槽上方任一层属于波次内任务的箱，必须先作业
    if (from) {
      for (const other of picked) {
        if (other.id === task.id || other.containerId === task.containerId) continue;
        const otherFrom = parseSlot(other.from);
        if (otherFrom && otherFrom.key === from.key && otherFrom.tier > from.tier) {
          // DAG 边本身由拓扑排序保证执行顺序，属于已被计划消解的约束，用 info；模拟时若仍压箱会再报 error
          addEdge(ctx, other.id, task.id, bp('tier-order', 'info', `${other.containerId} 压在 ${task.containerId} 上方（${other.from} > ${task.from}），必须先翻箱`, `先执行 ${other.id} 清出上方压箱`, 'task', task.id, other.id));
        }
      }
    }
    for (const other of picked) {
      if (other.id === task.id) continue;
      // 2) 同槽先取后放：他箱要放到我的起点槽，我必须先取走
      const otherTo = parseSlot(other.to);
      if (from && otherTo && otherTo.key === from.key && otherTo.tier === from.tier && other.containerId !== task.containerId) {
        addEdge(ctx, task.id, other.id, bp('slot-occupied', 'info', `${other.id} 的目标槽 ${other.to} 被 ${task.containerId} 占用`, `先执行 ${task.id} 移出该槽`, 'task', other.id, task.id));
      }
      // 3) 同箱链：同箱多任务按计划时间排序，前序未完成后续不能执行
      if (other.containerId === task.containerId && new Date(other.scheduledAt).getTime() < new Date(task.scheduledAt).getTime()) {
        addEdge(ctx, other.id, task.id, bp('tier-order', 'info', `同箱 ${task.containerId} 的前序任务 ${other.id} 必须先完成`, `保持 ${other.id} → ${task.id} 顺序`, 'task', task.id, other.id));
      }
    }
  }
  if (headerErrors.length) return { headerErrors };
  return ctx;
}

function topoSort(ctx: PlanContext): YardTask[] | BlockingPoint {
  // 注意：使用 DAG 的副本做入度演算，不能修改 ctx.edges，后续步骤展示还要读取前置关系
  const indegree = new Map<string, number>(ctx.tasks.map(t => [t.id, 0]));
  const remaining = new Map<string, Set<string>>();
  for (const [after, befores] of ctx.edges) {
    const valid = new Set([...befores].filter(b => ctx.byId.has(b)));
    remaining.set(after, valid);
    indegree.set(after, valid.size);
  }
  const priorityOf = (id: string) => {
    const list = [...ctx.tasks];
    return list.findIndex(t => t.id === id);
  };
  const ready = ctx.tasks.filter(t => (indegree.get(t.id) ?? 0) === 0)
    .sort((a, b) => b.priority - a.priority || priorityOf(a.id) - priorityOf(b.id));
  const order: YardTask[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    order.push(next);
    for (const [after, befores] of remaining) {
      if (!befores.has(next.id)) continue;
      befores.delete(next.id);
      const deg = (indegree.get(after) ?? 1) - 1;
      indegree.set(after, deg);
      if (deg === 0) {
        const t = ctx.byId.get(after)!;
        ready.push(t);
        ready.sort((a, b) => b.priority - a.priority || priorityOf(a.id) - priorityOf(b.id));
      }
    }
  }
  if (order.length < ctx.tasks.length) {
    const cyclic = ctx.tasks.filter(t => !order.some(o => o.id === t.id)).map(t => t.id).join('、');
    return bp('cycle-detected', 'error', `前置关系存在循环依赖：${cyclic}`, '解除互锁（增加临时落位或拆分波次）后重新提交', 'header');
  }
  return order;
}

// ---------- 模拟阶段：堆位层级、占用、箱态 ----------

interface SimState {
  occupancy: Map<string, string[]>; // block-row -> 各层 containerId（稀疏）
  location: Map<string, string>;    // containerId -> 当前槽
  usedPlugs: Map<string, number>;
  occupied: Map<string, number>;
}

function initialState(ctx: PlanContext): SimState {
  const state: SimState = { occupancy: new Map(), location: new Map(), usedPlugs: new Map(), occupied: new Map() };
  for (const block of blocks) { state.usedPlugs.set(block.id, block.usedPlugs); state.occupied.set(block.id, block.occupied); }
  // 以箱务台账现状作为初始堆存（波次内任务声明的 from 会覆盖对应箱位置，兼容任务创建后的最新移动）
  for (const container of containers) {
    const slot = parseSlot(container.yardSlot);
    if (!slot) continue;
    placeAt(state, slot, container.id);
    state.location.set(container.id, container.yardSlot);
  }
  for (const task of ctx.tasks) {
    // 同一箱在波次内可能形成链（翻箱→提箱），只承认链中第一个任务的起点，后续起点靠 DAG 顺序推进
    const earlierSameContainer = ctx.tasks.some(other => other.containerId === task.containerId && new Date(other.scheduledAt).getTime() < new Date(task.scheduledAt).getTime());
    if (earlierSameContainer) continue;
    const slot = parseSlot(task.from);
    if (slot) {
      const container = containers.find(c => c.id === task.containerId);
      const declared = container ? parseSlot(container.yardSlot) : undefined;
      if (declared && (declared.key !== slot.key || declared.tier !== slot.tier)) removeAt(state, declared);
      state.location.set(task.containerId, task.from);
      placeAt(state, slot, task.containerId);
    }
  }
  return state;
}
function placeAt(state: SimState, slot: SlotRef, containerId: string) {
  const list = state.occupancy.get(slot.key) ?? [];
  list[slot.tier] = containerId;
  state.occupancy.set(slot.key, list);
}
function removeAt(state: SimState, slot: SlotRef) {
  const list = state.occupancy.get(slot.key);
  if (list) delete list[slot.tier];
}

/** 按给定顺序逐步模拟；返回每一步的阻塞点、移机信息，并在硬冲突时中断。 */
function simulate(order: YardTask[], ctx: PlanContext, equipmentId: string, state: SimState, opts: { startAnchor?: string } = {}) {
  const steps: WaveStep[] = [];
  const hardErrors: BlockingPoint[] = [];
  const warningPoints: BlockingPoint[] = [];
  let anchor = opts.startAnchor ?? equipment.find(e => e.id === equipmentId)?.location ?? '';
  let aborted = false;

  order.forEach((task, index) => {
    const points: BlockingPoint[] = [];
    const container = containers.find(c => c.id === task.containerId);
    const from = parseSlot(task.from);
    const to = parseSlot(task.to);
    const reasons = ctx.edgeReasons;
    const prereqs = [...(ctx.edges.get(task.id) ?? [])].filter(id => ctx.byId.has(id));
    for (const pre of prereqs) {
      const rs = reasons.get(`${pre}->${task.id}`);
      if (rs) points.push(...rs);
    }

    if (!aborted) {
      // —— 取箱校验：必须与箱当前实际位置、层级一致 ——
      if (from) {
        const stack = state.occupancy.get(from.key) ?? [];
        const occupant = stack[from.tier];
        if (occupant && occupant !== task.containerId) {
          points.push(bp('slot-occupied', 'error', `${task.from} 当前是箱 ${occupant}，与任务声明的 ${task.containerId} 不符`, '现场核对箱位并修正任务起点', 'task', task.id));
        } else if (!occupant) {
          points.push(bp('tier-order', 'error', `${task.from} 已无箱，${task.containerId} 可能已被移走`, '从断点恢复时重新校验箱位', 'task', task.id));
        } else {
          const above = stack.slice(from.tier + 1).filter((id): id is string => Boolean(id));
          if (above.length) points.push(bp('tier-order', 'error', `${task.from} 上方仍有 ${above.length} 层压箱（${above.join('、')}），需先安排翻箱`, '把上层箱的翻箱任务加入本波次或更早波次', 'task', task.id));
        }
      }
      // —— 放箱校验 ——
      if (to) {
        const block = blocks.find(b => b.id === to.blockId);
        if (!block) {
          points.push(bp('unsupported-slot', 'error', `目标区块 ${to.blockId} 不存在`, '修正目标堆位', 'task', task.id));
        } else {
          if (to.tier > block.tiers) points.push(bp('tier-limit', 'error', `目标 ${task.to} 超过 ${block.id} 限高 ${block.tiers} 层`, '降低目标层高或更换区块', 'task', task.id));
          if (to.tier > 1) {
            const below = (state.occupancy.get(to.key) ?? [])[to.tier - 1];
            if (!below) points.push(bp('tier-order', 'error', `目标 ${task.to} 的下层 T${to.tier - 1} 悬空，不能起堆`, '改为从 T1 起堆或更换堆位', 'task', task.id));
          }
          const occupant = (state.occupancy.get(to.key) ?? [])[to.tier];
          if (occupant && occupant !== task.containerId) points.push(bp('slot-occupied', 'error', `目标槽 ${task.to} 已被 ${occupant} 占用`, '更换目标槽，或先执行占用箱的移出任务', 'task', task.id));
          if ((state.occupied.get(block.id) ?? 0) >= block.capacity) points.push(bp('block-full', 'error', `${block.id} 已满，无法接收翻箱`, '先疏港或改投其他区块', 'task', task.id));
          if (container?.reefer) {
            const used = state.usedPlugs.get(block.id) ?? 0;
            if (used >= block.reeferPlugs) points.push(bp('reefer-plug', 'error', `${block.id} 冷藏插座已满（${used}/${block.reeferPlugs}）`, '等待插座释放或改投有冷插的区块', 'task', task.id));
          }
          if (container?.hazmatClass && !block.hazmatAllowed) points.push(bp('hazmat-block', 'error', `${block.id} 无危险品隔离资质，${container.hazmatClass} 类箱不能落位`, '改投允许危险品的区块', 'task', task.id));
          if (!block.equipment.includes('yard-crane')) points.push(bp('crane-unreachable', 'warning', `${block.id} 不支持场桥轨道作业，可能需要正面吊配合`, '确认设备可达性或改用正面吊', 'task', task.id));
        }
      }
      // —— 箱子当前状态 / 任务前置业务校验 ——
      if (container) {
        if (task.kind === 'deliver' && container.customs !== 'released') points.push(bp('customs-hold', 'error', `箱 ${container.id} 海关状态为 ${container.customs}，提箱出场无法放行`, '等待海关放行后再恢复波次', 'task', task.id));
        if (task.kind === 'deliver' && !['in-yard', 'on-quay'].includes(container.status)) points.push(bp('container-state', 'error', `箱 ${container.id} 当前状态 ${container.status}，不在可提箱状态`, '核对箱态流转后再执行', 'task', task.id));
        if (task.kind === 'load') {
          if (container.customs !== 'released') points.push(bp('customs-hold', 'error', `箱 ${container.id} 海关未放行，不能装船`, '完成放行手续', 'task', task.id));
          if (!['in-yard', 'on-quay'].includes(container.status)) points.push(bp('container-state', 'error', `箱 ${container.id} 当前状态 ${container.status}，不具备装船条件`, '先完成进场/归位', 'task', task.id));
          const berthId = task.to.match(/^([A-Z]\d{2})/)?.[1];
          const voyage = voyages.find(v => v.berth === berthId);
          if (voyage && !['berthed', 'loading'].includes(voyage.status)) points.push(bp('voyage-not-ready', 'warning', `${voyage.vessel} 当前 ${voyage.status}，装船接口可能未就绪`, '关注靠泊进度，波次可先执行但装船点会等待', 'task', task.id));
        }
        if (task.kind === 'rehandle' && container.status === 'released' && !parseSlot(task.to)) points.push(bp('container-state', 'warning', `箱 ${container.id} 已放行，翻箱目标 ${task.to} 不是堆场槽位`, '确认是否应直接走提箱流程', 'task', task.id));
      } else {
        points.push(bp('container-state', 'error', `任务 ${task.id} 关联箱 ${task.containerId} 不存在`, '修正关联箱号', 'task', task.id));
      }
      const stepHard = points.some(p => p.severity === 'error');
      // —— 移机耗时：设备先移到起点取箱，再带箱移动到终点落位，两段都计入 ——
      const leg1 = travelMinutes(anchor, task.from);
      const leg2 = parseSlot(task.from) || isGate(task.from) || isBerth(task.from) ? travelMinutes(task.from, task.to) : { minutes: 0, label: '终点即起点', crossZone: false };
      const travelTotal = leg1.minutes + leg2.minutes;
      const travelLabel = [leg1, leg2].filter(l => l.minutes > 0).map(l => l.label).join('；') || '设备已就位';
      for (const leg of [leg1, leg2]) if (leg.crossZone) warningPoints.push(bp('cross-zone-travel', 'warning', leg.label, '移机时间已计入波次总耗时；如需压缩请按区组波', 'task', task.id));
      steps.push({
        sequence: index + 1, taskId: task.id, containerId: task.containerId, kind: task.kind as WaveKind,
        from: task.from, to: task.to, estimatedMinutes: task.estimatedMinutes, travelMinutes: travelTotal,
        travelLabel, prerequisites: prereqs, status: 'pending', blockingPoints: points,
      });
      if (stepHard) { aborted = true; hardErrors.push(...points.filter(p => p.severity === 'error')); }
      else {
        // 提交模拟堆存变化
        if (from) {
          removeAt(state, from);
          const fromBlock = blocks.find(b => b.id === from.blockId);
          if (fromBlock) state.occupied.set(from.blockId, (state.occupied.get(from.blockId) ?? fromBlock.occupied) - 1);
          if (container?.reefer) state.usedPlugs.set(from.blockId, Math.max(0, (state.usedPlugs.get(from.blockId) ?? 0) - 1));
        }
        if (to) {
          placeAt(state, to, task.containerId);
          state.occupied.set(to.blockId, (state.occupied.get(to.blockId) ?? 0) + 1);
          if (container?.reefer) state.usedPlugs.set(to.blockId, (state.usedPlugs.get(to.blockId) ?? 0) + 1);
          state.location.set(task.containerId, task.to);
        } else state.location.delete(task.containerId);
        anchor = task.to;
      }
    } else {
      steps.push({
        sequence: index + 1, taskId: task.id, containerId: task.containerId, kind: task.kind as WaveKind,
        from: task.from, to: task.to, estimatedMinutes: task.estimatedMinutes, travelMinutes: 0,
        travelLabel: '前序硬冲突未解除，暂不规划移机', prerequisites: [], status: 'pending', blockingPoints: [],
      });
    }
  });
  return { steps, hardErrors, warningPoints, anchor };
}

export interface WavePlan {
  equipmentId: string;
  taskIds: string[];
  feasible: boolean;
  blockingPoints: BlockingPoint[];
  steps: WaveStep[];
  estimatedMinutes: number;
}

/** 生成波次预案：返回拓扑顺序、逐步阻塞点、含跨区移机的预计耗时。不写入数据。 */
export function planWave(input: PlanInput, existing?: JobWave[]): WavePlan {
  const machine = equipment.find(e => e.id === input.equipmentId);
  const headerErrors: BlockingPoint[] = [];
  if (!machine) headerErrors.push(bp('equipment-state', 'error', `设备 ${input.equipmentId} 不存在`, '重新选择场桥', 'header'));
  else {
    if (machine.kind !== 'yard-crane') headerErrors.push(bp('equipment-state', 'error', `${machine.name} 不是场桥，不能承担场桥波次`, '选择 yard-crane 设备', 'header'));
    if (machine.status === 'maintenance' || machine.status === 'offline') headerErrors.push(bp('equipment-state', 'error', `${machine.name} 当前 ${machine.status}`, '等待设备恢复或更换场桥', 'header'));
  }
  const ids = input.taskIds ?? [];
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length) headerErrors.push(bp('task-state', 'error', `提交列表中任务重复：${[...new Set(duplicates)].join('、')}`, '去重后重新提交', 'header'));
  // 防止同一箱跨活动波次重复包含、同一任务被两个活动波次锁定、设备同时段冲突
  const active = (existing ?? waves).filter(w => w.status === 'validated' || w.status === 'running' || w.status === 'paused');
  for (const wave of active) {
    if (wave.equipmentId === input.equipmentId) headerErrors.push(bp('equipment-state', 'error', `${machine?.name ?? input.equipmentId} 已有活动波次 ${wave.id}（${wave.status}）`, '先完成或取消现有波次', 'header'));
    const overlap = ids.filter(id => wave.taskIds.includes(id));
    if (overlap.length) headerErrors.push(bp('task-state', 'error', `任务 ${overlap.join('、')} 已被活动波次 ${wave.id} 锁定`, '从当前选择中移除或先处理原波次', 'header'));
    const waveContainers = new Set(wave.steps.map(s => s.containerId));
    for (const id of ids) {
      const t = tasks.find(item => item.id === id);
      if (t && waveContainers.has(t.containerId)) headerErrors.push(bp('duplicate-container', 'error', `箱 ${t.containerId} 已在活动波次 ${wave.id} 中`, '同一箱不能同时出现在两个活动波次', 'task', t.id));
    }
  }
  const ctxOrErrors = buildContext(ids);
  if ('headerErrors' in ctxOrErrors) {
    return { equipmentId: input.equipmentId, taskIds: [...new Set(ids)], feasible: false, blockingPoints: [...headerErrors, ...ctxOrErrors.headerErrors], steps: [], estimatedMinutes: 0 };
  }
  const ctx = ctxOrErrors;
  const orderOrCycle = topoSort(ctx);
  if (!Array.isArray(orderOrCycle)) return { equipmentId: input.equipmentId, taskIds: ids, feasible: false, blockingPoints: [...headerErrors, orderOrCycle], steps: [], estimatedMinutes: 0 };
  const state = initialState(ctx);
  const { steps, hardErrors, warningPoints } = simulate(orderOrCycle, ctx, input.equipmentId, state);
  // DAG 推导出的层级/占用关系也汇总到计划级，供前端展示“阻塞点/约束点”
  const orderPoints = [...ctx.edgeReasons.values()].flat().filter((p, i, arr) => arr.findIndex(q => q.message === p.message) === i);
  const blockingPoints = [...headerErrors, ...ctx.hardErrors, ...hardErrors, ...warningPoints, ...orderPoints];
  const firstHardSequence = steps.find(s => s.blockingPoints.some(p => p.severity === 'error'))?.sequence;
  // 存在硬冲突时，只统计到冲突步骤为止（含），其后冻结步骤不计入预计耗时
  const estimatedMinutes = steps
    .filter(s => firstHardSequence === undefined || s.sequence <= firstHardSequence)
    .reduce((sum, s) => sum + s.estimatedMinutes + s.travelMinutes, 0);
  return { equipmentId: input.equipmentId, taskIds: ids, feasible: !blockingPoints.some(p => p.severity === 'error'), blockingPoints, steps, estimatedMinutes };
}

// ---------- 波次存储与生命周期 ----------

export const waves: JobWave[] = [];
let waveSeq = 0;
const now = () => new Date().toISOString();
const findWave = (id: string) => waves.find(w => w.id === id);
const touch = (wave: JobWave) => { wave.version += 1; wave.updatedAt = now(); };

function assertTransition(wave: JobWave, to: WaveStatus) {
  if (wave.status === to) throw new Error(`波次已处于 ${to} 状态，重复指令被拒绝（防止重新加载后重复放行）`);
  const allowed: Record<WaveStatus, WaveStatus[]> = {
    validated: ['running'],
    running: ['paused', 'completed', 'failed'],
    paused: ['running', 'failed'],
    completed: [],
    failed: ['running'],
  };
  if (!allowed[wave.status].includes(to)) throw new Error(`波次状态不能从 ${wave.status} 回到 ${to}（已防止重新加载后状态倒退）`);
}

export function createWave(input: PlanInput & { name?: string }): JobWave {
  const plan = planWave(input);
  if (!plan.feasible) {
    const first = plan.blockingPoints.find(p => p.severity === 'error');
    throw new Error(first?.message ?? '波次未通过路线校验，无法提交');
  }
  waveSeq += 1;
  const machine = equipment.find(e => e.id === input.equipmentId)!;
  const wave: JobWave = {
    id: `WAVE-${String(Date.now()).slice(-6)}-${waveSeq}`,
    name: input.name?.trim() || `${machine.name} 波次 ${waveSeq}`,
    equipmentId: input.equipmentId,
    status: 'validated',
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    taskIds: plan.taskIds,
    steps: plan.steps.map(s => ({ ...s, blockingPoints: s.blockingPoints.filter(p => p.severity !== 'error') })),
    blockingPoints: plan.blockingPoints,
    estimatedMinutes: plan.estimatedMinutes,
    remainingMinutes: plan.estimatedMinutes,
    elapsedMinutes: 0,
  };
  waves.unshift(wave);
  for (const taskId of wave.taskIds) {
    const task = tasks.find(t => t.id === taskId);
    if (task && task.status === 'queued') task.status = 'assigned';
  }
  recordAudit('WAVE_CREATE', 'job-wave', wave.id, `提交波次：${wave.taskIds.length} 个任务绑定 ${input.equipmentId}，预计 ${wave.estimatedMinutes} 分钟，${wave.blockingPoints.filter(p => p.severity !== 'error').length} 个提示点`);
  return wave;
}

export function listWaves() { return waves; }

/** 启动波次（也用于暂停后恢复：恢复点由第一个非终态步骤决定）。 */
export function startWave(id: string): JobWave {
  const wave = findWave(id);
  if (!wave) throw new Error('波次不存在');
  assertTransition(wave, 'running');
  const resumePoint = wave.steps.find(s => s.status === 'pending' || s.status === 'running' || s.status === 'failed');
  if (wave.status === 'paused') {
    // 断点恢复：按现场实况重算剩余路线，确认层级/占用/箱态没有被外部改变
    const recheck = revalidateRemaining(wave);
    if (!recheck.feasible) throw new Error(recheck.blockingPoints[0]?.message ?? '现场状态已变化，恢复被路线校验拦截');
    wave.interruptedAtSequence = resumePoint?.sequence;
    recordAudit('WAVE_RESUME', 'job-wave', wave.id, `从第 ${resumePoint?.sequence ?? '-'} 步断点恢复，剩余路线重新校验通过`);
  } else {
    recordAudit('WAVE_START', 'job-wave', wave.id, '波次开始执行');
  }
  wave.status = 'running';
  if (resumePoint && resumePoint.status === 'pending') { resumePoint.status = 'running'; resumePoint.startedAt = resumePoint.startedAt ?? now(); }
  syncTaskStatuses(wave);
  touch(wave);
  return wave;
}

export function pauseWave(id: string, reason?: string): JobWave {
  const wave = findWave(id);
  if (!wave) throw new Error('波次不存在');
  assertTransition(wave, 'paused');
  const current = wave.steps.find(s => s.status === 'running');
  wave.status = 'paused';
  wave.interruptedAtSequence = (current ?? wave.steps.find(s => s.status === 'pending'))?.sequence;
  if (current) { current.status = 'pending'; current.note = reason ? `中断：${reason}` : '现场中断，等待恢复'; }
  recordAudit('WAVE_PAUSE', 'job-wave', wave.id, `波次暂停于第 ${wave.interruptedAtSequence ?? '-'} 步${reason ? `：${reason}` : ''}`);
  touch(wave);
  return wave;
}

/** 完成单个任务步骤；强制顺序执行，后续任务在任一失败时保持冻结。 */
export function completeStep(waveId: string, taskId: string, payload?: { actualMinutes?: number }): JobWave {
  const wave = findWave(waveId);
  if (!wave) throw new Error('波次不存在');
  const step = wave.steps.find(s => s.taskId === taskId);
  if (!step) throw new Error('该任务不属于此波次');
  const failed = wave.steps.find(s => s.status === 'failed');
  if (failed && taskId !== failed.taskId) throw new Error(`第 ${failed.sequence} 步（${failed.taskId}）失败未处置，后续任务禁止放行`);
  if (wave.status !== 'running') throw new Error(`波次当前 ${wave.status}，只有执行中的波次可以回报完成`);
  const expected = wave.steps.find(s => ['pending', 'running'].includes(s.status));
  if (!expected) throw new Error('没有可回报的步骤');
  if (expected.taskId !== taskId) throw new Error(`当前应先完成 ${expected.taskId}（第 ${expected.sequence} 步），不能越过中断点操作 ${taskId}`);

  // 完成瞬间再次校验现场（防止模拟与实况漂移）
  const live = liveCheck(step);
  const liveErrors = live.filter(p => p.severity === 'error');
  if (liveErrors.length) return freezeWave(wave, step, liveErrors);

  step.status = 'done';
  step.finishedAt = now();
  step.note = payload?.actualMinutes ? `实际耗时 ${payload.actualMinutes} 分钟` : undefined;
  applyTaskCompletion(step);

  const consumed = step.estimatedMinutes + step.travelMinutes;
  wave.elapsedMinutes += payload?.actualMinutes ? payload.actualMinutes + step.travelMinutes : consumed;
  wave.remainingMinutes = Math.max(0, wave.remainingMinutes - consumed);

  const next = wave.steps.find(s => s.status === 'pending');
  if (next) next.status = 'running';
  else { wave.status = 'completed'; recordAudit('WAVE_COMPLETE', 'job-wave', wave.id, '全部步骤完成'); }
  syncTaskStatuses(wave);
  touch(wave);
  recordAudit('WAVE_STEP_DONE', 'job-wave', wave.id, `${taskId} 完成，下一步 ${next?.taskId ?? '无（波次完成）'}`);
  return wave;
}

/** 任务失败：冻结波次，所有后续 pending 步骤不得自动放行。 */
export function failStep(waveId: string, taskId: string, reason: string): JobWave {
  const wave = findWave(waveId);
  if (!wave) throw new Error('波次不存在');
  const step = wave.steps.find(s => s.taskId === taskId);
  if (!step) throw new Error('该任务不属于此波次');
  if (!['running', 'pending'].includes(step.status)) throw new Error(`步骤当前 ${step.status}，不能标记失败`);
  return freezeWave(wave, step, [bp('failed-predecessor', 'error', reason || '现场回报任务失败', '排除故障后重试该步骤；后续任务保持冻结', 'task', taskId)]);
}

function freezeWave(wave: JobWave, step: WaveStep, points: BlockingPoint[]) {
  step.status = 'failed';
  step.note = points[0]?.message;
  step.blockingPoints.push(...points);
  wave.status = 'failed';
  wave.failedAt = now();
  wave.failureReason = points.map(p => p.message).join('；');
  wave.interruptedAtSequence = step.sequence;
  for (const later of wave.steps.filter(s => s.sequence > step.sequence && s.status !== 'done')) {
    if (later.status === 'running') later.status = 'pending';
    later.blockingPoints.push(bp('failed-predecessor', 'warning', `前序 ${step.taskId} 失败，本步骤被冻结`, '等待前序恢复后自动解冻', 'task', later.taskId, step.taskId));
  }
  const task = tasks.find(t => t.id === step.taskId);
  if (task) { task.status = 'blocked'; task.blockingReasons = [...new Set([...task.blockingReasons, ...points.map(p => p.message)])]; }
  recordAudit('WAVE_FAIL', 'job-wave', wave.id, `第 ${step.sequence} 步 ${step.taskId} 失败，后续 ${wave.steps.filter(s => s.sequence > step.sequence).length} 步冻结：${wave.failureReason}`);
  touch(wave);
  return wave;
}

/** 故障排除后重试失败步骤：重新做现场校验，通过后波次回到 running。 */
export function retryStep(waveId: string, taskId: string): JobWave {
  const wave = findWave(waveId);
  if (!wave) throw new Error('波次不存在');
  const step = wave.steps.find(s => s.taskId === taskId);
  if (!step || step.status !== 'failed') throw new Error('只有失败的步骤可以重试');
  const live = liveCheck(step).filter(p => p.severity === 'error');
  if (live.length) throw new Error(live[0].message);
  step.status = 'running';
  step.startedAt = now();
  step.blockingPoints = step.blockingPoints.filter(p => p.code !== 'failed-predecessor');
  step.note = '故障排除，重试中';
  for (const later of wave.steps.filter(s => s.sequence > step.sequence)) {
    later.blockingPoints = later.blockingPoints.filter(p => p.code !== 'failed-predecessor');
  }
  wave.status = 'running';
  wave.failedAt = undefined; wave.failureReason = undefined;
  syncTaskStatuses(wave);
  touch(wave);
  recordAudit('WAVE_STEP_RETRY', 'job-wave', wave.id, `${taskId} 重新校验通过，波次解冻`);
  return wave;
}

/** 跳过失败步骤（仅在调度员确认该作业取消时）：其下游仍需重算可达性。 */
export function skipStep(waveId: string, taskId: string): JobWave {
  const wave = findWave(waveId);
  if (!wave) throw new Error('波次不存在');
  const step = wave.steps.find(s => s.taskId === taskId);
  if (!step || step.status !== 'failed') throw new Error('只有失败的步骤可以跳过');
  const recheck = revalidateRemaining(wave, new Set([taskId]));
  if (!recheck.feasible) throw new Error(recheck.blockingPoints[0]?.message ?? '跳过该步骤后剩余路线不成立');
  step.status = 'skipped';
  step.note = '调度确认取消该任务';
  const task = tasks.find(t => t.id === taskId);
  if (task) task.status = 'queued';
  for (const later of wave.steps.filter(s => s.sequence > step.sequence)) {
    later.blockingPoints = later.blockingPoints.filter(p => p.code !== 'failed-predecessor');
  }
  wave.status = wave.steps.every(s => ['done', 'skipped'].includes(s.status)) ? 'completed' : 'running';
  if (wave.status === 'running') { const next = wave.steps.find(s => s.status === 'pending'); if (next) next.status = 'running'; }
  wave.failedAt = undefined; wave.failureReason = undefined;
  syncTaskStatuses(wave);
  touch(wave);
  recordAudit('WAVE_STEP_SKIP', 'job-wave', wave.id, `${taskId} 被确认跳过，剩余路线重算`);
  return wave;
}

export function deleteWave(id: string): JobWave {
  const index = waves.findIndex(w => w.id === id);
  if (index < 0) throw new Error('波次不存在');
  const wave = waves[index];
  if (['running', 'paused'].includes(wave.status)) throw new Error('执行中或暂停的波次不能删除，请先完成或中止');
  for (const taskId of wave.taskIds) {
    const task = tasks.find(t => t.id === taskId);
    if (task && task.status === 'assigned' && !task.equipmentId) task.status = 'queued';
  }
  waves.splice(index, 1);
  recordAudit('WAVE_DELETE', 'job-wave', id, '波次记录删除');
  return wave;
}

// ---------- 恢复与现场校验 ----------

function liveCheck(step: WaveStep): BlockingPoint[] {
  const points: BlockingPoint[] = [];
  const container = containers.find(c => c.id === step.containerId);
  if (!container) return [bp('container-state', 'error', `箱 ${step.containerId} 台账已不存在`, '恢复箱务记录', 'task', step.taskId)];
  const from = parseSlot(step.from);
  if (from) {
    // 前序 done 步骤可能已经合法移动过该箱；台账位置与预期不符才拦截
    const owner = waveOwningStep(step)?.wave;
    const movedByDone = owner?.steps.some(s => s.status === 'done' && s.containerId === step.containerId && s.to === container.yardSlot);
    if (container.yardSlot !== step.from && !movedByDone) points.push(bp('tier-order', 'error', `箱 ${container.id} 现场位置为 ${container.yardSlot}，与步骤起点 ${step.from} 不一致`, '以现场箱位为准重建波次', 'task', step.taskId));
  }
  if (step.kind === 'deliver' && container.customs !== 'released') points.push(bp('customs-hold', 'error', `箱 ${container.id} 海关已变为 ${container.customs}，恢复时拒绝放行`, '等待放行', 'task', step.taskId));
  if (from) {
    const block = blocks.find(b => b.id === from.blockId);
    const stack = buildLiveStack(from.key);
    const occupant = stack[from.tier];
    if (occupant !== step.containerId) points.push(bp('tier-order', 'error', `${step.from} 现场箱为 ${occupant ?? '空'}，不是 ${step.containerId}`, '重新勘测堆存并更新波次', 'task', step.taskId));
    const above = stack.slice(from.tier + 1).filter(Boolean);
    if (above.length) points.push(bp('tier-order', 'error', `现场 ${step.from} 上方仍有 ${above.length} 个压箱`, '补排翻箱后再恢复', 'task', step.taskId));
    if (!block) points.push(bp('unsupported-slot', 'error', `起点区块 ${from.blockId} 不存在`, '修正任务', 'task', step.taskId));
  }
  const machine = equipment.find(e => e.id === waveOwningStep(step)?.wave.equipmentId);
  if (machine && (machine.status === 'maintenance' || machine.status === 'offline')) points.push(bp('equipment-state', 'error', `${machine.name} 当前 ${machine.status}`, '更换设备或等待恢复', 'task', step.taskId));
  return points;
}
function waveOwningStep(step: WaveStep): { wave: JobWave } | undefined {
  const wave = waves.find(w => w.steps.some(s => s.taskId === step.taskId));
  return wave ? { wave } : undefined;
}
function buildLiveStack(key: string): string[] {
  const stack: string[] = [];
  for (const c of containers) {
    const slot = parseSlot(c.yardSlot);
    if (slot && slot.key === key) stack[slot.tier] = c.id;
  }
  return stack;
}

/** 恢复前按当前台账重算剩余步骤：已完成步骤作为既成事实推进模拟。 */
export function revalidateRemaining(wave: JobWave, skipped: Set<string> = new Set()): WavePlan {
  const remaining = wave.steps.filter(s => !['done', 'skipped'].includes(s.status) && !skipped.has(s.taskId));
  const done = wave.steps.filter(s => s.status === 'done');
  const ctxTasks = remaining.map(s => tasks.find(t => t.id === s.taskId)!).filter(Boolean);
  const ctx: PlanContext = {
    tasks: ctxTasks, byId: new Map(ctxTasks.map(t => [t.id, t])), containerOf: new Map(ctxTasks.map(t => [t.id, t.containerId])),
    edges: new Map(), edgeReasons: new Map(), hardErrors: [],
  };
  // 保留原波次内剩余步骤之间的前置关系
  for (const s of remaining) {
    const pres = s.prerequisites.filter(id => remaining.some(r => r.taskId === id));
    if (pres.length) ctx.edges.set(s.taskId, new Set(pres));
    for (const pre of pres) {
      ctx.edgeReasons.set(`${pre}->${s.taskId}`, s.blockingPoints.filter(p => p.code === 'tier-order' || p.code === 'slot-occupied'));
    }
  }
  const state = initialState(ctx);
  // 重放已完成步骤的物理效应
  for (const s of done) {
    const from = parseSlot(s.from); const to = parseSlot(s.to);
    if (from) removeAt(state, from);
    if (to) { placeAt(state, to, s.containerId); state.location.set(s.containerId, s.to); }
    else state.location.delete(s.containerId);
  }
  const order = remaining.slice().sort((a, b) => a.sequence - b.sequence).map(s => tasks.find(t => t.id === s.taskId)!);
  const anchor = done.length ? (parseSlot(done[done.length - 1].to) ? done[done.length - 1].to : done[done.length - 1].from) : undefined;
  const { steps, hardErrors, warningPoints } = simulate(order, ctx, wave.equipmentId, state, { startAnchor: anchor });
  return {
    equipmentId: wave.equipmentId,
    taskIds: remaining.map(s => s.taskId),
    feasible: !hardErrors.length,
    blockingPoints: [...hardErrors, ...warningPoints],
    steps,
    estimatedMinutes: steps.reduce((sum, s) => sum + s.estimatedMinutes + s.travelMinutes, 0),
  };
}

function applyTaskCompletion(step: WaveStep) {
  const task = tasks.find(t => t.id === step.taskId);
  const container = containers.find(c => c.id === step.containerId);
  if (task) { task.status = 'done'; task.blockingReasons = []; }
  if (container) {
    if (step.kind === 'load') { container.status = 'on-quay'; container.lastEvent = `波次装船完成 ${new Date().toLocaleTimeString()}`; }
    else if (step.kind === 'deliver') { container.status = 'released'; container.lastEvent = `波次提箱出场 ${new Date().toLocaleTimeString()}`; }
    else {
      if (parseSlot(step.to)) { container.yardSlot = step.to; container.status = 'in-yard'; container.lastEvent = `波次翻箱至 ${step.to} ${new Date().toLocaleTimeString()}`; }
    }
  }
}

function syncTaskStatuses(wave: JobWave) {
  for (const step of wave.steps) {
    const task = tasks.find(t => t.id === step.taskId);
    if (!task) continue;
    if (step.status === 'done') task.status = 'done';
    else if (step.status === 'failed') task.status = 'blocked';
    else if (step.status === 'skipped') task.status = 'queued';
    else if (wave.status === 'running') { if (step.status === 'running') task.status = 'executing'; else if (task.status !== 'executing') task.status = 'assigned'; }
    else if (wave.status === 'paused' || wave.status === 'failed') task.status = 'blocked';
    else task.status = 'assigned';
    if (!task.equipmentId) task.equipmentId = wave.equipmentId;
  }
}

// ---------- 种子波次：一个在途、一个中断待恢复 ----------

function seedWaves() {
  const seed = (equipmentId: string, taskIds: string[], name: string) => {
    try {
      const wave = createWave({ equipmentId, taskIds, name });
      return wave;
    } catch (error) {
      recordAudit('WAVE_SEED_SKIP', 'job-wave', equipmentId, `种子波次未生成：${error instanceof Error ? error.message : '未知错误'}`);
      return undefined;
    }
  };
  // YC-12：同排压箱链 + 同箱翻箱 + 跨区移机
  const w12 = seed('YC-12', ['TASK-105', 'TASK-102', 'TASK-106', 'TASK-101'], 'YC-12 北侧翻箱-提箱波次');
  if (w12) startWave(w12.id);
  // YC-05：装船清排链，完成第一步后中断，提供恢复入口
  const w05 = seed('YC-05', ['TASK-107', 'TASK-104'], 'YC-05 出口装船清排波次');
  if (w05) {
    startWave(w05.id);
    completeStep(w05.id, 'TASK-107');
    pauseWave(w05.id, '场桥等待第二艘集卡对位，调度主动暂停');
  }
}
seedWaves();

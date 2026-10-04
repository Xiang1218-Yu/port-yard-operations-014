import { auditEvents, blocks, containers, equipment, registerTaskLockChecker, tasks, voyages, type YardTask } from './domain.js';

// ─────────────────────────────────────────────────────────────────────────────
// 场桥作业波次（work wave）：把可关联的 rehandle / deliver / load 任务组批，
// 校验堆位层级与任务前置关系，生成执行顺序，支持现场中断后从断点恢复。
// ─────────────────────────────────────────────────────────────────────────────

export type WaveStatus = 'planned' | 'running' | 'interrupted' | 'completed' | 'cancelled';
export type WaveStepStatus = 'pending' | 'executing' | 'done' | 'failed';
export type IssueLevel = 'hard' | 'blocker' | 'warning';
export type WaveKind = 'rehandle' | 'deliver' | 'load';
export type WaveIssueCode =
  | 'UNSUPPORTED_KIND' | 'TASK_NOT_FOUND' | 'TASK_DONE' | 'TASK_LOCKED'
  | 'CONTAINER_MISSING' | 'DUPLICATE_CONTAINER' | 'CUSTOMS_HOLD' | 'CONTAINER_STATE'
  | 'FROM_MISMATCH' | 'FROM_NOT_SLOT' | 'TIER_OVERFLOW' | 'ABOVE_NOT_CLEARED'
  | 'DEST_OCCUPIED' | 'DEST_UNSUPPORTED' | 'DEST_DUPLICATE' | 'FLOATING_DEST'
  | 'HAZMAT_BLOCK' | 'REEFER_PLUG' | 'PREREQ_NOT_FOUND' | 'PREREQ_CYCLE'
  | 'EQUIPMENT_NOT_CRANE' | 'EQUIPMENT_UNAVAILABLE' | 'EQUIPMENT_BUSY'
  | 'CROSS_ZONE_TRAVEL' | 'TASK_ALREADY_BLOCKED';

export interface WaveIssue {
  level: IssueLevel;
  code: WaveIssueCode;
  taskId?: string;
  message: string;
}

export interface WaveStep {
  taskId: string;
  containerId: string;
  kind: WaveKind;
  from: string;
  to: string;
  order: number;
  prerequisites: string[];
  status: WaveStepStatus;
  workMinutes: number;
  travelMinutesBefore: number;
  crossZone: boolean;
  travelLabel: string;
  plannedStart: string;
  plannedEnd: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export interface Checkpoint {
  at: string;
  completedTaskId: string;
  nextTaskId?: string;
  stepsDone: number;
  stepsTotal: number;
}

export interface BlockingPoint { taskId: string; label: string; detail: string; }

export interface WorkWave {
  id: string;
  name: string;
  equipmentId: string;
  equipmentName: string;
  status: WaveStatus;
  steps: WaveStep[];
  etaMinutes: number;
  workMinutes: number;
  travelMinutes: number;
  idleMinutes: number;
  issues: WaveIssue[];
  blockingPoints: BlockingPoint[];
  revision: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastCheckpoint?: Checkpoint;
  resumeTaskId?: string;
}

export interface CreateWaveInput {
  name?: string;
  equipmentId: string;
  taskIds: string[];
  explicitPrerequisites?: { taskId: string; requiresTaskId: string }[];
  startAt?: string;
}

export class WaveError extends Error {
  constructor(public issues: WaveIssue[]) {
    super(issues.map(item => item.message).join('；'));
    this.name = 'WaveError';
  }
}

// ── 堆位与区块解析 ────────────────────────────────────────────────────────────

export interface SlotRef { blockId: string; row: number; tier: number; }
const SLOT_RE = /^([A-Z]\d{2})-R(\d{2})(?:-T(\d))?$/;
export function parseSlot(slot: string): SlotRef | undefined {
  const match = slot.match(SLOT_RE);
  if (!match || match[3] === undefined) return undefined;
  return { blockId: match[1], row: Number(match[2]), tier: Number(match[3]) };
}
/** 与 parseSlot 相同，但允许只到排（如设备位置 "B07-R03"） */
function parseBlockRow(slot: string): SlotRef | undefined {
  const match = slot.match(SLOT_RE);
  if (!match) return undefined;
  return { blockId: match[1], row: Number(match[2]), tier: match[3] ? Number(match[3]) : 0 };
}
const blockById = (id: string) => blocks.find(block => block.id === id);
const blockIndex = (id: string) => ['A01', 'B07', 'C03', 'D05'].indexOf(id);

/** 设备当前所在位置解析为区块（如 "B07-R03" → B07）；外部节点返回 undefined */
function craneLocationBlock(location: string): string | undefined {
  return location.match(/^([A-Z]\d{2})(?:-R\d{2})?(?:\s|\/|$)/)?.[1];
}

/**
 * 场桥移动时间：同区内沿排移动 2 分钟；相邻区块 6、跨两个 10、跨三个 14 分钟；
 * 从闸口/泊位等外部节点进入堆区 8 分钟。跨区移动必须计入波次预计耗时。
 */
export function travelMinutes(from: string | undefined, toSlot: string): { minutes: number; crossZone: boolean; label: string } {
  const to = parseSlot(toSlot);
  if (!to || !from) return { minutes: 0, crossZone: false, label: '' };
  const fromSlot = parseBlockRow(from);
  if (fromSlot) {
    if (fromSlot.blockId === to.blockId) {
      return { minutes: 2, crossZone: false, label: `同区移机 ${fromSlot.blockId} R${String(fromSlot.row).padStart(2, '0')}→R${String(to.row).padStart(2, '0')}（2 分钟）` };
    }
    const gap = Math.abs(blockIndex(fromSlot.blockId) - blockIndex(to.blockId));
    const minutes = gap >= 3 ? 14 : gap === 2 ? 10 : 6;
    return { minutes, crossZone: true, label: `跨区移机 ${fromSlot.blockId}→${to.blockId}（${minutes} 分钟，已计入预计耗时）` };
  }
  return { minutes: 8, crossZone: true, label: `从外部节点 ${from} 进入 ${to.blockId}（8 分钟，已计入预计耗时）` };
}

// ── 校验与排序 ────────────────────────────────────────────────────────────────

const WAVE_TASK_KINDS = new Set(['rehandle', 'deliver', 'load']);
const OCCUPYING_STATUSES = new Set(['in-yard', 'hold']);
interface Edge { from: string; to: string; reason: string; }

interface PlanResult {
  steps: WaveStep[];
  issues: WaveIssue[];
  etaMinutes: number;
  workMinutes: number;
  travelMinutes: number;
  idleMinutes: number;
  blockingPoints: BlockingPoint[];
}

/**
 * 组波校验 + 路线生成。hard 级别问题必须修正后才能提交；warning 随波次返回并
 * 在前端展示为阻塞点提示。selfWaveId 用于断点恢复时跳过本波次自身的任务锁。
 */
export function buildPlan(input: CreateWaveInput, selfWaveId?: string): PlanResult {
  const issues: WaveIssue[] = [];
  const edges: Edge[] = [];
  const hard = (code: WaveIssueCode, message: string, taskId?: string) => issues.push({ level: 'hard', code, message, taskId });
  const warn = (code: WaveIssueCode, message: string, taskId?: string) => issues.push({ level: 'warning', code, message, taskId });

  const crane = equipment.find(item => item.id === input.equipmentId);
  if (!crane) hard('EQUIPMENT_NOT_CRANE', `设备 ${input.equipmentId} 不存在`);
  else if (crane.kind !== 'yard-crane') hard('EQUIPMENT_NOT_CRANE', `${crane.name} 不是场桥，不能作为作业波次执行设备`);
  else if (crane.status === 'maintenance' || crane.status === 'offline') hard('EQUIPMENT_UNAVAILABLE', `${crane.name} 当前${crane.status === 'maintenance' ? '维护中' : '离线'}，无法执行波次`);
  const busyWave = activeWaveForEquipment(input.equipmentId, selfWaveId);
  if (busyWave) hard('EQUIPMENT_BUSY', `${crane?.name ?? input.equipmentId} 已被进行中的波次 ${busyWave.id} 占用，设备不能同时跨波次作业`);

  if (!input.taskIds.length) hard('TASK_NOT_FOUND', '波次至少要包含一条任务');

  const taskById = new Map(tasks.map(task => [task.id, task]));
  const selected: YardTask[] = [];
  for (const taskId of input.taskIds) {
    const task = taskById.get(taskId);
    if (!task) { hard('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, taskId); continue; }
    selected.push(task);
  }

  // 当前堆位实况（模拟前的初始占用）
  const liveOccupants = new Map<string, string>();
  for (const container of containers) {
    if (OCCUPYING_STATUSES.has(container.status) && parseSlot(container.yardSlot)) liveOccupants.set(container.yardSlot, container.id);
  }
  const otherWaveContainers = activeContainers(selfWaveId);

  const seenContainers = new Map<string, string>();
  for (const task of selected) {
    if (!WAVE_TASK_KINDS.has(task.kind)) hard('UNSUPPORTED_KIND', `任务 ${task.id}（${task.kind}）不属于 rehandle/deliver/load，不能纳入场桥作业波次`, task.id);
    if (task.status === 'done') hard('TASK_DONE', `任务 ${task.id} 已完成，不能重复组波`, task.id);
    if (task.waveId && task.waveId !== selfWaveId) {
      const owner = waves.find(wave => wave.id === task.waveId);
      if (owner && owner.status !== 'cancelled') hard('TASK_LOCKED', `任务 ${task.id} 已属于波次 ${task.waveId}（${owner.status}），不能重复组波`, task.id);
    }
    const container = containers.find(item => item.id === task.containerId);
    if (!container) { hard('CONTAINER_MISSING', `任务 ${task.id} 关联箱 ${task.containerId} 不在台账中`, task.id); continue; }
    if (seenContainers.has(container.id)) hard('DUPLICATE_CONTAINER', `箱 ${container.id} 在波次中出现多次（${seenContainers.get(container.id)} 与 ${task.id}），一个波次内同一箱只能有一条作业`, task.id);
    else seenContainers.set(container.id, task.id);
    const ownerWaveId = otherWaveContainers.get(container.id);
    if (ownerWaveId) hard('DUPLICATE_CONTAINER', `箱 ${container.id} 已被进行中的波次 ${ownerWaveId} 锁定，禁止重复包含`, task.id);
    if (container.customs === 'hold' || container.customs === 'inspection') hard('CUSTOMS_HOLD', `箱 ${container.id} 海关状态为 ${container.customs}，${task.kind} 作业不能放行`, task.id);
    if (task.kind === 'load' && container.status !== 'in-yard') hard('CONTAINER_STATE', `箱 ${container.id} 当前状态 ${container.status}，不在堆场，无法装船`, task.id);
    if (task.kind === 'load') {
      const voyageRef = task.to.match(/VOY-[A-Z0-9]+/)?.[0];
      const voyage = voyageRef ? voyages.find(v => v.id === voyageRef) : undefined;
      if (voyageRef && !voyage) hard('CONTAINER_STATE', `装船目标航次 ${voyageRef} 不存在，无法编排`, task.id);
      else if (voyage && voyage.status !== 'berthed' && voyage.status !== 'loading') warn('CROSS_ZONE_TRAVEL', `装船任务 ${task.id} 的目标航次 ${voyageRef} 当前 ${voyage.status}，泊位/岸桥窗口未就绪，执行时可能再次中断`, task.id);
    }
    if ((task.kind === 'deliver' || task.kind === 'rehandle') && !OCCUPYING_STATUSES.has(container.status)) hard('CONTAINER_STATE', `箱 ${container.id} 当前状态 ${container.status}，${task.kind} 作业要求箱子在堆场内`, task.id);
    if (OCCUPYING_STATUSES.has(container.status) && container.yardSlot !== task.from) hard('FROM_MISMATCH', `任务 ${task.id} 起点 ${task.from} 与箱 ${container.id} 当前堆位 ${container.yardSlot} 不一致，现场箱位已变化，需要重新排程`, task.id);

    const from = parseSlot(task.from);
    if (!from) hard('FROM_NOT_SLOT', `任务 ${task.id} 起点 ${task.from} 不是堆位，场桥无法从该位置取箱`, task.id);
    else {
      const fromBlock = blockById(from.blockId);
      if (!fromBlock) hard('FROM_NOT_SLOT', `起点堆位所属区块 ${from.blockId} 不存在`, task.id);
      else {
        if (from.tier > fromBlock.tiers) hard('TIER_OVERFLOW', `起点 ${task.from} 超出 ${from.blockId} 最大层高 ${fromBlock.tiers}`, task.id);
        if (from.row > fromBlock.rows) hard('FROM_NOT_SLOT', `起点 ${task.from} 超出 ${from.blockId} 排数 ${fromBlock.rows}`, task.id);
        if (!fromBlock.equipment.includes('yard-crane')) hard('EQUIPMENT_NOT_CRANE', `区块 ${from.blockId} 不允许场桥进入（仅 ${fromBlock.equipment.join('/')}）`, task.id);
      }
      const occupant = liveOccupants.get(task.from);
      if (occupant && occupant !== container.id) hard('FROM_NOT_SLOT', `起点 ${task.from} 当前被箱 ${occupant} 占用，与任务箱不符`, task.id);
      // 同排上方有箱：在本波次内 → 自动加前置边；不在波次内 → 硬性阻塞
      for (let tier = from.tier + 1; fromBlock && tier <= fromBlock.tiers; tier++) {
        const aboveSlot = `${from.blockId}-R${String(from.row).padStart(2, '0')}-T${tier}`;
        const aboveId = liveOccupants.get(aboveSlot);
        if (!aboveId) continue;
        const clearingTask = selected.find(item => item.containerId === aboveId);
        if (clearingTask && clearingTask.id !== task.id) edges.push({ from: clearingTask.id, to: task.id, reason: `${aboveSlot} 的上层箱 ${aboveId} 必须先翻走` });
        else hard('ABOVE_NOT_CLEARED', `${task.from} 上方 ${aboveSlot} 仍有箱 ${aboveId}，且不在本波次翻箱范围内，必须先安排翻箱或人工确认`, task.id);
      }
    }

    const to = parseSlot(task.to);
    if (to) {
      const block = blockById(to.blockId);
      if (!block) hard('DEST_UNSUPPORTED', `终点堆位所属区块 ${to.blockId} 不存在`, task.id);
      else {
        if (to.tier > block.tiers) hard('TIER_OVERFLOW', `终点 ${task.to} 超出 ${to.blockId} 最大层高 ${block.tiers}`, task.id);
        if (to.row > block.rows) hard('DEST_UNSUPPORTED', `终点 ${task.to} 超出 ${to.blockId} 排数 ${block.rows}`, task.id);
        if (!block.equipment.includes('yard-crane')) hard('EQUIPMENT_NOT_CRANE', `目标区块 ${to.blockId} 不允许场桥进入`, task.id);
        if (container.hazmatClass && !block.hazmatAllowed) hard('HAZMAT_BLOCK', `危险品箱 ${container.id} 不能翻入无隔离资质的区块 ${to.blockId}`, task.id);
        if (container.reefer && block.reeferPlugs <= block.usedPlugs && parseSlot(task.from)?.blockId !== to.blockId) hard('REEFER_PLUG', `目标区块 ${to.blockId} 没有可用冷藏插座，冷藏箱 ${container.id} 无法接入`, task.id);
      }
      const occupant = liveOccupants.get(task.to);
      if (occupant && occupant !== container.id) {
        const clearingTask = selected.find(item => item.containerId === occupant);
        if (clearingTask && clearingTask.id !== task.id) edges.push({ from: clearingTask.id, to: task.id, reason: `目标位 ${task.to} 被 ${occupant} 占用，需先完成 ${clearingTask.id}` });
        else hard('DEST_OCCUPIED', `终点 ${task.to} 已被箱 ${occupant} 占用，且该箱不在本波次作业范围内`, task.id);
      }
    }
    if (task.blockingReasons.length) warn('TASK_ALREADY_BLOCKED', `任务 ${task.id} 存在既存阻塞提示：${task.blockingReasons.join('；')}`, task.id);
  }

  // 终点堆位在同一波次内被多条任务作为目标 → 同一堆位不能连续落两个箱
  const destOwners = new Map<string, string>();
  for (const task of selected) {
    if (!parseSlot(task.to)) continue;
    const prev = destOwners.get(task.to);
    if (prev) hard('DEST_DUPLICATE', `${prev} 与 ${task.id} 的终点同为 ${task.to}，同一堆位不能连续落两个箱`, task.id);
    destOwners.set(task.to, task.id);
  }

  // 显式前置关系
  for (const rel of input.explicitPrerequisites ?? []) {
    if (!selected.some(item => item.id === rel.taskId)) { hard('PREREQ_NOT_FOUND', `任务 ${rel.taskId} 不在波次中，无法建立前置关系`, rel.taskId); continue; }
    if (!selected.some(item => item.id === rel.requiresTaskId)) { hard('PREREQ_NOT_FOUND', `前置任务 ${rel.requiresTaskId} 不在波次中`, rel.taskId); continue; }
    edges.push({ from: rel.requiresTaskId, to: rel.taskId, reason: `显式指定 ${rel.requiresTaskId} → ${rel.taskId}` });
  }

  // 去重边
  const edgeKey = new Set<string>();
  const prereqMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}`;
    if (edgeKey.has(key)) continue;
    edgeKey.add(key);
    if (!prereqMap.has(edge.to)) prereqMap.set(edge.to, new Set());
    prereqMap.get(edge.to)!.add(edge.from);
  }

  // 环检测
  const cycle = detectCycle(selected.map(t => t.id), prereqMap);
  if (cycle) hard('PREREQ_CYCLE', `任务前置关系存在环路：${cycle.join(' → ')}，无法生成执行顺序`);

  // 拓扑贪心：就绪任务中优先同区（减少跨区移机），再按优先级、计划时间
  const remaining = new Set(selected.map(task => task.id));
  const ordered: YardTask[] = [];
  let craneBlock = crane ? craneLocationBlock(crane.location) : undefined;
  while (remaining.size) {
    const ready = [...remaining].filter(id => {
      const reqs = prereqMap.get(id);
      return !reqs || [...reqs].every(req => !remaining.has(req));
    });
    if (!ready.length) { hard('PREREQ_CYCLE', `任务 ${[...remaining].join('、')} 的前置关系无法满足`); break; }
    const pickId = ready.sort((aId, bId) => {
      const a = taskById.get(aId)!; const b = taskById.get(bId)!;
      const aFrom = parseSlot(a.from)?.blockId; const bFrom = parseSlot(b.from)?.blockId;
      const aSame = aFrom && aFrom === craneBlock ? 0 : 1;
      const bSame = bFrom && bFrom === craneBlock ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    })[0];
    remaining.delete(pickId);
    const picked = taskById.get(pickId)!;
    ordered.push(picked);
    craneBlock = parseSlot(picked.to)?.blockId ?? parseSlot(picked.from)?.blockId ?? craneBlock;
  }

  // 按顺序模拟：悬空落箱、终点占用，并生成时间线
  const startMs = new Date(input.startAt ?? Date.now()).getTime();
  const steps: WaveStep[] = [];
  const simOccupants = new Map(liveOccupants);
  let cursor = startMs;
  let workMinutes = 0; let travelMinutesTotal = 0; let idleMinutes = 0;
  let previousFrom: string | undefined = crane ? crane.location : undefined;
  const blockingPoints: BlockingPoint[] = [];

  ordered.forEach((task, index) => {
    const prerequisites = [...(prereqMap.get(task.id) ?? [])];
    const travel = travelMinutes(previousFrom, task.from);
    const scheduledMs = new Date(task.scheduledAt).getTime();
    let plannedStart = cursor + travel.minutes * 60000;
    if (scheduledMs > plannedStart) { idleMinutes += Math.round((scheduledMs - plannedStart) / 60000); plannedStart = scheduledMs; }
    const plannedEnd = plannedStart + task.estimatedMinutes * 60000;

    const here = simOccupants.get(task.from);
    if (here && here !== task.containerId) hard('FROM_NOT_SLOT', `按当前顺序执行到 ${task.id} 时，${task.from} 上是箱 ${here}，取箱冲突`, task.id);
    const to = parseSlot(task.to);
    if (to && to.tier > 1) {
      const below = `${to.blockId}-R${String(to.row).padStart(2, '0')}-T${to.tier - 1}`;
      if (!simOccupants.get(below)) hard('FLOATING_DEST', `任务 ${task.id} 落箱到 ${task.to} 时下层 ${below} 无箱，违反堆位层级`, task.id);
    }
    simOccupants.delete(task.from);
    if (to) {
      const occupant = simOccupants.get(task.to);
      if (occupant && occupant !== task.containerId) hard('DEST_OCCUPIED', `按当前顺序执行到 ${task.id} 时，终点 ${task.to} 仍被箱 ${occupant} 占用`, task.id);
      simOccupants.set(task.to, task.containerId);
    }

    workMinutes += task.estimatedMinutes;
    travelMinutesTotal += travel.minutes;
    steps.push({
      taskId: task.id, containerId: task.containerId, kind: task.kind as WaveKind,
      from: task.from, to: task.to, order: index, prerequisites, status: 'pending',
      workMinutes: task.estimatedMinutes, travelMinutesBefore: travel.minutes,
      crossZone: travel.crossZone, travelLabel: travel.label,
      plannedStart: new Date(plannedStart).toISOString(), plannedEnd: new Date(plannedEnd).toISOString(),
    });
    if (travel.crossZone) blockingPoints.push({ taskId: task.id, label: '设备跨区移动', detail: travel.label });
    for (const prereqId of prerequisites) {
      const prereqTask = taskById.get(prereqId);
      blockingPoints.push({ taskId: task.id, label: '前置作业', detail: `${prereqId}（${prereqTask?.containerId ?? prereqId}）完成后才能执行本步` });
    }
    previousFrom = task.to;
    cursor = plannedEnd;
  });

  for (const issue of issues.filter(item => item.level === 'warning' && item.taskId)) {
    blockingPoints.push({ taskId: issue.taskId!, label: '既存阻塞提示', detail: issue.message });
  }

  return {
    steps,
    issues,
    etaMinutes: workMinutes + travelMinutesTotal + idleMinutes,
    workMinutes, travelMinutes: travelMinutesTotal, idleMinutes,
    blockingPoints: dedupeBlockingPoints(blockingPoints),
  };
}

function dedupeBlockingPoints(items: BlockingPoint[]) {
  const seen = new Set<string>();
  return items.filter(item => { const key = `${item.taskId}:${item.label}:${item.detail}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

function detectCycle(ids: string[], prereqMap: Map<string, Set<string>>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | undefined => {
    state.set(id, 1); stack.push(id);
    for (const req of prereqMap.get(id) ?? []) {
      const s = state.get(req) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(req)), req];
      if (s === 0) { const found = dfs(req); if (found) return found; }
    }
    state.set(id, 2); stack.pop();
    return undefined;
  };
  for (const id of ids) { if (!state.has(id)) { const found = dfs(id); if (found) return found; } }
  return undefined;
}

// ── 波次存储与状态机 ─────────────────────────────────────────────────────────

export const waves: WorkWave[] = [];
let waveSeq = 0;
const nextWaveId = () => `WAVE-${String(++waveSeq).padStart(3, '0')}`;
const isActive = (wave: WorkWave) => wave.status === 'planned' || wave.status === 'running' || wave.status === 'interrupted';

function activeWaveForEquipment(equipmentId: string, selfWaveId?: string): WorkWave | undefined {
  return waves.find(wave => wave.equipmentId === equipmentId && isActive(wave) && wave.id !== selfWaveId);
}
function activeContainers(selfWaveId?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const wave of waves) {
    if (!isActive(wave) || wave.id === selfWaveId) continue;
    for (const step of wave.steps) map.set(step.containerId, wave.id);
  }
  return map;
}

export function listWaves(): WorkWave[] { return waves; }
export function getWave(id: string): WorkWave | undefined { return waves.find(wave => wave.id === id); }

/** 种子波次使用固定编号时，同步任务上的 waveId 引用，避免重新加载后引用悬空 */
function renameWave(wave: WorkWave, id: string) {
  const oldId = wave.id;
  wave.id = id;
  for (const step of wave.steps) {
    const task = tasks.find(item => item.id === step.taskId);
    if (task && task.waveId === oldId) task.waveId = id;
  }
}

/** 只校验不落库，供前端实时预览预计耗时与阻塞点 */
export function previewWave(input: CreateWaveInput) { return buildPlan(input); }

export function createWave(input: CreateWaveInput): WorkWave {
  const plan = buildPlan(input);
  const hardIssues = plan.issues.filter(issue => issue.level === 'hard');
  if (hardIssues.length) throw new WaveError(hardIssues);
  const id = nextWaveId();
  const crane = equipment.find(item => item.id === input.equipmentId)!;
  const wave: WorkWave = {
    id,
    name: input.name?.trim() || `${crane.name} 作业波次 ${id}`,
    equipmentId: crane.id, equipmentName: crane.name,
    status: 'planned',
    steps: plan.steps,
    etaMinutes: plan.etaMinutes, workMinutes: plan.workMinutes,
    travelMinutes: plan.travelMinutes, idleMinutes: plan.idleMinutes,
    issues: plan.issues, blockingPoints: plan.blockingPoints,
    revision: 1, createdAt: new Date().toISOString(),
  };
  for (const step of wave.steps) {
    const task = tasks.find(item => item.id === step.taskId)!;
    task.waveId = id; task.equipmentId = crane.id;
    if (task.status === 'queued') task.status = 'assigned';
  }
  waves.unshift(wave);
  recordWaveAudit('WAVE_CREATE', id, `组波完成：${wave.steps.length} 步，预计 ${wave.etaMinutes} 分钟（含跨区移机 ${wave.travelMinutes} 分钟）`);
  return wave;
}

function requireWave(id: string) {
  const wave = getWave(id);
  if (!wave) throw new WaveError([{ level: 'hard', code: 'TASK_NOT_FOUND', message: `波次 ${id} 不存在` }]);
  return wave;
}
function checkRevision(wave: WorkWave, revision?: number) {
  if (revision !== undefined && revision !== wave.revision) {
    throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `波次 ${wave.id} 已被其他操作更新（当前 revision=${wave.revision}，提交 revision=${revision}），请刷新后重试，禁止覆盖现场最新状态` }]);
  }
}
function findStep(wave: WorkWave, taskId: string) {
  const step = wave.steps.find(item => item.taskId === taskId);
  if (!step) throw new WaveError([{ level: 'hard', code: 'TASK_NOT_FOUND', message: `任务 ${taskId} 不属于波次 ${wave.id}` }]);
  return step;
}
/** 前置步骤必须全部完成；失败任务的后续步骤一律不放行 */
function assertPrereqsDone(wave: WorkWave, step: WaveStep) {
  for (const prereqId of step.prerequisites) {
    const prereq = findStep(wave, prereqId);
    if (prereq.status !== 'done') throw new WaveError([{ level: 'hard', code: 'ABOVE_NOT_CLEARED', message: `前置任务 ${prereqId} 状态为 ${prereq.status}，${step.taskId} 不能放行` }]);
  }
}
function recordWaveAudit(action: string, entityId: string, details: string) {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, actor: '场桥波次调度', action, entity: 'work-wave', entityId, at: new Date().toISOString(), details });
}

export function startWave(id: string, revision?: number): WorkWave {
  const wave = requireWave(id);
  checkRevision(wave, revision);
  if (wave.status !== 'planned') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `波次 ${id} 当前状态 ${wave.status}，只有 planned 状态可以下发` }]);
  wave.status = 'running';
  wave.startedAt = new Date().toISOString();
  const first = wave.steps.find(step => step.status === 'pending');
  if (first) activateStep(wave, first);
  wave.revision += 1;
  recordWaveAudit('WAVE_START', id, `波次下发，首步任务 ${first?.taskId ?? '无'}`);
  return wave;
}

function activateStep(wave: WorkWave, step: WaveStep) {
  step.status = 'executing';
  step.startedAt = new Date().toISOString();
  const task = tasks.find(item => item.id === step.taskId);
  if (task) task.status = 'executing';
}

/** 现场完成一步：再次核对箱位实况与层级，应用物理效果，自动推进下一步 */
export function completeStep(id: string, taskId: string, revision?: number): WorkWave {
  const wave = requireWave(id);
  checkRevision(wave, revision);
  if (wave.status !== 'running') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `波次 ${id} 当前 ${wave.status}，请先恢复/下发后再回报完成` }]);
  const step = findStep(wave, taskId);
  if (step.status !== 'executing') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `任务 ${taskId} 当前 ${step.status}，只有执行中的步骤可以回报完成` }]);
  assertPrereqsDone(wave, step);

  const container = containers.find(item => item.id === step.containerId);
  if (!container) throw new WaveError([{ level: 'hard', code: 'CONTAINER_MISSING', message: `箱 ${step.containerId} 已不在台账，无法确认完工` }]);
  if (container.yardSlot !== step.from) throw new WaveError([{ level: 'hard', code: 'FROM_MISMATCH', message: `现场箱位冲突：${step.containerId} 实际在 ${container.yardSlot}，波次记录起点为 ${step.from}，请先处理现场偏差再回报` }]);
  const from = parseSlot(step.from);
  const fromBlock = from ? blockById(from.blockId) : undefined;
  if (from && fromBlock) for (let tier = from.tier + 1; tier <= fromBlock.tiers; tier++) {
    const above = `${from.blockId}-R${String(from.row).padStart(2, '0')}-T${tier}`;
    const occupant = containers.find(item => item.yardSlot === above && OCCUPYING_STATUSES.has(item.status));
    if (occupant) throw new WaveError([{ level: 'hard', code: 'ABOVE_NOT_CLEARED', message: `${above} 仍有箱 ${occupant.id}，${taskId} 无法提箱` }]);
  }
  const to = parseSlot(step.to);
  if (to) {
    const occupant = containers.find(item => item.yardSlot === step.to && OCCUPYING_STATUSES.has(item.status));
    if (occupant && occupant.id !== container.id) throw new WaveError([{ level: 'hard', code: 'DEST_OCCUPIED', message: `终点 ${step.to} 被箱 ${occupant.id} 占用，无法落箱` }]);
    if (to.tier > 1) {
      const below = `${to.blockId}-R${String(to.row).padStart(2, '0')}-T${to.tier - 1}`;
      if (!containers.some(item => item.yardSlot === below && OCCUPYING_STATUSES.has(item.status))) throw new WaveError([{ level: 'hard', code: 'FLOATING_DEST', message: `下层 ${below} 无箱，落箱会悬空` }]);
    }
  }

  step.status = 'done';
  step.completedAt = new Date().toISOString();
  const task = tasks.find(item => item.id === taskId);
  if (task) { task.status = 'done'; task.blockingReasons = []; }
  if (step.kind === 'rehandle' && to) { container.yardSlot = step.to; container.status = 'in-yard'; container.lastEvent = `波次 ${wave.id} 翻箱落位 ${step.to}`; }
  if (step.kind === 'deliver') { container.status = 'released'; container.yardSlot = step.to; container.lastEvent = `波次 ${wave.id} 提箱离场至 ${step.to}`; }
  if (step.kind === 'load') { container.status = 'on-quay'; container.yardSlot = step.to; container.lastEvent = `波次 ${wave.id} 装船就位 ${step.to}`; }

  const doneCount = wave.steps.filter(item => item.status === 'done').length;
  wave.lastCheckpoint = { at: step.completedAt, completedTaskId: taskId, stepsDone: doneCount, stepsTotal: wave.steps.length };
  const next = wave.steps.find(item => item.order === step.order + 1);
  if (next) wave.lastCheckpoint.nextTaskId = next.taskId;

  if (wave.steps.every(item => item.status === 'done')) {
    wave.status = 'completed';
    wave.finishedAt = new Date().toISOString();
    wave.resumeTaskId = undefined;
    recordWaveAudit('WAVE_COMPLETE', wave.id, `全部 ${wave.steps.length} 步完成`);
  } else {
    activateStep(wave, next!);
    recordWaveAudit('WAVE_STEP_DONE', wave.id, `${taskId} 完工，自动推进 ${next!.taskId}（${doneCount}/${wave.steps.length}）`);
  }
  wave.revision += 1;
  return wave;
}

/** 现场失败：本步标记 failed，波次进入 interrupted，后续步骤一律冻结，防止误放行 */
export function failStep(id: string, taskId: string, reason: string, revision?: number): WorkWave {
  const wave = requireWave(id);
  checkRevision(wave, revision);
  if (wave.status !== 'running') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `波次 ${id} 当前 ${wave.status}，不能回报失败` }]);
  const step = findStep(wave, taskId);
  if (step.status !== 'executing') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `任务 ${taskId} 当前 ${step.status}，不能回报失败` }]);
  if (!reason?.trim()) throw new WaveError([{ level: 'hard', code: 'TASK_ALREADY_BLOCKED', message: '失败回报必须填写现场原因' }]);
  step.status = 'failed';
  step.failureReason = reason;
  const task = tasks.find(item => item.id === taskId);
  if (task) { task.status = 'blocked'; task.blockingReasons = [reason, ...task.blockingReasons.filter(item => item !== reason)]; }
  wave.status = 'interrupted';
  wave.resumeTaskId = taskId;
  wave.revision += 1;
  recordWaveAudit('WAVE_STEP_FAIL', wave.id, `${taskId} 失败：${reason}；后续 ${wave.steps.filter(s => s.order > step.order).length} 步已冻结，等待断点恢复`);
  return wave;
}

/** 断点恢复：重新校验剩余任务的现场状态，通过后从失败步继续 */
export function retryStep(id: string, taskId: string, revision?: number): WorkWave {
  const wave = requireWave(id);
  checkRevision(wave, revision);
  if (wave.status !== 'interrupted') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `波次 ${id} 当前 ${wave.status}，只有中断波次可以恢复` }]);
  const step = findStep(wave, taskId);
  if (step.status !== 'failed') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `任务 ${taskId} 不是失败状态` }]);

  const remainingTasks = wave.steps.filter(s => s.status !== 'done').map(s => s.taskId);
  const recheck = buildPlan({ name: wave.name, equipmentId: wave.equipmentId, taskIds: remainingTasks, startAt: new Date().toISOString() }, wave.id);
  const blocking = recheck.issues.filter(issue => issue.level === 'hard');
  if (blocking.length) throw new WaveError([{ level: 'hard', code: 'FROM_MISMATCH', message: `现场状态已变化，断点恢复被拒绝：${blocking.map(b => b.message).join('；')}` }]);

  step.status = 'executing';
  step.failureReason = undefined;
  step.startedAt = new Date().toISOString();
  const task = tasks.find(item => item.id === taskId);
  if (task) task.status = 'executing';
  wave.status = 'running';
  wave.resumeTaskId = undefined;
  wave.issues = recheck.issues;
  wave.blockingPoints = recheck.blockingPoints;
  wave.revision += 1;
  recordWaveAudit('WAVE_RESUME', wave.id, `断点恢复：现场复核通过，从 ${taskId} 继续`);
  return wave;
}

/** 恢复入口信息，供前端渲染中断点与冻结的后续步骤；不改变状态 */
export function waveResumeInfo(id: string) {
  const wave = requireWave(id);
  if (wave.status !== 'interrupted') return undefined;
  const failed = wave.steps.find(s => s.status === 'failed');
  return {
    waveId: wave.id, revision: wave.revision, resumeTaskId: wave.resumeTaskId,
    failureReason: failed?.failureReason,
    checkpoint: wave.lastCheckpoint,
    blockedSuccessors: wave.steps.filter(s => s.status === 'pending').map(s => ({ taskId: s.taskId, containerId: s.containerId, from: s.from, to: s.to })),
  };
}

export function abortWave(id: string, revision?: number, reason?: string): WorkWave {
  const wave = requireWave(id);
  checkRevision(wave, revision);
  if (wave.status === 'completed' || wave.status === 'cancelled') throw new WaveError([{ level: 'hard', code: 'TASK_LOCKED', message: `波次 ${id} 已${wave.status === 'completed' ? '完成' : '取消'}，不能取消` }]);
  wave.status = 'cancelled';
  wave.finishedAt = new Date().toISOString();
  for (const step of wave.steps) {
    if (step.status !== 'done') step.status = 'pending';
    const task = tasks.find(item => item.id === step.taskId);
    if (task) { task.waveId = undefined; if (task.status === 'executing' || task.status === 'assigned') task.status = 'queued'; }
  }
  wave.revision += 1;
  recordWaveAudit('WAVE_CANCEL', wave.id, `波次取消${reason ? `：${reason}` : ''}，未完成任务解锁回队`);
  return wave;
}

// 注册任务锁：进行中/计划中波次内的任务禁止在任务台账中直接改派或删除
registerTaskLockChecker((taskId: string) => {
  const task = tasks.find(item => item.id === taskId);
  if (!task?.waveId) return undefined;
  const wave = getWave(task.waveId);
  if (wave && isActive(wave)) return `任务 ${taskId} 已被波次 ${wave.id}（${wave.status}）锁定，请在波次中操作或先取消波次`;
  return undefined;
});

// ── 种子波次 ─────────────────────────────────────────────────────────────────

export function seedWaves() {
  if (waves.length) return;
  // WAVE-01：YC-12 跨区连续作业（B07 清底层上方障碍 → 跨区 A01 提箱链）
  const w1 = createWave({
    name: 'YC-12 午前连续翻箱/提箱波次',
    equipmentId: 'YC-12',
    taskIds: ['TASK-106', 'TASK-102', 'TASK-101', 'TASK-105'],
    startAt: new Date(Date.now() + 8 * 60000).toISOString(),
  });
  renameWave(w1, 'WAVE-01');

  // WAVE-02：YC-05 已在现场执行一半，第二步因航次未靠泊失败 → 提供恢复入口
  const w2 = createWave({
    name: 'YC-05 出口装船准备波次',
    equipmentId: 'YC-05',
    taskIds: ['TASK-107', 'TASK-104'],
    startAt: new Date(Date.now() - 42 * 60000).toISOString(),
  });
  renameWave(w2, 'WAVE-02');
  w2.status = 'running';
  w2.startedAt = new Date(Date.now() - 42 * 60000).toISOString();
  const [s1, s2] = w2.steps;
  s1.status = 'done'; s1.startedAt = new Date(Date.now() - 42 * 60000).toISOString(); s1.completedAt = new Date(Date.now() - 28 * 60000).toISOString();
  s2.status = 'executing'; s2.startedAt = new Date(Date.now() - 26 * 60000).toISOString();
  const t107 = tasks.find(t => t.id === 'TASK-107')!; t107.status = 'done';
  const c107 = containers.find(c => c.id === 'TEMU-6012945')!; c107.yardSlot = 'C03-R09-T1'; c107.lastEvent = '波次 WAVE-02 翻箱落位 C03-R09-T1';
  failStep('WAVE-02', 'TASK-104', 'VOY-QF2 尚未靠泊，岸桥与泊位窗口未就绪');
  w2.lastCheckpoint = { at: s1.completedAt!, completedTaskId: 'TASK-107', nextTaskId: 'TASK-104', stepsDone: 1, stepsTotal: 2 };
}

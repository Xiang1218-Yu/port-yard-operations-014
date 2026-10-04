import test from 'node:test'; import assert from 'node:assert/strict';
import { containers, createYardTask, tasks } from './domain.js';
import { completeStep, createWave, failStep, getWave, listWaves, previewWave, retryStep, seedWaves, startWave, travelMinutes, WaveError, abortWave } from './waves.js';

seedWaves();

// 测试辅助：在独立堆位造箱 + 任务，避免与种子波次锁冲突
let fixtureSeq = 0;
function makeStackTask(kind: 'rehandle'|'deliver'|'load', opts: { from: string; to?: string; priority?: number; minutes?: number; containerOverrides?: Record<string, unknown> }) {
  fixtureSeq += 1;
  const id = `TESTW-C${String(fixtureSeq).padStart(2, '0')}`;
  containers.push({ id, voyageId: 'VOY-AX7', size: '20', isoType: '22G1', direction: 'import', status: 'in-yard', weightT: 10, reefer: false, customs: 'released', priority: 'normal', yardSlot: opts.from, lastEvent: '测试用堆箱' });
  const task = createYardTask({ kind, containerId: id, from: opts.from, to: opts.to ?? '北闸口', priority: opts.priority ?? 40, scheduledAt: new Date(Date.now() + 60_000).toISOString(), estimatedMinutes: opts.minutes ?? 10 });
  return { id, taskId: task.id };
}

test('seed waves: WAVE-01 orders same-row clearing before delivery and counts cross-zone travel', () => {
  const wave = getWave('WAVE-01')!;
  assert.equal(wave.status, 'planned');
  const order = wave.steps.map(s => s.taskId);
  // B07-R03：上层 T2 冷藏箱（TASK-102）必须先移走，底层 T1（TASK-106）才能动；
  // 跨区到 A01 后，R07 的 T3（TASK-101）必须先于 T2（TASK-105）提箱
  assert.deepEqual(order, ['TASK-102', 'TASK-106', 'TASK-101', 'TASK-105']);
  const t106 = wave.steps.find(s => s.taskId === 'TASK-106')!;
  assert.ok(t106.prerequisites.includes('TASK-102'));
  // T3 提箱必须排在 T2 提箱之前（层级前置）
  assert.ok(order.indexOf('TASK-101') < order.indexOf('TASK-105'));
  // B07→A01 跨区时间计入
  assert.ok(wave.travelMinutes >= 6, `travelMinutes=${wave.travelMinutes}`);
  assert.equal(wave.etaMinutes, wave.workMinutes + wave.travelMinutes + wave.idleMinutes);
  assert.ok(wave.blockingPoints.some(p => p.label === '设备跨区移动' && p.detail.includes('B07→A01')));
});

test('seed waves: WAVE-02 is interrupted with a resume entry and frozen successor', () => {
  const wave = getWave('WAVE-02')!;
  assert.equal(wave.status, 'interrupted');
  assert.equal(wave.resumeTaskId, 'TASK-104');
  assert.equal(wave.steps.find(s => s.taskId === 'TASK-107')?.status, 'done');
  assert.equal(wave.steps.find(s => s.taskId === 'TASK-104')?.status, 'failed');
  assert.equal(wave.lastCheckpoint?.stepsDone, 1);
});

test('travel minutes: same block, cross zone and external node', () => {
  assert.equal(travelMinutes('B07-R03', 'B07-R11-T1').minutes, 2);
  assert.equal(travelMinutes('B07-R03', 'A01-R01-T1').minutes, 6);
  assert.equal(travelMinutes('B07-R03', 'D05-R01-T1').minutes, 10);
  assert.equal(travelMinutes('A01-R01', 'D05-R01-T1').minutes, 14);
  assert.equal(travelMinutes('南闸口', 'A01-R01-T1').minutes, 8);
});

test('rejects wave containing same container twice', () => {
  const { id, taskId } = makeStackTask('deliver', { from: 'A01-R12-T1' });
  const other = createYardTask({ kind: 'deliver', containerId: id, from: 'A01-R12-T1', to: '南闸口', priority: 30, scheduledAt: new Date().toISOString(), estimatedMinutes: 9 });
  assert.throws(() => createWave({ equipmentId: 'YC-09', taskIds: [taskId, other.id] }), (error: unknown) => {
    const waveError = error as WaveError;
    return waveError instanceof WaveError && waveError.issues.some(i => i.code === 'DUPLICATE_CONTAINER');
  });
});

test('rejects box blocked from above when clearing task is not in wave', () => {
  const { taskId } = makeStackTask('deliver', { from: 'A01-R11-T2' });
  // 在 T3 放一个不在波次中的阻挡箱
  containers.push({ id: 'TESTW-BLOCK-99', voyageId: 'VOY-AX7', size: '20', isoType: '22G1', direction: 'import', status: 'in-yard', weightT: 10, reefer: false, customs: 'released', priority: 'normal', yardSlot: 'A01-R11-T3', lastEvent: '阻挡箱' });
  assert.throws(() => createWave({ equipmentId: 'YC-09', taskIds: [taskId] }), (error: unknown) =>
    (error as WaveError).issues.some(i => i.code === 'ABOVE_NOT_CLEARED'));
});

test('auto-includes prerequisite: upper tier container must move first within wave', () => {
  const lower = makeStackTask('deliver', { from: 'C03-R11-T1' });
  const upper = makeStackTask('deliver', { from: 'C03-R11-T2' });
  // 无论传入顺序如何，T2 的任务必须排到 T1 之前
  const wave = createWave({ equipmentId: 'YC-09', taskIds: [lower.taskId, upper.taskId], startAt: new Date().toISOString() });
  assert.ok(wave.steps.findIndex(s => s.taskId === upper.taskId) < wave.steps.findIndex(s => s.taskId === lower.taskId));
  assert.ok(wave.steps.find(s => s.taskId === lower.taskId)!.prerequisites.includes(upper.taskId));
  assert.ok(wave.blockingPoints.some(p => p.taskId === lower.taskId && p.label === '前置作业'));
  abortWave(wave.id, wave.revision);
});

test('rejects non-yard-crane equipment and customs-held containers', () => {
  const { taskId } = makeStackTask('rehandle', { from: 'C03-R12-T1', to: 'C03-R10-T1' });
  assert.throws(() => createWave({ equipmentId: 'TT-31', taskIds: [taskId] }), (error: unknown) =>
    (error as WaveError).issues.some(i => i.code === 'EQUIPMENT_NOT_CRANE'));
  const held = containers.find(c => c.id === 'TGHU-9831204')!;
  const heldTask = createYardTask({ kind: 'deliver', containerId: held.id, from: 'D05-R02-T1', to: '北闸口', priority: 50, scheduledAt: new Date().toISOString(), estimatedMinutes: 10 });
  assert.throws(() => createWave({ equipmentId: 'YC-09', taskIds: [heldTask.id] }), (error: unknown) =>
    (error as WaveError).issues.some(i => i.code === 'CUSTOMS_HOLD'));
});

test('floating destination (tier 2 without tier 1 occupied) is rejected', () => {
  const { taskId } = makeStackTask('rehandle', { from: 'C03-R12-T1', to: 'C03-R10-T2' });
  assert.throws(() => createWave({ equipmentId: 'YC-09', taskIds: [taskId] }), (error: unknown) =>
    (error as WaveError).issues.some(i => i.code === 'FLOATING_DEST'));
});

test('failure freezes successors; resume revalidates yard state and continues', () => {
  const t1 = makeStackTask('rehandle', { from: 'C03-R07-T1', to: 'C03-R08-T1' });
  const t2 = makeStackTask('deliver', { from: 'A01-R10-T1' });
  const wave = startWave(createWave({ equipmentId: 'YC-09', taskIds: [t1.taskId, t2.taskId], startAt: new Date().toISOString() }).id);
  const executing = wave.steps.find(s => s.status === 'executing')!;
  failStep(wave.id, executing.taskId, '吊具故障，现场暂停');
  let fresh = getWave(wave.id)!;
  assert.equal(fresh.status, 'interrupted');
  assert.equal(fresh.resumeTaskId, executing.taskId);
  // 失败后不允许完成后续步骤
  const pending = fresh.steps.find(s => s.status === 'pending')!;
  assert.throws(() => completeStep(wave.id, pending.taskId, fresh.revision), /interrupted|不能放行|pending/);

  // 恢复前如果箱子被移动，resume 必须拒绝（防止状态倒退）
  const moved = containers.find(c => c.id === executing.containerId)!;
  moved.yardSlot = 'A01-R09-T3';
  assert.throws(() => retryStep(wave.id, executing.taskId, fresh.revision), /断点恢复被拒绝/);
  // 现场纠正回起点后恢复成功
  moved.yardSlot = executing.from;
  fresh = getWave(wave.id)!;
  const resumed = retryStep(wave.id, executing.taskId, fresh.revision);
  assert.equal(resumed.status, 'running');
  // 完成两步，波次关闭
  completeStep(wave.id, executing.taskId, resumed.revision);
  fresh = getWave(wave.id)!;
  completeStep(wave.id, fresh.steps.find(s => s.status === 'executing')!.taskId, fresh.revision);
  assert.equal(getWave(wave.id)!.status, 'completed');
});

test('stale revision is rejected so reload cannot overwrite newer现场 state', () => {
  const { taskId } = makeStackTask('deliver', { from: 'A01-R13-T1' });
  const wave = createWave({ equipmentId: 'YC-09', taskIds: [taskId], startAt: new Date().toISOString() });
  startWave(wave.id, wave.revision);
  // 用旧 revision 回报完工必须被拒绝，防止刷新前页面覆盖现场状态
  const fresh = getWave(wave.id)!;
  assert.throws(() => completeStep(wave.id, taskId, fresh.revision - 1), /revision/);
  abortWave(wave.id, fresh.revision);
});

test('tasks locked by active wave cannot be reassigned or deleted from the task board', async () => {
  const { updateYardTask, deleteYardTask } = await import('./domain.js');
  const locked = tasks.find(t => t.id === 'TASK-101')!;
  assert.equal(locked.waveId, 'WAVE-01');
  assert.throws(() => updateYardTask(locked.id, { priority: 1 }), /锁定/);
  assert.throws(() => deleteYardTask(locked.id), /锁定/);
});

test('abort releases task locks and returns tasks to queue', () => {
  const { taskId } = makeStackTask('deliver', { from: 'A01-R14-T1' });
  const wave = createWave({ equipmentId: 'YC-09', taskIds: [taskId], startAt: new Date().toISOString() });
  abortWave(wave.id, wave.revision, '计划调整');
  assert.equal(getWave(wave.id)?.status, 'cancelled');
  assert.equal(tasks.find(t => t.id === taskId)?.waveId, undefined);
});

test('preview returns ETA and blocking points without persisting a wave', () => {
  const before = listWaves().length;
  const preview = previewWave({ equipmentId: 'YC-09', taskIds: [] });
  assert.ok(preview.issues.some(i => i.level === 'hard'));
  assert.equal(listWaves().length, before);
});

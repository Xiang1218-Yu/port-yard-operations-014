import test from 'node:test';
import assert from 'node:assert/strict';
import { containers, createContainer, createYardTask, deleteContainer, equipment, tasks, updateContainer } from './domain.js';
import { completeStep, createWave, deleteWave, failStep, listWaves, pauseWave, planWave, retryStep, startWave } from './waves.js';

const iso = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();

function makeContainer(id: string, slot: string) {
  return createContainer({ id, voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'import', status: 'in-yard', weightT: 20, reefer: false, customs: 'released', priority: 'normal', yardSlot: slot });
}
function cleanupWave(id: string) { try { deleteWave(id); } catch { /* 已删除或终态前先尝试完成态不影响断言 */ } }

test('wave planner seeds an in-flight wave and a paused wave awaiting resume', () => {
  const all = listWaves();
  assert.ok(all.length >= 2, '应生成至少两个种子波次');
  assert.ok(all.some(w => w.status === 'paused'), 'YC-05 波次应停在中断点等待恢复');
});

test('wave plan forces same-row tier order before picking a lower container', () => {
  makeContainer('WTEST-BOX-TOP', 'A01-R11-T3');
  makeContainer('WTEST-BOX-LOW', 'A01-R11-T2');
  const top = createYardTask({ kind: 'rehandle', containerId: 'WTEST-BOX-TOP', from: 'A01-R11-T3', to: 'C03-R10-T1', priority: 50, scheduledAt: iso(200), estimatedMinutes: 15 });
  const low = createYardTask({ kind: 'deliver', containerId: 'WTEST-BOX-LOW', from: 'A01-R11-T2', to: '南闸口', priority: 95, scheduledAt: iso(201), estimatedMinutes: 15 });
  const plan = planWave({ equipmentId: 'YC-19', taskIds: [low.id, top.id] });
  assert.equal(plan.feasible, true);
  // 低层 deliver 优先级更高，但拓扑+模拟必须把高层翻箱排到第一位
  assert.equal(plan.steps[0].taskId, top.id);
  assert.equal(plan.steps[1].taskId, low.id);
  assert.ok(plan.steps[1].prerequisites.includes(top.id));
  assert.ok(plan.blockingPoints.some(p => p.code === 'tier-order'));
  deleteContainer('WTEST-BOX-TOP'); deleteContainer('WTEST-BOX-LOW');
});

test('wave submit rejects the same container appearing twice', () => {
  makeContainer('WTEST-DUP-BOX', 'C03-R11-T1');
  const t1 = createYardTask({ kind: 'rehandle', containerId: 'WTEST-DUP-BOX', from: 'C03-R11-T1', to: 'A01-R10-T1', priority: 40, scheduledAt: iso(210), estimatedMinutes: 12 });
  const t2 = createYardTask({ kind: 'deliver', containerId: 'WTEST-DUP-BOX', from: 'A01-R10-T1', to: '南闸口', priority: 41, scheduledAt: iso(220), estimatedMinutes: 12 });
  const plan = planWave({ equipmentId: 'YC-19', taskIds: [t1.id, t2.id] });
  assert.equal(plan.feasible, false);
  assert.ok(plan.blockingPoints.some(p => p.code === 'duplicate-container'));
  assert.throws(() => createWave({ equipmentId: 'YC-19', taskIds: [t1.id, t2.id] }), /重复/);
  deleteContainer('WTEST-DUP-BOX');
});

test('cross-zone equipment travel is counted in wave duration and surfaced as blocking point', () => {
  makeContainer('WTEST-TRAVEL-BOX', 'A01-R12-T1');
  const t = createYardTask({ kind: 'rehandle', containerId: 'WTEST-TRAVEL-BOX', from: 'A01-R12-T1', to: 'C03-R11-T1', priority: 40, scheduledAt: iso(230), estimatedMinutes: 15 });
  const plan = planWave({ equipmentId: 'YC-19', taskIds: [t.id] });
  assert.equal(plan.feasible, true);
  // YC-19 初始锚点 A01-R02：到起点同区跨排 4 分钟；A01 → C03 跨区落箱 8 分钟
  assert.equal(plan.steps[0].travelMinutes, 12);
  assert.equal(plan.estimatedMinutes, 15 + 12);
  assert.ok(plan.blockingPoints.some(p => p.code === 'cross-zone-travel'));
  deleteContainer('WTEST-TRAVEL-BOX');
});

test('one failed step freezes every later step and completing out of order is rejected', () => {
  makeContainer('WTEST-FAIL-1', 'A01-R13-T1');
  makeContainer('WTEST-FAIL-2', 'A01-R14-T1');
  const t1 = createYardTask({ kind: 'rehandle', containerId: 'WTEST-FAIL-1', from: 'A01-R13-T1', to: 'C03-R11-T1', priority: 50, scheduledAt: iso(240), estimatedMinutes: 10 });
  const t2 = createYardTask({ kind: 'rehandle', containerId: 'WTEST-FAIL-2', from: 'A01-R14-T1', to: 'C03-R12-T1', priority: 49, scheduledAt: iso(241), estimatedMinutes: 10 });
  const wave = createWave({ equipmentId: 'YC-19', taskIds: [t1.id, t2.id], name: 'WTEST 失败冻结波次' });
  startWave(wave.id);
  assert.throws(() => completeStep(wave.id, t2.id), /不能越过中断点/);
  failStep(wave.id, t1.id, '吊具闭锁故障');
  const reloaded = listWaves().find(w => w.id === wave.id)!;
  assert.equal(reloaded.status, 'failed');
  assert.ok(reloaded.steps[1].blockingPoints.some(p => p.code === 'failed-predecessor'));
  assert.throws(() => completeStep(wave.id, t2.id), /失败未处置/);
  // 故障排除后重试，波次单调解冻，第二步随后可以完成
  retryStep(wave.id, t1.id);
  completeStep(wave.id, t1.id);
  completeStep(wave.id, t2.id);
  assert.equal(listWaves().find(w => w.id === wave.id)!.status, 'completed');
  deleteWave(wave.id);
  deleteContainer('WTEST-FAIL-1'); deleteContainer('WTEST-FAIL-2');
});

test('wave state machine refuses to roll status backwards after reload', () => {
  makeContainer('WTEST-STATE-BOX', 'A01-R01-T1');
  const t = createYardTask({ kind: 'rehandle', containerId: 'WTEST-STATE-BOX', from: 'A01-R01-T1', to: 'C03-R11-T1', priority: 40, scheduledAt: iso(260), estimatedMinutes: 10 });
  const wave = createWave({ equipmentId: 'YC-19', taskIds: [t.id] });
  startWave(wave.id);
  // 已在执行中的波次重复 start 不允许倒退/重复放行
  assert.throws(() => startWave(wave.id), /状态/);
  completeStep(wave.id, t.id);
  assert.equal(listWaves().find(w => w.id === wave.id)!.status, 'completed');
  assert.throws(() => pauseWave(wave.id), /completed/);
  deleteWave(wave.id);
  deleteContainer('WTEST-STATE-BOX');
});

test('equipment with an active wave cannot accept another wave', () => {
  makeContainer('WTEST-LOCK-BOX', 'A01-R03-T1');
  const t = createYardTask({ kind: 'deliver', containerId: 'WTEST-LOCK-BOX', from: 'A01-R03-T1', to: '南闸口', priority: 40, scheduledAt: iso(270), estimatedMinutes: 12 });
  const plan = planWave({ equipmentId: 'YC-12', taskIds: [t.id] });
  assert.equal(plan.feasible, false);
  assert.ok(plan.blockingPoints.some(p => p.code === 'equipment-state' && p.message.includes('YC-12')));
  deleteContainer('WTEST-LOCK-BOX');
});

test('resume revalidates the live stack and blocks when a container is customs-held', () => {
  makeContainer('WTEST-RESUME-LOW', 'C03-R08-T1');
  const t = createYardTask({ kind: 'deliver', containerId: 'WTEST-RESUME-LOW', from: 'C03-R08-T1', to: '南闸口', priority: 40, scheduledAt: iso(280), estimatedMinutes: 12 });
  const wave = createWave({ equipmentId: 'YC-19', taskIds: [t.id] });
  startWave(wave.id);
  pauseWave(wave.id, '测试中断');
  const box = containers.find(c => c.id === 'WTEST-RESUME-LOW')!;
  box.customs = 'hold';
  assert.throws(() => startWave(wave.id), /海关|拒绝/);
  // 解除现场异常后可从中断点继续
  box.customs = 'released';
  startWave(wave.id);
  completeStep(wave.id, t.id);
  assert.equal(listWaves().find(w => w.id === wave.id)!.status, 'completed');
  deleteWave(wave.id);
  deleteContainer('WTEST-RESUME-LOW');
});

test('wave binding keeps task/equipment locking consistent across the lifecycle', () => {
  assert.ok(tasks.some(t => t.id === 'TASK-105' && ['executing', 'assigned'].includes(t.status)));
  assert.ok(equipment.some(e => e.id === 'YC-05'));
  const paused = listWaves().find(w => w.status === 'paused');
  assert.ok(paused, '种子 YC-05 波次应可作为恢复入口');
  assert.equal(paused!.steps[0].status, 'done');
  assert.equal(paused!.steps[1].status, 'pending');
  // 恢复入口：恢复时以现场实况重算剩余路线
  const resumed = startWave(paused!.id);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.interruptedAtSequence, 2);
  completeStep(resumed.id, 'TASK-104');
  assert.equal(listWaves().find(w => w.id === resumed.id)!.status, 'completed');
  assert.equal(tasks.find(t => t.id === 'TASK-104')?.status, 'done');
  deleteWave(resumed.id);
  cleanupWave; void updateContainer;
});

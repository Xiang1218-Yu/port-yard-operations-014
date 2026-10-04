import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Dashboard = { activeVoyages: number; berthMoves: number; yardUtilization: number; gateQueue: number; pendingTasks: number; blockedTasks: number; reeferAlerts: number; hazmatHolds: number; lateVessels: number };
type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; size: '20'|'40'|'45'; isoType: string; direction: 'import'|'export'|'transshipment'; status: string; weightT: number; reefer: boolean; temperature?: number; hazmatClass?: string; customs: 'released'|'inspection'|'hold'; priority: string; yardSlot: string; appointmentId?: string; lastEvent: string };
type Block = { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; heat: number; utilization: number; freeSlots: number; pressure: string };
type Conflict = { severity: string; appointmentId: string; reason: string };
type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: 'north'|'south'|'rail'; status: string; exception?: string };
type Task = { id: string; kind: string; containerId: string; from: string; to: string; equipmentId?: string; priority: number; score: number; status: string; blockingReasons: string[]; estimatedMinutes: number; scheduledAt: string };
type Equipment = { id: string; name: string; kind: string; status: string; location: string; battery: number; queue: number; movesPerHour: number };
type BlockingPoint = { code: string; severity: 'error'|'warning'|'info'; at: string; taskId?: string; blockerTaskId?: string; message: string; resolution: string };
type WaveStep = { sequence: number; taskId: string; containerId: string; kind: string; from: string; to: string; estimatedMinutes: number; travelMinutes: number; travelLabel: string; prerequisites: string[]; status: 'pending'|'running'|'done'|'failed'|'skipped'; note?: string; blockingPoints: BlockingPoint[] };
type JobWave = { id: string; name: string; equipmentId: string; status: 'validated'|'running'|'paused'|'completed'|'failed'; version: number; createdAt: string; updatedAt: string; taskIds: string[]; steps: WaveStep[]; blockingPoints: BlockingPoint[]; estimatedMinutes: number; remainingMinutes: number; elapsedMinutes: number; failureReason?: string; interruptedAtSequence?: number };
type WavePlan = { equipmentId: string; taskIds: string[]; feasible: boolean; blockingPoints: BlockingPoint[]; steps: WaveStep[]; estimatedMinutes: number };
type Section = 'control'|'containers'|'gate'|'yard'|'tasks'|'waves';
type Editor = { entity: 'container'|'appointment'|'task'; mode: 'create'|'edit'; id?: string; values: Record<string, string|boolean> };

const api = '/api';
const pct = (value: number) => `${Math.round(value * 100)}%`;
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (value?: string) => {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const defaultValues = (entity: Editor['entity']): Record<string, string|boolean> => {
  if (entity === 'container') return { id: '', voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'import', status: 'in-yard', weightT: '20', reefer: false, temperature: '4', hazmatClass: '', customs: 'released', priority: 'normal', yardSlot: 'C03-R01-T1' };
  if (entity === 'appointment') return { containerId: '', truckNo: '', driver: '', type: 'pickup', windowStart: toLocalInput(), windowEnd: toLocalInput(new Date(Date.now() + 60 * 60000).toISOString()), lane: 'north' };
  return { kind: 'receive', containerId: '', from: '闸口', to: 'C03-R01-T1', equipmentId: '', priority: '50', scheduledAt: toLocalInput(), estimatedMinutes: '20', status: 'queued' };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [voyages, setVoyages] = useState<Voyage[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [waves, setWaves] = useState<JobWave[]>([]);
  const [tab, setTab] = useState<Section>('control');
  const [selectedVoyage, setSelectedVoyage] = useState('VOY-AX7');
  const [editor, setEditor] = useState<Editor>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, v, ctn, b, cf, a, t, e, w] = await Promise.all([
      request<Dashboard>('/dashboard'), request<Voyage[]>('/voyages'), request<Container[]>('/containers'),
      request<Block[]>('/yard/heatmap'), request<Conflict[]>('/gate/conflicts'), request<Appointment[]>('/gate/appointments'),
      request<Task[]>('/tasks'), request<Equipment[]>('/equipment'), request<JobWave[]>('/waves')
    ]);
    setDashboard(d); setVoyages(v); setContainers(ctn); setBlocks(b); setConflicts(cf); setAppointments(a); setTasks(t); setEquipment(e); setWaves(w);
  }, []);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }, [load]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await load(); setEditor(undefined); setMessage('操作已保存，作业台数据已刷新');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openCreate = (entity: Editor['entity']) => { setError(''); setEditor({ entity, mode: 'create', values: defaultValues(entity) }); };
  const openEdit = (entity: Editor['entity'], id: string, values: Record<string, string|boolean>) => { setError(''); setEditor({ entity, mode: 'edit', id, values: { ...values } }); };
  const updateField = (key: string, value: string|boolean) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current);
  const saveEditor = async (event: FormEvent) => {
    event.preventDefault(); if (!editor) return;
    const { entity, mode, id, values } = editor;
    const payload: Record<string, unknown> = entity === 'container' ? {
      ...(mode === 'create' ? { id: values.id } : {}), voyageId: values.voyageId, size: values.size, isoType: values.isoType,
      direction: values.direction, status: values.status, weightT: Number(values.weightT), reefer: Boolean(values.reefer),
      ...(values.reefer ? { temperature: Number(values.temperature) } : {}), ...(values.hazmatClass ? { hazmatClass: values.hazmatClass } : {}),
      customs: values.customs, priority: values.priority, yardSlot: values.yardSlot
    } : entity === 'appointment' ? {
      containerId: values.containerId, truckNo: values.truckNo, driver: values.driver, type: values.type,
      windowStart: new Date(String(values.windowStart)).toISOString(), windowEnd: new Date(String(values.windowEnd)).toISOString(), lane: values.lane
    } : {
      kind: values.kind, containerId: values.containerId, from: values.from, to: values.to, priority: Number(values.priority),
      scheduledAt: new Date(String(values.scheduledAt)).toISOString(), estimatedMinutes: Number(values.estimatedMinutes),
      ...(values.equipmentId ? { equipmentId: values.equipmentId } : {}), ...(mode === 'edit' ? { status: values.status } : {})
    };
    await mutate(entity === 'container' ? `/containers${mode === 'edit' ? `/${id}` : ''}` : entity === 'appointment' ? `/gate/appointments${mode === 'edit' ? `/${id}` : ''}` : `/tasks${mode === 'edit' ? `/${id}` : ''}`, mode === 'create' ? 'POST' : 'PATCH', payload);
  };
  const remove = async (entity: Editor['entity'], id: string) => {
    if (!window.confirm(`确认删除 ${id}？相关数据的联动处理会写入审计记录。`)) return;
    const path = entity === 'container' ? `/containers/${id}` : entity === 'appointment' ? `/gate/appointments/${id}` : `/tasks/${id}`;
    await mutate(path, 'DELETE');
  };
  const updateAppointmentStatus = async (id: string, status: string) => mutate(`/gate/appointments/${id}`, 'PATCH', { status });
  const assign = async (id: string, equipmentId: string) => equipmentId ? mutate(`/tasks/${id}/assign`, 'PATCH', { equipmentId }) : mutate(`/tasks/${id}`, 'PATCH', { equipmentId: '', status: 'queued' });
  const [composerEquipment, setComposerEquipment] = useState('YC-12');
  const [composerTasks, setComposerTasks] = useState<string[]>([]);
  const [wavePlan, setWavePlan] = useState<WavePlan>();
  const [planLoading, setPlanLoading] = useState(false);
  const toggleComposerTask = (id: string) => { setWavePlan(undefined); setComposerTasks(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); };
  const runPlan = async () => {
    if (!composerEquipment || composerTasks.length === 0) { setError('请先选择场桥并至少勾选一个 rehandle / deliver / load 任务'); return; }
    setPlanLoading(true); setError('');
    try { setWavePlan(await request<WavePlan>('/waves/plan', { method: 'POST', body: JSON.stringify({ equipmentId: composerEquipment, taskIds: composerTasks }) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '路线校验失败'); }
    finally { setPlanLoading(false); }
  };
  const submitWave = async () => {
    setBusy(true); setError('');
    try {
      await request('/waves', { method: 'POST', body: JSON.stringify({ equipmentId: composerEquipment, taskIds: composerTasks }) });
      setComposerTasks([]); setWavePlan(undefined);
      await load(); setMessage('波次已提交：任务已锁定到场桥，可在波次卡片中启动');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '波次提交失败'); }
    finally { setBusy(false); }
  };
  const waveAction = async (wave: JobWave, action: string, taskId?: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      const path = taskId ? `/waves/${wave.id}/steps/${taskId}/${action}` : `/waves/${wave.id}/${action}`;
      await request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      await load(); setMessage(action === 'pause' ? '波次已在当前步骤中断，后续可从恢复入口继续' : action === 'fail' ? '步骤已标记失败，后续任务已冻结' : '波次状态已更新');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '波次操作失败'); }
    finally { setBusy(false); }
  };
  const removeWave = async (wave: JobWave) => {
    if (!window.confirm(`确认删除波次 ${wave.id}？仅已校验/已完成/失败的波次可删除。`)) return;
    await mutate(`/waves/${wave.id}`, 'DELETE');
  };
  const eligibleTasks = useMemo(() => {
    const inActiveWave = new Set(waves.filter(w => ['validated', 'running', 'paused'].includes(w.status)).flatMap(w => w.taskIds));
    return tasks.filter(t => ['rehandle', 'deliver', 'load'].includes(t.kind) && !inActiveWave.has(t.id) && t.status !== 'done');
  }, [tasks, waves]);
  const composerDuplicates = useMemo(() => {
    const seen = new Map<string, string>(); const dups = new Set<string>();
    for (const id of composerTasks) { const cid = tasks.find(t => t.id === id)?.containerId; if (!cid) continue; const prev = seen.get(cid); if (prev) dups.add(prev); seen.set(cid, id); }
    return dups;
  }, [composerTasks, tasks]);
  const statusLabel: Record<string, string> = { validated: '已校验', running: '执行中', paused: '已中断', completed: '已完成', failed: '失败冻结', pending: '待执行', done: '已完成', skipped: '已跳过' };
  const statusClass = (s: string) => ({ validated: 'queued', running: 'checked-in', paused: 'booked', completed: 'done', failed: 'blocked', pending: 'queued', done: 'done', skipped: 'completed' })[s] ?? s;
  const severityClass = (s: string) => s === 'error' ? 'bp-error' : s === 'warning' ? 'bp-warning' : 'bp-info';
  const waveEquipment = (id: string) => equipment.find(item => item.id === id);
  const selected = voyages.find(voyage => voyage.id === selectedVoyage);
  const remaining = selected ? selected.movesPlanned - selected.movesDone : 0;
  const maxHeat = useMemo(() => Math.max(...blocks.map(block => block.heat), 1), [blocks]);

  if (!dashboard && error) return <main className="connection-error"><div className="eyebrow">API CONNECTION ERROR</div><h1>无法连接港口作业服务</h1><p>{error}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5178 和 API 4107 均已启动。</p><button onClick={() => { setError(''); void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }}>重新连接</button></main>;
  if (!dashboard) return <div className="loading">正在连接码头实时作业中台…</div>;

  return <main>
    <header><div><div className="eyebrow">PORT OPS / YARD & GATE CONTROL</div><h1>HarborGrid <span>港口集装箱堆场协同与闸口调度</span></h1><p>把船期、箱务、堆场容量、危险品/冷藏约束、闸口预约与场内设备任务放在同一条作业链路上。</p></div><div className="header-right"><span className="live"><i/> TOS LINKED</span><span className="clock">LIVE · {new Date().toLocaleTimeString()}</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <section className="kpis"><div><small>ACTIVE VESSELS</small><b>{dashboard.activeVoyages}<em> 艘</em></b><span>{dashboard.lateVessels} 艘存在延误风险</span></div><div><small>YARD UTILIZATION</small><b>{pct(dashboard.yardUtilization)}</b><span>可用堆位 / 危险品隔离纳管</span></div><div><small>GATE QUEUE</small><b>{dashboard.gateQueue}<em> 车</em></b><span>预约、已进场与车道排队</span></div><div><small>EXCEPTIONS</small><b>{dashboard.blockedTasks + dashboard.reeferAlerts + dashboard.hazmatHolds}<em> 项</em></b><span>{dashboard.blockedTasks} 作业阻塞 · {dashboard.reeferAlerts} 冷藏告警</span></div></section>
    <nav className="tabs"><button className={tab==='control'?'active':''} onClick={() => setTab('control')}>作业驾驶舱</button><button className={tab==='containers'?'active':''} onClick={() => setTab('containers')}>箱务台账 / CRUD</button><button className={tab==='gate'?'active':''} onClick={() => setTab('gate')}>闸口预约</button><button className={tab==='yard'?'active':''} onClick={() => setTab('yard')}>堆场热区</button><button className={tab==='tasks'?'active':''} onClick={() => setTab('tasks')}>设备任务</button><button className={tab==='waves'?'active':''} onClick={() => setTab('waves')}>场桥波次{waves.filter(w=>w.status==='paused').length>0&&<em className="tab-badge">{waves.filter(w=>w.status==='paused').length}</em>}</button><span>最后同步 {new Date().toLocaleTimeString()}</span></nav>
    {tab === 'control' && <div className="layout"><section className="panel vessel-panel"><div className="panel-head"><div><div className="eyebrow">VESSEL WINDOW / 船期窗口</div><h2>泊位作业进度</h2></div><span className="muted">剩余作业动态计算</span></div>{voyages.map(voyage => <button key={voyage.id} className={`vessel ${selectedVoyage===voyage.id?'selected':''}`} onClick={() => setSelectedVoyage(voyage.id)}><span className={`vessel-dot ${voyage.status}`}/><span className="vessel-main"><b>{voyage.vessel}</b><small>{voyage.id} · {voyage.service} · {voyage.berth}</small><i><em style={{ width: `${Math.min(100, voyage.movesDone / voyage.movesPlanned * 100)}%` }}/></i></span><span className="vessel-move"><b>{voyage.movesDone.toLocaleString()}</b><small>/ {voyage.movesPlanned.toLocaleString()} moves</small></span><strong className={voyage.lateRisk}>{voyage.lateRisk==='high'?'HIGH':voyage.lateRisk==='medium'?'WATCH':'ON TIME'}</strong></button>)}</section><section className="panel focus-panel"><div className="panel-head"><div><div className="eyebrow">SELECTED VOYAGE / {selected?.id}</div><h2>{selected?.vessel}</h2></div><span className={`badge ${selected?.lateRisk}`}>{selected?.status}</span></div><div className="voyage-stats"><div><small>ETA</small><b>{selected&&time(selected.eta)}</b><span>预计靠泊</span></div><div><small>ETD</small><b>{selected&&time(selected.etd)}</b><span>计划离港</span></div><div><small>REMAINING</small><b>{remaining}</b><span>剩余翻箱</span></div></div><div className="berth-map"><div className="water"><span>岸线 / BERTH</span><i className="ship" style={{ left: `${selected?.berth==='B07'?50:24}%` }}>{selected?.vessel}</i><b>B01</b><b>B04</b><b>B07</b><b>B10</b></div></div><div className="callout"><strong>调度策略</strong><span>已把 {dashboard.blockedTasks} 个阻塞任务、{dashboard.gateQueue} 车闸口压力纳入当前窗口；优先保护冷藏与危险品安全约束。</span></div></section><section className="panel wide"><div className="panel-head"><h3>异常与联动信号</h3><span>{conflicts.length} gate conflicts detected</span></div><div className="signal-grid"><div><strong className="critical">{dashboard.blockedTasks}</strong><span>设备/约束阻塞</span><small>最高优先级：海关查验任务</small></div><div><strong className="warning">{conflicts.length}</strong><span>闸口预约冲突</span><small>同车重叠窗口需人工重排</small></div><div><strong className="warning">{dashboard.reeferAlerts}</strong><span>冷藏与温控风险</span><small>查验区电源余量接近阈值</small></div><div><strong className="ok">{equipment.filter(item => item.status==='available').length}</strong><span>可调度设备</span><small>场桥 / 正面吊 / 集卡</small></div></div></section></div>}
    {tab === 'containers' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">CONTAINER REGISTER / CRUD</div><h2>箱务台账</h2><span className="muted">新增、查询、编辑、删除；危险品与冷藏箱受堆场约束校验</span></div><button className="primary-action" onClick={() => openCreate('container')}>＋ 新增箱务</button></div><div className="table container-table"><div className="tr th"><span>箱号 / 航次</span><span>尺寸 / 流向</span><span>箱况 / 海关</span><span>堆位</span><span>重量 / 属性</span><span>操作</span></div>{containers.map(container => <div className="tr" key={container.id}><span><b>{container.id}</b><small>{container.voyageId} · {container.lastEvent}</small></span><span>{container.size}ft · {container.direction}<small>{container.isoType}</small></span><span><b>{container.status}</b><small>海关：{container.customs}</small></span><span>{container.yardSlot}</span><span>{container.weightT}t<small>{container.reefer?`冷藏 ${container.temperature}°C`:container.hazmatClass?`危险品 ${container.hazmatClass} 类`:'普通箱'}</small></span><span className="row-actions"><button onClick={() => openEdit('container', container.id, { ...container, weightT: String(container.weightT), temperature: String(container.temperature ?? 4), hazmatClass: container.hazmatClass ?? '' })}>编辑</button><button className="danger-action" onClick={() => void remove('container', container.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'gate' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">GATE APPOINTMENT / SLOT CONTROL</div><h2>闸口预约与车道状态</h2><span className="muted">支持新增预约、编辑时隙、签到/完成和删除</span></div><button className="primary-action" onClick={() => openCreate('appointment')}>＋ 新增预约</button></div>{conflicts.map(conflict => <div className="conflict" key={`${conflict.appointmentId}-${conflict.reason}`}><strong>{conflict.severity}</strong><b>{conflict.appointmentId}</b><span>{conflict.reason}</span></div>)}<div className="table"><div className="tr th"><span>预约</span><span>箱号 / 车辆</span><span>窗口</span><span>车道</span><span>状态</span><span>操作</span></div>{appointments.map(appointment => <div className="tr" key={appointment.id}><span><b>{appointment.id}</b><small>{appointment.type}</small></span><span><b>{appointment.containerId}</b><small>{appointment.truckNo} · {appointment.driver}</small></span><span>{time(appointment.windowStart)}—{time(appointment.windowEnd)}</span><span>{appointment.lane}</span><span className={`pill ${appointment.status}`}>{appointment.status}</span><span className="row-actions">{appointment.status==='booked'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'checked-in')}>签到</button>:appointment.status==='checked-in'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'completed')}>完成</button>:null}<button onClick={() => openEdit('appointment', appointment.id, { ...appointment, windowStart: toLocalInput(appointment.windowStart), windowEnd: toLocalInput(appointment.windowEnd) })}>编辑</button><button className="danger-action" onClick={() => void remove('appointment', appointment.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'yard' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">YARD HEATMAP / STACK DENSITY</div><h2>堆场容量与安全约束</h2></div><span className="muted">实时区块压力</span></div><div className="yard-grid">{blocks.map(block => <div className={`block ${block.pressure}`} key={block.id}><div className="block-top"><b>{block.id}</b><strong>{pct(block.utilization)}</strong></div><span>{block.zone}</span><div className="heat"><i style={{ width: `${block.heat / maxHeat * 100}%` }}/></div><div className="block-stats"><span>空位 {block.freeSlots}</span><span>冷插 {block.usedPlugs}/{block.reeferPlugs}</span><span>{block.hazmatAllowed?'危险品可入':'普通区'}</span></div></div>)}</div><div className="yard-note"><span>堆位推荐会同时考虑容量、热区、危险品隔离、冷藏插座和设备可达性。</span><b>A01 → C03 重排建议可释放 21 个低热度堆位</b></div></section>}
    {tab === 'tasks' && <div className="layout"><section className="panel wide"><div className="panel-head"><div><div className="eyebrow">TASK DISPATCH / EQUIPMENT POOL</div><h2>场内任务优先级与设备指派</h2><span className="muted">支持新增、编辑、删除和设备指派</span></div><button className="primary-action" onClick={() => openCreate('task')}>＋ 新建任务</button></div><div className="table task-table"><div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>优先级</span><span>状态</span><span>设备 / 操作</span></div>{tasks.map(task => <div className="tr" key={task.id}><span><b>{task.id}</b><small>{task.kind} · {task.estimatedMinutes}min</small></span><span>{task.containerId}</span><span>{task.from} → {task.to}</span><span className={task.score>95?'critical':''}>{task.score}</span><span><span className={`pill ${task.status}`}>{task.status}</span>{task.blockingReasons.length>0&&<small className="blocked-text">{task.blockingReasons[0]}</small>}</span><span className="task-actions"><select value={task.equipmentId??''} onChange={event => void assign(task.id, event.target.value)}><option value="">未指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => openEdit('task', task.id, { kind: task.kind, containerId: task.containerId, from: task.from, to: task.to, equipmentId: task.equipmentId ?? '', priority: String(task.priority), estimatedMinutes: String(task.estimatedMinutes), scheduledAt: toLocalInput(task.scheduledAt), status: task.status })}>编辑</button><button className="danger-action" onClick={() => void remove('task', task.id)}>删除</button></span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>设备池</h3><span>{equipment.length} assets</span></div>{equipment.map(item => <div className="equipment" key={item.id}><i className={`equip-dot ${item.status}`}/><div><b>{item.name}</b><small>{item.location} · 队列 {item.queue}</small></div><strong>{item.battery}%</strong></div>)}</section></div>}
    {tab === 'waves' && <div className="waves-page">
      <section className="panel wide wave-composer">
        <div className="panel-head"><div><div className="eyebrow">WAVE PLANNER / 场桥作业批处理</div><h2>作业波次编排与路线校验</h2><span className="muted">勾选可关联的 rehandle / deliver / load 任务，先做层级与前置关系校验，确认预计耗时和阻塞点后再提交</span></div></div>
        <div className="composer-bar">
          <label>绑定场桥<select value={composerEquipment} onChange={e => { setComposerEquipment(e.target.value); setWavePlan(undefined); }}>{equipment.filter(item => item.kind === 'yard-crane').map(item => <option key={item.id} value={item.id}>{item.name} · {item.location} · {item.status}</option>)}</select></label>
          <div className="composer-summary"><b>{composerTasks.length}</b><span>个任务已选{composerDuplicates.size > 0 && <i className="bp-error-text"> · 含同箱重复，需移除</i>}</span></div>
          <button className="primary-action" disabled={busy || planLoading || composerTasks.length === 0} onClick={() => void runPlan()}>{planLoading ? '路线校验中…' : '校验路线与耗时'}</button>
          <button className="primary-action submit-wave" disabled={busy || !wavePlan?.feasible || composerDuplicates.size > 0} onClick={() => void submitWave()}>提交波次</button>
        </div>
        <div className="table wave-pick-table"><div className="tr th"><span>选择</span><span>任务 / 箱号</span><span>路径</span><span>类型 / 优先级</span><span>状态</span><span>当前设备</span></div>
          {eligibleTasks.length === 0 && <div className="empty-hint">没有可组波的任务：rehandle / deliver / load 任务均已在活动波次中或已完成</div>}
          {eligibleTasks.map(task => <div className={`tr ${composerTasks.includes(task.id) ? 'picked' : ''} ${composerDuplicates.has(task.id) ? 'dup-row' : ''}`} key={task.id} onClick={() => toggleComposerTask(task.id)}>
            <span><input type="checkbox" checked={composerTasks.includes(task.id)} readOnly/>{composerDuplicates.has(task.id) && <small className="bp-error-text">同箱重复</small>}</span>
            <span><b>{task.id}</b><small>{task.containerId}</small></span>
            <span>{task.from} → {task.to}</span>
            <span>{task.kind}<small>优先级 {task.priority} · {task.estimatedMinutes}min</small></span>
            <span><span className={`pill ${task.status}`}>{task.status}</span></span>
            <span>{task.equipmentId ?? '—'}</span>
          </div>)}
        </div>
        {wavePlan && <div className={`plan-result ${wavePlan.feasible ? 'feasible' : 'infeasible'}`}>
          <div className="plan-head"><strong>{wavePlan.feasible ? '路线校验通过，可提交波次' : '路线不成立，请按阻塞点调整'}</strong>
            <span><b>{wavePlan.estimatedMinutes}</b> 分钟预计总耗时（含跨区移机）</span>
            <span>{wavePlan.steps.length} 个执行步骤</span><span>{wavePlan.blockingPoints.filter(p => p.severity === 'error').length} 硬阻塞 · {wavePlan.blockingPoints.filter(p => p.severity === 'warning').length} 预警 · {wavePlan.blockingPoints.filter(p => p.severity === 'info').length} 层级约束</span>
          </div>
          <div className="plan-steps">{wavePlan.steps.map(step => <div className={`plan-step ${step.status}`} key={step.taskId}>
            <div className="step-seq">{step.sequence}</div>
            <div className="step-body"><b>{step.taskId} · {step.containerId}</b><small>{step.kind} · {step.from} → {step.to}</small>
              {step.prerequisites.length > 0 && <small className="pre-req">前置：{step.prerequisites.join('、')}（堆位层级/同箱链）</small>}
              <small>作业 {step.estimatedMinutes}min + 移机 {step.travelMinutes}min{step.travelMinutes > 0 ? `（${step.travelLabel}）` : ''}</small>
              {step.blockingPoints.map((p, i) => <div key={i} className={`bp-line ${severityClass(p.severity)}`}><em>{p.severity === 'error' ? '硬阻塞' : p.severity === 'warning' ? '预警' : '约束'}</em>{p.message} — <i>{p.resolution}</i></div>)}
            </div>
          </div>)}</div>
          {wavePlan.blockingPoints.filter(p => p.at === 'header').map((p, i) => <div key={i} className={`bp-line ${severityClass(p.severity)}`}><em>波次级</em>{p.message} — <i>{p.resolution}</i></div>)}
        </div>}
      </section>
      <div className="wave-cards">
        {waves.length === 0 && <section className="panel wide empty-hint">暂无波次，请先在上方编排器组波</section>}
        {waves.map(wave => {
          const machine = waveEquipment(wave.equipmentId);
          const doneCount = wave.steps.filter(s => s.status === 'done').length;
          const current = wave.steps.find(s => ['running', 'pending', 'failed'].includes(s.status));
          const resumePoint = wave.status === 'paused' ? wave.steps.find(s => s.status === 'pending') : undefined;
          return <section className={`panel wave-card ${wave.status}`} key={wave.id}>
            <div className="wave-card-head">
              <div><div className="eyebrow">{wave.id} · v{wave.version}</div><h3>{wave.name}</h3><small>{machine?.name} · 锚点 {machine?.location}</small></div>
              <span className={`pill ${statusClass(wave.status)}`}>{statusLabel[wave.status]}</span>
            </div>
            <div className="wave-meta">
              <div><small>预计总耗时</small><b>{wave.estimatedMinutes}<em> min</em></b></div>
              <div><small>已作业 / 剩余</small><b>{wave.elapsedMinutes}<em> / {wave.remainingMinutes} min</em></b></div>
              <div><small>完成步骤</small><b>{doneCount}<em> / {wave.steps.length}</em></b></div>
              <div><small>阻塞 / 预警</small><b className={wave.blockingPoints.some(p => p.severity === 'error') ? 'critical' : ''}>{wave.blockingPoints.filter(p => p.severity === 'error').length}<em className="warning"> · {wave.blockingPoints.filter(p => p.severity === 'warning').length}</em></b></div>
            </div>
            <div className="wave-progress"><i style={{ width: `${doneCount / Math.max(1, wave.steps.length) * 100}%` }} className={wave.status === 'failed' ? 'failed-bar' : ''}/></div>
            {wave.status === 'failed' && wave.failureReason && <div className="bp-line bp-error"><em>冻结</em>{wave.failureReason} — <i>后续任务全部保持冻结，禁止误放行</i></div>}
            {resumePoint && <div className="resume-entry"><em>中断点</em><b>第 {resumePoint.sequence} 步 · {resumePoint.taskId}（{resumePoint.containerId}）</b><span>{resumePoint.from} → {resumePoint.to}</span><p>恢复时将按现场实况重新校验堆位层级、箱子状态与海关放行，校验通过才会继续。</p></div>}
            <div className="wave-steps">
              {wave.steps.map(step => <div className={`wave-step ${step.status}`} key={step.taskId}>
                <span className="step-dot">{step.sequence}</span>
                <div><b>{step.taskId}</b><small>{step.containerId} · {step.kind}</small><small>{step.from} → {step.to}</small>
                  {step.travelMinutes > 0 && <small className="travel-hint">移机 {step.travelMinutes}min · {step.travelLabel}</small>}
                  {step.note && <small className="step-note">{step.note}</small>}
                  {step.blockingPoints.filter(p => p.code !== 'failed-predecessor' || step.status === 'pending').map((p, i) => <div key={i} className={`bp-line ${severityClass(p.severity)}`}><em>{p.code}</em>{p.message}</div>)}
                </div>
                <span className={`pill ${statusClass(step.status)}`}>{statusLabel[step.status]}</span>
              </div>)}
            </div>
            <div className="wave-actions">
              {wave.status === 'validated' && <button className="primary-action" disabled={busy} onClick={() => void waveAction(wave, 'start')}>▶ 启动波次</button>}
              {wave.status === 'running' && current && <button className="primary-action" disabled={busy} onClick={() => void waveAction(wave, 'complete', current.taskId)}>✓ 完成当前步骤（{current.taskId}）</button>}
              {wave.status === 'running' && current && <button disabled={busy} onClick={() => void waveAction(wave, 'pause')}>❚❚ 中断</button>}
              {wave.status === 'running' && current && <button className="danger-action" disabled={busy} onClick={() => { const reason = window.prompt('记录失败原因（将冻结后续全部任务）'); if (reason) void waveAction(wave, current.taskId!, 'fail', { reason }); }}>✕ 回报失败</button>}
              {wave.status === 'paused' && <button className="primary-action resume-btn" disabled={busy} onClick={() => void waveAction(wave, 'start')}>↻ 从中断点恢复（重校现场）</button>}
              {wave.status === 'failed' && (() => { const failed = wave.steps.find(s => s.status === 'failed'); return <>
                <button className="primary-action" disabled={busy || !failed} onClick={() => void waveAction(wave, failed!.taskId, 'retry')}>↻ 故障排除，重试 {failed?.taskId}</button>
                <button disabled={busy || !failed} onClick={() => { if (window.confirm('确认跳过该任务？剩余路线会重新校验。')) void waveAction(wave, failed!.taskId, 'skip'); }}>跳过该步</button>
              </>; })()}
              {!['running', 'paused'].includes(wave.status) && <button className="danger-action" disabled={busy} onClick={() => void removeWave(wave)}>删除波次</button>}
            </div>
          </section>;
        })}
      </div>
    </div>}
    <footer>HarborGrid · 内存种子数据 + REST API · 箱务台账、闸口预约、场内任务提供完整增删改查操作 · 场桥波次支持层级校验、跨区计时、失败冻结与断点恢复</footer>
    {editor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setEditor(undefined); }}><form className="editor-modal" onSubmit={saveEditor}><div className="modal-head"><div><div className="eyebrow">{editor.mode.toUpperCase()} / {editor.entity.toUpperCase()}</div><h2>{editor.mode==='create'?'创建':'编辑'}{editor.entity==='container'?'箱务记录':editor.entity==='appointment'?'闸口预约':'作业任务'}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(undefined)}>×</button></div>
      {editor.entity === 'container' && <div className="form-grid">
        <label>集装箱号<input required disabled={editor.mode==='edit'} value={String(editor.values.id)} onChange={event => updateField('id', event.target.value.toUpperCase())}/></label>
        <label>关联航次<select value={String(editor.values.voyageId)} onChange={event => updateField('voyageId', event.target.value)}>{voyages.filter(voyage => voyage.status!=='departed').map(voyage => <option key={voyage.id} value={voyage.id}>{voyage.id} · {voyage.vessel}</option>)}</select></label>
        <label>尺寸<select value={String(editor.values.size)} onChange={event => updateField('size', event.target.value)}><option value="20">20 ft</option><option value="40">40 ft</option><option value="45">45 ft</option></select></label>
        <label>ISO 箱型<input required value={String(editor.values.isoType)} onChange={event => updateField('isoType', event.target.value)}/></label>
        <label>作业流向<select value={String(editor.values.direction)} onChange={event => updateField('direction', event.target.value)}><option value="import">进口</option><option value="export">出口</option><option value="transshipment">中转</option></select></label>
        <label>箱状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['in-transit','at-gate','in-yard','on-quay','released','hold'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>重量 (吨)<input type="number" min="0.1" step="0.1" required value={String(editor.values.weightT)} onChange={event => updateField('weightT', event.target.value)}/></label>
        <label>海关状态<select value={String(editor.values.customs)} onChange={event => updateField('customs', event.target.value)}><option value="released">已放行</option><option value="inspection">查验中</option><option value="hold">扣留</option></select></label>
        <label>优先级<select value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}><option value="normal">普通</option><option value="hot">急箱</option><option value="reefer">冷藏</option><option value="hazmat">危险品</option></select></label>
        <label>堆位<input required placeholder="例如 B07-R03-T2" value={String(editor.values.yardSlot)} onChange={event => updateField('yardSlot', event.target.value.toUpperCase())}/></label>
        <label>危险品类别<input placeholder="非危险品留空" value={String(editor.values.hazmatClass)} onChange={event => updateField('hazmatClass', event.target.value)}/></label>
        <label className="check-label"><input type="checkbox" checked={Boolean(editor.values.reefer)} onChange={event => updateField('reefer', event.target.checked)}/>冷藏箱</label>
        {Boolean(editor.values.reefer) && <label>目标温度 (°C)<input type="number" step="0.1" value={String(editor.values.temperature)} onChange={event => updateField('temperature', event.target.value)}/></label>}
      </div>}
      {editor.entity === 'appointment' && <div className="form-grid">
        <label>集装箱<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id} · {container.status}</option>)}</select></label>
        <label>预约类型<select value={String(editor.values.type)} onChange={event => updateField('type', event.target.value)}><option value="pickup">提箱</option><option value="dropoff">进场</option></select></label>
        <label>车牌号<input required value={String(editor.values.truckNo)} onChange={event => updateField('truckNo', event.target.value)}/></label><label>司机<input required value={String(editor.values.driver)} onChange={event => updateField('driver', event.target.value)}/></label>
        <label>窗口开始<input type="datetime-local" required value={String(editor.values.windowStart)} onChange={event => updateField('windowStart', event.target.value)}/></label><label>窗口结束<input type="datetime-local" required value={String(editor.values.windowEnd)} onChange={event => updateField('windowEnd', event.target.value)}/></label>
        <label>闸口车道<select value={String(editor.values.lane)} onChange={event => updateField('lane', event.target.value)}><option value="north">北闸口</option><option value="south">南闸口</option><option value="rail">铁路闸口</option></select></label>
      </div>}
      {editor.entity === 'task' && <div className="form-grid">
        <label>任务类型<select value={String(editor.values.kind)} onChange={event => updateField('kind', event.target.value)}>{['receive','deliver','rehandle','load','discharge','inspect'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>关联箱号<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id}</option>)}</select></label>
        <label>起点<input required value={String(editor.values.from)} onChange={event => updateField('from', event.target.value)}/></label><label>终点<input required value={String(editor.values.to)} onChange={event => updateField('to', event.target.value)}/></label>
        <label>优先级 (1–100)<input type="number" min="1" max="100" required value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}/></label><label>预计时长 (分钟)<input type="number" min="1" required value={String(editor.values.estimatedMinutes)} onChange={event => updateField('estimatedMinutes', event.target.value)}/></label>
        <label>计划时间<input type="datetime-local" required value={String(editor.values.scheduledAt)} onChange={event => updateField('scheduledAt', event.target.value)}/></label><label>指派设备<select value={String(editor.values.equipmentId)} onChange={event => updateField('equipmentId', event.target.value)}><option value="">暂不指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
        {editor.mode==='edit' && <label>任务状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['queued','assigned','executing','blocked','done'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>}
      {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" onClick={() => setEditor(undefined)}>取消</button><button className="primary-action" disabled={busy}>{busy?'保存中…':'保存'}</button></div>
    </form></div>}
  </main>;
}

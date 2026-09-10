/**
 * MockScheduler —— 浏览器端"演示编排源"（非算法实现）。
 *
 * 定位（见 docs/方案.md §3/§6）：
 *  - 本模块不是路径规划/避障/调度/排列算法的实现，只是按既定消息契约(AlgorithmEvent)
 *    生成一段"演示剧本"，用于无算法后端时的效果展示与联调占位；
 *  - 几何可行性（列跨度适配、走廊限位、交接位、驻泊分工、避障绕行可通行性）由
 *    src/utils/layout.ts 与本文件中的演示编排规则共同保证；
 *  - 真实算法接入时由 AlgorithmAdapter 替代本模块作为消息源。
 */
import type { CargoConfig } from '@/config/cargo';
import type {
  AGVCommand,
  AgvStateEvent,
  AlgorithmEvent,
  AlgorithmSourceMode,
  ControlCommand,
  CargoType,
  DoorId,
  Pose3,
  SceneProbe,
  TransportTask
} from '@/types/cargo';
import { agvRoles, handoffPose, parseSlotId, platformPose, rackXEnd, rackXStart, slotCellOf } from '@/utils/layout';

export interface MockSchedulerOptions {
  emit: (event: AlgorithmEvent) => void;
  probe: () => SceneProbe | null;
  config: () => CargoConfig;
}

const ARRIVE_DIST = 0.16;
const ARRIVE_YAW = 0.18;
const MAX_LEG_WAIT_MS = 40000;
const POLL_MS = 80;

/** 载货走廊车道偏置：L 槽位走 +Z 车道，R 槽位走 -Z 车道（|Z|≤0.5 保证与两侧已放货柜干涉）。 */
function laneZOf(side: 'L' | 'R'): number {
  return side === 'L' ? 0.5 : -0.5;
}

function poseDist(a: Pose3, b: Pose3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function yawDeltaOf(from: number, to: number): number {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/** 两点间的行驶航向（AGV 局部 +X 为车头）。 */
function headingTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return 0;
  return Math.atan2(-dz, dx);
}

function sleepRaw(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

interface RunToken {
  taskId: string;
  cancelled: boolean;
}

interface ItemJob {
  cargoId: string;
  cargoName: string;
  cargoType: CargoType;
  slotId: string;
  column: number;
  side: 'L' | 'R';
  agvId: string;
  doorId: DoorId;
}

export class MockScheduler {
  kind: AlgorithmSourceMode = 'mock';
  private readonly emit: (event: AlgorithmEvent) => void;
  private readonly probe: () => SceneProbe | null;
  private readonly config: () => CargoConfig;

  private readonly queue: TransportTask[] = [];
  private current: { task: TransportTask; token: RunToken } | null = null;
  private paused = false;
  private disposed = false;
  private ts = 1;
  private cargoSeq = 1000;

  constructor(options: MockSchedulerOptions) {
    this.emit = options.emit;
    this.probe = options.probe;
    this.config = options.config;
  }

  start(): void {
    agvRoles(this.config()).forEach((role) => this.emitAgv(role.id, { phase: 'idle' }));
    this.emitLog('info', '演示编排源已就绪：请选择装载模式并下发任务');
  }

  dispose(): void {
    this.disposed = true;
    this.current?.token && (this.current.token.cancelled = true);
    this.queue.length = 0;
    this.current = null;
  }

  onConfigChange(): void {
    const running = !!this.current;
    if (this.current) {
      this.current.token.cancelled = true;
      this.current = null;
    }
    this.queue.length = 0;
    if (running) this.emitLog('warn', '布局参数已变更，进行中的演示任务已中止（请重新下发）');
  }

  onControl(command: ControlCommand): void {
    switch (command.type) {
      case 'system:init':
      case 'system:reset':
        this.cancelActive();
        this.emitLog('info', '演示源已重置');
        break;
      case 'system:pause':
        this.paused = true;
        this.emitLog('warn', '演示已暂停（AGV 待命）');
        break;
      case 'system:start':
        this.paused = false;
        this.emitLog('info', '演示恢复运行');
        this.pump();
        break;
      case 'task:cancel': {
        if (this.current?.task.id === command.taskId) {
          this.current.token.cancelled = true;
          this.emitTask(this.current.task.id, 'cancelled', 0, '任务已取消');
          this.current = null;
          this.pump();
        } else {
          const rest = this.queue.filter((t) => t.id !== command.taskId);
          this.queue.splice(0, this.queue.length, ...rest);
        }
        break;
      }
      case 'task:dispatch':
        this.queue.push(command.task);
        this.pump();
        break;
      case 'door:override':
        this.emit({ type: 'door:set', payload: { doorId: command.doorId, state: command.state } });
        this.emitLog('info', `${command.doorId === 'forward' ? '前货舱门' : '后货舱门'}手动${command.state === 'open' ? '开启' : '关闭'}`);
        break;
      case 'config:change':
        break;
    }
  }

  // ---------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.current || this.queue.length === 0 || this.paused || this.disposed) return;
    const task = this.queue.shift()!;
    const token: RunToken = { taskId: task.id, cancelled: false };
    this.current = { task, token };
    this.executeTask(task, token).finally(() => {
      if (this.current?.token === token) this.current = null;
      this.pump();
    });
  }

  private cancelActive(): void {
    if (this.current) {
      this.current.token.cancelled = true;
      this.current = null;
    }
    this.queue.length = 0;
  }

  /** 任务执行：按槽位把货物分派给对应 AGV（多机并行，单机全程串行）。 */
  private async executeTask(task: TransportTask, token: RunToken): Promise<void> {
    const cfg = this.config();
    this.emitTask(task.id, 'running', 0, task.mode === 'multi' ? '多货物同时装载开始' : '单货物装载开始');
    this.emitLog('info', `任务 ${task.id} 开始：${task.mode === 'single' ? '单货物装载' : `多货物同时装载（${task.items.length} 件）`}`);

    const jobs = this.buildJobs(task, cfg);
    if (jobs.length === 0) {
      this.emitTask(task.id, 'failed', 0, '无可用的适配槽位');
      return;
    }

    const perAgv = new Map<string, ItemJob[]>();
    for (const job of jobs) {
      if (!perAgv.has(job.agvId)) perAgv.set(job.agvId, []);
      perAgv.get(job.agvId)!.push(job);
    }

    const total = jobs.length;
    let done = 0;
    const runners = [...perAgv.entries()].map(([agvId, agvJobs]) =>
      this.runAgvSequence(agvId, agvJobs, task.id, token).finally(() => {
        if (token.cancelled) return;
        done += agvJobs.length;
        this.emitTask(task.id, 'running', Math.min(0.97, done / total));
      })
    );
    try {
      await Promise.all(runners);
    } catch {
      // 单个执行器异常已在 runAgvSequence 中上报 task:state failed，此处吞掉避免未处理拒绝。
      if (token.cancelled) return;
    }
    if (token.cancelled) return;

    this.emitTask(task.id, 'done', 1, '任务完成');
    this.emitLog('info', `任务 ${task.id} 完成：${total} 件货物已排列放置`);
    (['forward', 'aft'] as DoorId[]).forEach((doorId) => this.emit({ type: 'door:set', payload: { doorId, state: 'close' } }));
    this.emit({ type: 'path:plan', payload: { agvId: jobs[0].agvId, waypoints: [] } });
  }

  private buildJobs(task: TransportTask, cfg: CargoConfig): ItemJob[] {
    const roles = agvRoles(cfg);
    const half = Math.ceil(cfg.slotCount / 2);
    const jobs: ItemJob[] = [];
    for (const item of task.items) {
      if (!item.slotId) continue;
      const parsed = parseSlotId(item.slotId);
      const cell = parsed ? slotCellOf(cfg, item.slotId) : null;
      if (!parsed || !cell) continue;
      const doorId: DoorId = parsed.column < half ? 'forward' : 'aft';
      const role =
        roles.find((r) => parsed.column >= r.fromColumn && parsed.column < r.toColumn) ??
        roles[0];
      const cargoId = `C${this.cargoSeq++}`;
      jobs.push({
        cargoId,
        cargoName: `${item.cargoType}-${cargoId.slice(1)}`,
        cargoType: item.cargoType,
        slotId: item.slotId,
        column: parsed.column,
        side: parsed.side,
        agvId: role.id,
        doorId
      });
    }
    return jobs;
  }

  /** 单台 AGV 顺序执行一组货物。 */
  private async runAgvSequence(agvId: string, jobs: ItemJob[], taskId: string, token: RunToken): Promise<void> {
    for (const job of jobs) {
      if (token.cancelled) return;
      this.emit({ type: 'slot:mark', payload: { slotId: job.slotId, state: 'pending' } });
      this.emitAgv(agvId, { phase: 'toPickup', taskId, cargoId: job.cargoId, cargoType: job.cargoType });
      try {
        await this.handleItem(agvId, job, token);
        if (!token.cancelled) {
          this.emit({ type: 'slot:mark', payload: { slotId: job.slotId, state: 'clear' } });
          this.emitAgv(agvId, { phase: 'done', taskId, cargoId: null, cargoType: null });
        }
      } catch (error) {
        if (token.cancelled) return;
        this.emitAgv(agvId, { phase: 'error', taskId, cargoId: null, cargoType: null });
        this.emitTask(taskId, 'failed', 0, `${agvId} 执行异常：${String(error)}`);
        this.emitLog('error', `${agvId} 任务异常：${String(error)}`);
        throw error;
      }
    }
    this.emitAgv(agvId, { phase: 'idle', taskId: undefined, cargoId: null, cargoType: null });
  }

  /** 单件货物的完整演示流程：开舱门→货物滑入→空驶取货→载货运输(可避障)→入位→完成。 */
  private async handleItem(agvId: string, job: ItemJob, token: RunToken): Promise<void> {
    const cfg = this.config();
    const probe = this.probe();
    if (!probe) throw new Error('场景探针未就绪');
    const { cargoId, cargoName, cargoType, slotId, side, doorId } = job;
    const handoff = handoffPose(cfg, doorId);
    // 载货走廊限位：宽体货（PMX/PAX）沿中线 Z=0 行驶（其半宽可达 0.99，两侧货柜内缘最窄约 ±1.21），
    // 标准 AKE 走车道 ±0.5；入位横移均在目标列完成。
    const wide = cfg.uld[cargoType].width > 1.6;
    const lane = wide ? 0 : laneZOf(side);
    this.emitLog('info', `编排：${agvId} 装载 ${cargoName} → ${slotId}（${doorId === 'forward' ? '前' : '后'}货舱门）`);

    // 1) 开舱门（等待门扇基本开启后货物再进舱），货物在平台生成并滑入交接位。
    this.emit({ type: 'door:set', payload: { doorId, state: 'open' } });
    await this.waitDoorOpen(probe, doorId, token);
    this.emit({ type: 'cargo:spawn', payload: { cargoId, cargoType, pose: platformPose(cfg, doorId) } });
    this.emit({ type: 'cargo:state', payload: { cargoId, status: 'waiting', slotId: null, cargoType } });
    this.emit({ type: 'cargo:move', payload: { cargoId, pose: handoff } });
    this.emitLog('info', `${cargoName} 经舱门滑入舱内交接位`);

    // 2) AGV 空驶到交接位（汇入走廊中线后经门区空场进入）。
    const emptyRoute = this.routeEmptyToHandoff(cfg, agvId, doorId);
    await this.driveRoute(agvId, emptyRoute, token);

    // 3) 等货物滑入到位后取货。
    this.emitAgv(agvId, { phase: 'pickup', taskId: token.taskId, cargoId, cargoType });
    await this.waitCargoAt(probe, cargoId, handoff, token, 10000);
    this.emit({ type: 'cargo:pickup', payload: { agvId, cargoId } });
    this.sendCommand({ agvId, type: 'pick' });
    await this.sleep(600, token);
    this.emit({ type: 'cargo:state', payload: { cargoId, status: 'inTransit', slotId: null, cargoType } });
    this.emitAgv(agvId, { phase: 'transport', taskId: token.taskId, cargoId, cargoType });
    this.emitLog('info', `${agvId} 已取货 ${cargoName}，沿载货走廊运输`);

    // 4) 载货沿走廊到目标列（含横向过渡与避障绕行）。
    const target = slotCellOf(cfg, slotId)!;
    const loaded = this.routeLoadedToColumn(agvId, cfg, doorId, target.x, lane, wide);
    this.emit({ type: 'path:plan', payload: { agvId, waypoints: loaded.waypoints } });
    if (loaded.obstacle) {
      this.emit({ type: 'obstacle:event', payload: loaded.obstacle });
      this.emitLog('warn', `${agvId} 货载路径检测到障碍，重规划绕行`);
    }
    await this.driveRoute(agvId, loaded.waypoints, token);

    // 5) 到位入位：横向滑移放置。
    this.emitAgv(agvId, { phase: 'placing', taskId: token.taskId, cargoId, cargoType });
    this.emit({ type: 'cargo:place', payload: { agvId, cargoId, slotId } });
    this.sendCommand({ agvId, type: 'place' });
    await this.sleep(450, token);
    await this.waitCargoAt(probe, cargoId, { x: target.x, y: 0, z: target.z, yaw: 0 }, token, 9000);
    this.emit({ type: 'cargo:state', payload: { cargoId, status: 'placed', slotId, cargoType } });
    this.emitLog('info', `${cargoName} 已排列放置至 ${slotId}`);
  }

  // ---------------------------------------------------------------------------
  // 演示路径编排（几何规则 docs/方案.md §6.6；全部基于 config 计算）
  // ---------------------------------------------------------------------------

  /**
   * 空驶到指定门交接位：
   *  - AGV 当前在走廊车道 |z|=0.5 时先汇入中线（空车可在货柜区中线上行驶）；
   *  - 若 AGV 不在该门空场内（需穿越货柜区），先沿中线到达门区空场边缘；
   *  - 门轴横向进入交接位（z0 → -1.0）为空场段。
   */
  private routeEmptyToHandoff(cfg: CargoConfig, agvId: string, doorId: DoorId): Pose3[] {
    const cur = this.probe()?.agvPose(agvId) ?? null;
    const doorX = cfg.doors[doorId].x;
    const stagingLimit = doorId === 'forward' ? rackXStart(cfg) - 0.5 : rackXEnd(cfg) + 0.5;
    const pts: Array<{ x: number; z: number }> = [];
    if (cur) {
      if (Math.abs(cur.z) > 0.45) pts.push({ x: cur.x, z: 0 });
      const needsCross = doorId === 'forward' ? cur.x > stagingLimit : cur.x < stagingLimit;
      if (needsCross) pts.push({ x: stagingLimit, z: 0 });
    }
    pts.push({ x: doorX, z: 0 });
    pts.push({ x: doorX, z: -1.0 });
    return this.toPoses(pts, doorId === 'forward' ? 0 : Math.PI);
  }

  /**
   * 载货路线：交接位 →(过渡点: 在门区空场完成横向入车道)→ 载货走廊(车道 |Z|=0.5) → 目标列车道位。
   * 障碍演示：交接位→过渡点斜线中段设障，绕行点从障碍靠墙深位通过（门区空场可通行）。
   */
  private routeLoadedToColumn(
    agvId: string,
    cfg: CargoConfig,
    doorId: DoorId,
    targetX: number,
    lane: number,
    wide: boolean
  ): { waypoints: Pose3[]; obstacle: { agvId: string; pose: Pose3; radius: number } | null } {
    const doorX = cfg.doors[doorId].x;
    // 横向入车道过渡点必须落在门区空场内（货柜区外缘留 ≥0.9m 余量）。
    const transX = doorId === 'forward' ? rackXStart(cfg) - 0.9 : rackXEnd(cfg) + 1.5;
    const midX = (doorX + transX) / 2;
    // 宽体货载不演示深位绕行（其外缘贴近舱壁，绕行点不可通行）。
    const useDetour = !wide && Math.abs(targetX - doorX) > 1.2;
    const obstacle = useDetour
      ? { agvId, pose: { x: midX, y: 0, z: -1.15, yaw: 0 }, radius: 0.4 }
      : null;
    const pts: Array<{ x: number; z: number }> = [];
    if (useDetour) {
      // 靠墙深位绕行点：仍在门区空场（z=-2.55，货载半宽 0.767 下外缘约 -3.32，距舱壁内沿 -3.4 留余量）。
      pts.push({ x: midX, z: -2.55 });
      pts.push({ x: transX, z: lane });
    } else {
      pts.push({ x: transX, z: lane });
    }
    pts.push({ x: targetX, z: lane });

    const waypoints = this.toPoses(pts, doorId === 'forward' ? 0 : Math.PI);
    return { waypoints, obstacle };
  }

  private toPoses(pts: Array<{ x: number; z: number }>, finalYaw: number): Pose3[] {
    return pts.map((p, index) => {
      const isLast = index === pts.length - 1;
      return { x: p.x, y: 0, z: p.z, yaw: isLast ? finalYaw : headingTo(p, pts[index + 1]) };
    });
  }

  // ---------------------------------------------------------------------------

  private sendCommand(command: Omit<AGVCommand, 'ts'>): void {
    this.emit({ type: 'agv:command', payload: { ...command, ts: this.ts++ } });
  }

  private emitAgv(agvId: string, payload: Omit<AgvStateEvent, 'agvId'>): void {
    this.emit({ type: 'agv:state', payload: { agvId, ...payload } });
  }

  private emitTask(taskId: string, status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled', progress: number, message?: string): void {
    this.emit({ type: 'task:state', payload: { taskId, status, progress, message } });
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', payload: { level, message } });
  }

  private async driveRoute(agvId: string, waypoints: Pose3[], token: RunToken): Promise<void> {
    for (const wp of waypoints) {
      if (token.cancelled) return;
      this.sendCommand({ agvId, type: 'moveTo', pose: wp });
      await this.waitAgvAt(agvId, wp, token);
    }
  }

  private async waitAgvAt(agvId: string, target: Pose3, token: RunToken): Promise<void> {
    const probe = this.probe();
    const start = Date.now();
    for (;;) {
      if (token.cancelled) return;
      await this.pauseGate(token);
      const pose = probe?.agvPose(agvId);
      if (pose && poseDist(pose, target) < ARRIVE_DIST && Math.abs(yawDeltaOf(pose.yaw, target.yaw)) < ARRIVE_YAW) return;
      if (Date.now() - start > MAX_LEG_WAIT_MS) throw new Error(`${agvId} 长时间未到达目标位`);
      await this.sleep(POLL_MS, token);
    }
  }

  private async waitDoorOpen(probe: SceneProbe, doorId: DoorId, token: RunToken): Promise<void> {
    if (!probe.doorProgress) return;
    const start = Date.now();
    for (;;) {
      if (token.cancelled) return;
      await this.pauseGate(token);
      const progress = probe.doorProgress(doorId);
      if (progress === null || progress >= 0.9) return;
      if (Date.now() - start > 12000) throw new Error(`${doorId} 舱门开启超时`);
      await this.sleep(POLL_MS, token);
    }
  }

  private async waitCargoAt(probe: SceneProbe, cargoId: string, target: Pose3, token: RunToken, timeoutMs: number): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (token.cancelled) return;
      await this.pauseGate(token);
      const pose = probe.cargoPose(cargoId);
      if (pose && poseDist(pose, target) < 0.2 && Math.abs(pose.y) < 0.08) return;
      if (Date.now() - start > timeoutMs) throw new Error(`${cargoId} 到位超时`);
      await this.sleep(POLL_MS, token);
    }
  }

  private async pauseGate(token: RunToken): Promise<void> {
    while (this.paused && !token.cancelled && !this.disposed) {
      await sleepRaw(200);
    }
  }

  private async sleep(ms: number, token: RunToken): Promise<void> {
    const step = 200;
    let elapsed = 0;
    while (elapsed < ms) {
      if (token.cancelled) return;
      await this.pauseGate(token);
      await sleepRaw(step);
      elapsed += step;
    }
  }
}

/**
 * MockScheduler —— 浏览器端"演示编排源"（非算法实现）。
 *
 * 定位（见 docs/方案.md §3/§6）：
 *  - 本模块不是路径规划/避障/调度/排列算法的实现，只是按既定消息契约(AlgorithmEvent)
 *    生成一段"演示剧本"，用于无算法后端时的效果展示与联调占位；
 *  - 几何可行性（列跨度适配、舱门通行、机头空场转场、推入间距、初始装载位置）由
 *    src/utils/layout.ts 与本文件中的演示编排规则共同保证；
 *  - 真实算法接入时由 AlgorithmAdapter 替代本模块作为消息源。
 *
 * 当前编排主线（单舱门 / 舱外待命 / 全宽度货位）：
 *  1. AGV 在前舱门外平台待命，任务下发后**货物直接出现在 AGV 上**（无需人工/平台滑入）；
 *  2. AGV 载货穿前舱门进舱（门洞净高按载货高度配置，保证不超高）；
 *  3. 在机头空场完成跨排横向转场，再沿目标排驶到目标列**前方**；
 *  4. 货物沿 +X 推入货位（AGV 本体不进入货位，避免与已装货柜干涉）；
 *  5. AGV 退回舱外待命位，等待下一条任务。
 * 货位从机尾向机头方向填充，因此 AGV 进出路径始终只经过空货位。
 */
import type { CargoConfig } from '@/config/cargo';
import type {
  AGVCommand,
  AgvStateEvent,
  AlgorithmEvent,
  AlgorithmSourceMode,
  ControlCommand,
  CargoType,
  Pose3,
  SceneProbe,
  TransportTask
} from '@/types/cargo';
import {
  PLACE_PUSH,
  agvRoles,
  entryPose,
  frontLaneX,
  parseSlotId,
  slotCellOf
} from '@/utils/layout';

export interface MockSchedulerOptions {
  emit: (event: AlgorithmEvent) => void;
  probe: () => SceneProbe | null;
  config: () => CargoConfig;
}

const ARRIVE_DIST = 0.35;
const MAX_LEG_WAIT_MS = 240000;
const POLL_MS = 80;
/** 与车端一致的最小转弯半径（m）：路径拐点按该半径圆角化，避免车端"追直角"导致甩尾外扩。 */
const TURN_RADIUS = 1.2;
const ARC_STEP = Math.PI / 9;

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
  side: 'L' | 'R' | 'C';
  agvId: string;
  home: Pose3;
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
    this.emitLog('info', '演示编排源已就绪：AGV 已在前舱门外待命，请下发装载任务');
  }

  dispose(): void {
    this.disposed = true;
    if (this.current) this.current.token.cancelled = true;
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
        // 舱门常开、无门扇：手动开关指令不再下发（保留契约兼容）。
        this.emitLog('info', '舱门常开，无需手动开关');
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

  /**
   * 任务执行：货物按件分配给 AGV（多车时轮转分配）。
   * 只有一扇前舱门，故货物**串行**通过舱门——避免两台车在门洞互相遮挡/穿插。
   */
  private async executeTask(task: TransportTask, token: RunToken): Promise<void> {
    const cfg = this.config();
    this.emitTask(task.id, 'running', 0, task.mode === 'multi' ? '多货物装载开始' : '单货物装载开始');
    this.emitLog('info', `任务 ${task.id} 开始：${task.mode === 'single' ? '单货物装载' : `多货物装载（${task.items.length} 件）`}`);

    const jobs = this.buildJobs(task, cfg);
    if (jobs.length === 0) {
      this.emitTask(task.id, 'failed', 0, '无可用的适配货位');
      return;
    }
    // 舱门常开、无门扇，不再下发开门/关门指令。

    const total = jobs.length;
    let done = 0;
    for (const job of jobs) {
      if (token.cancelled) break;
      await this.runItem(job, task.id, token);
      done += 1;
      if (!token.cancelled) this.emitTask(task.id, 'running', Math.min(0.97, done / total));
    }
    if (token.cancelled) return;

    this.emitTask(task.id, 'done', 1, '任务完成');
    this.emitLog('info', `任务 ${task.id} 完成：${total} 件货物已排列放置`);
    this.emit({ type: 'path:plan', payload: { agvId: jobs[0].agvId, waypoints: [] } });
  }

  private buildJobs(task: TransportTask, cfg: CargoConfig): ItemJob[] {
    const roles = agvRoles(cfg);
    const jobs: ItemJob[] = [];
    task.items.forEach((item, index) => {
      if (!item.slotId) return;
      const parsed = parseSlotId(item.slotId);
      const cell = parsed ? slotCellOf(cfg, item.slotId) : null;
      if (!parsed || !cell) return;
      const role = roles[index % roles.length];
      const cargoId = `C${this.cargoSeq++}`;
      jobs.push({
        cargoId,
        cargoName: `${item.cargoType}-${cargoId.slice(1)}`,
        cargoType: item.cargoType,
        slotId: item.slotId,
        column: parsed.column,
        side: parsed.side,
        agvId: role.id,
        home: role.home
      });
    });
    return jobs;
  }

  /** 单件货物：舱外上货 → 载货穿门进舱 → 推入货位 → 退回舱外。 */
  private async runItem(job: ItemJob, taskId: string, token: RunToken): Promise<void> {
    const cfg = this.config();
    const probe = this.probe();
    if (!probe) throw new Error('场景探针未就绪');
    const { agvId, cargoId, cargoName, cargoType, slotId, home } = job;
    const target = slotCellOf(cfg, slotId);
    if (!target) throw new Error(`货位 ${slotId} 不存在`);

    this.emit({ type: 'slot:mark', payload: { slotId, state: 'pending' } });
    try {
      // 1) 货物直接出现在舱外待命的 AGV 上。
      this.emitAgv(agvId, { phase: 'toPickup', taskId, cargoId, cargoType });
      const agvPose = probe.agvPose(agvId) ?? home;
      const platformY = 0.67;
      this.emit({
        type: 'cargo:spawn',
        payload: { cargoId, cargoType, pose: { x: agvPose.x, y: platformY, z: agvPose.z, yaw: 0 } }
      });
      this.emit({ type: 'cargo:state', payload: { cargoId, status: 'waiting', slotId: null, cargoType } });
      this.emitLog('info', `${cargoName} 已装到 ${agvId} 车上（舱外待命位）`);

      this.emitAgv(agvId, { phase: 'pickup', taskId, cargoId, cargoType });
      this.emit({ type: 'cargo:pickup', payload: { agvId, cargoId } });
      this.sendCommand({ agvId, type: 'pick' });
      await this.sleep(420, token);
      this.emit({ type: 'cargo:state', payload: { cargoId, status: 'inTransit', slotId: null, cargoType } });
      this.emitAgv(agvId, { phase: 'transport', taskId, cargoId, cargoType });

      // 2) 载货穿前舱门进舱 → 机头空场转场 → 目标列前方。
      const inbound = this.routeInbound(cfg, agvId, home, target.x, target.z);
      this.emit({ type: 'path:plan', payload: { agvId, waypoints: inbound.waypoints } });
      if (inbound.obstacle) {
        this.emit({ type: 'obstacle:event', payload: inbound.obstacle });
        this.emitLog('warn', `${agvId} 舱内转场遇障，绕行重规划`);
      }
      await this.driveRoute(agvId, inbound.waypoints, token);

      // 3) 到位推入货位。
      this.emitAgv(agvId, { phase: 'placing', taskId, cargoId, cargoType });
      this.emit({ type: 'cargo:place', payload: { agvId, cargoId, slotId } });
      this.sendCommand({ agvId, type: 'place' });
      await this.sleep(300, token);
      await this.waitCargoAt(probe, cargoId, { x: target.x, y: 0, z: target.z, yaw: 0 }, token, 9000);
      this.emit({ type: 'cargo:state', payload: { cargoId, status: 'placed', slotId, cargoType } });
      this.emitLog('info', `${cargoName} 已推入货位 ${slotId}`);

      // 4) 原路倒车退回舱外待命位（不倒头、不原地掉头）。
      const outbound = this.routeOutbound(cfg, home, target.x, target.z);
      this.emitAgv(agvId, { phase: 'done', taskId, cargoId: null, cargoType: null });
      this.emitLog('info', `${agvId} 原路倒车退出货舱，返回舱外待命位`);
      await this.driveRoute(agvId, outbound, token, true);
      this.emit({ type: 'slot:mark', payload: { slotId, state: 'clear' } });
    } catch (error) {
      if (token.cancelled) return;
      this.emitAgv(agvId, { phase: 'error', taskId, cargoId: null, cargoType: null });
      this.emitTask(taskId, 'failed', 0, `${agvId} 执行异常：${String(error)}`);
      this.emitLog('error', `${agvId} 任务异常：${String(error)}`);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 演示路径编排（全部基于 config 计算）
  // ---------------------------------------------------------------------------

  /**
   * 入舱路线：舱外待命位 → 穿门进舱（正对门洞直线）→ 机头空场转场到目标排 → 目标列前方停位。
   * 转弯交给车端"边走边转 + 最小转弯半径"完成，因此这里只给关键点，不下发掉头动作。
   */
  private routeInbound(
    cfg: CargoConfig,
    agvId: string,
    home: Pose3,
    targetX: number,
    targetZ: number
  ): { waypoints: Pose3[]; obstacle: { agvId: string; pose: Pose3; radius: number } | null } {
    const entry = entryPose(cfg);
    const laneX = frontLaneX(cfg);
    const stopX = targetX - PLACE_PUSH;
    const pts: Array<{ x: number; z: number }> = [
      { x: home.x, z: home.z },
      { x: entry.x, z: entry.z },
      { x: laneX, z: targetZ },
      { x: stopX, z: targetZ }
    ];
    // 侧向障碍演示：只在左舷/中央排的转场侧向放置，保持在航道之外（不阻断路径）。
    const obstacle =
      targetZ > -0.1
        ? { agvId, pose: { x: laneX + 0.6, y: 0, z: targetZ + 1.25, yaw: 0 }, radius: 0.45 }
        : null;
    return { waypoints: this.toPoses(this.filletRoute(pts, TURN_RADIUS), 0), obstacle };
  }

  /** 出舱路线：入舱路线原样反向，由车端倒车沿原路径退出。 */
  private routeOutbound(cfg: CargoConfig, home: Pose3, targetX: number, targetZ: number): Pose3[] {
    const entry = entryPose(cfg);
    const laneX = frontLaneX(cfg);
    const stopX = targetX - PLACE_PUSH;
    const pts: Array<{ x: number; z: number }> = [
      { x: stopX, z: targetZ },
      { x: laneX, z: targetZ },
      { x: entry.x, z: entry.z },
      { x: home.x, z: home.z }
    ];
    // 倒车退出沿用原折线（不再圆角化）：倒车时车尾沿路径走，额外加圆角反而让车尾追不上点位。
    return this.toPoses(pts, home.yaw);
  }

  private toPoses(pts: Array<{ x: number; z: number }>, finalYaw: number): Pose3[] {
    return pts.map((p, index) => {
      const isLast = index === pts.length - 1;
      return { x: p.x, y: 0, z: p.z, yaw: isLast ? finalYaw : headingTo(p, pts[index + 1]) };
    });
  }

  /**
   * 折线圆角化：把每个拐点替换成半径 R 的圆弧采样点。
   * 这样车端按点跟踪时，转向在圆弧上自然发生，不会为"追拐点"而外扩扫到舱壁。
   */
  private filletRoute(pts: Array<{ x: number; z: number }>, radius: number): Array<{ x: number; z: number }> {
    if (pts.length < 3) return pts;
    const out: Array<{ x: number; z: number }> = [pts[0]];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const a = pts[i - 1];
      const p = pts[i];
      const b = pts[i + 1];
      const ux0 = p.x - a.x;
      const uz0 = p.z - a.z;
      const vx0 = b.x - p.x;
      const vz0 = b.z - p.z;
      const l1 = Math.hypot(ux0, uz0);
      const l2 = Math.hypot(vx0, vz0);
      if (l1 < 1e-6 || l2 < 1e-6) {
        out.push(p);
        continue;
      }
      const ux = ux0 / l1;
      const uz = uz0 / l1;
      const vx = vx0 / l2;
      const vz = vz0 / l2;
      const cosT = Math.max(-1, Math.min(1, ux * vx + uz * vz));
      const theta = Math.acos(cosT);
      if (theta < 0.06) {
        out.push(p);
        continue;
      }
      // 切线长度受相邻边长限制，避免圆角吃掉整段直线。
      const tMax = Math.min(l1, l2) * 0.45;
      let tangent = radius * Math.tan(theta / 2);
      let r = radius;
      if (tangent > tMax) {
        r = tMax / Math.tan(theta / 2);
        tangent = r * Math.tan(theta / 2);
      }
      const ex = p.x - ux * tangent;
      const ez = p.z - uz * tangent;
      const xx = p.x + vx * tangent;
      const xz = p.z + vz * tangent;
      // 两个候选圆心（距离 E 点 r、位于法线两侧），取圆弧中点离拐点更近的那个（即内侧）。
      const nx = -uz;
      const nz = ux;
      let best: { cx: number; cz: number; sweep: number; mid: { x: number; z: number } } | null = null;
      for (const sign of [1, -1]) {
        const cx = ex + nx * r * sign;
        const cz = ez + nz * r * sign;
        const a0 = Math.atan2(ez - cz, ex - cx);
        const a1 = Math.atan2(xz - cz, xx - cx);
        let sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        while (sweep < -Math.PI) sweep += Math.PI * 2;
        const mid = { x: cx + Math.cos(a0 + sweep / 2) * r, z: cz + Math.sin(a0 + sweep / 2) * r };
        const dMid = Math.hypot(mid.x - p.x, mid.z - p.z);
        if (!best || dMid < Math.hypot(best.mid.x - p.x, best.mid.z - p.z)) best = { cx, cz, sweep, mid };
      }
      if (!best) {
        out.push(p);
        continue;
      }
      const { cx, cz, sweep } = best;
      const a0 = Math.atan2(ez - cz, ex - cx);
      const steps = Math.max(3, Math.ceil(Math.abs(sweep) / ARC_STEP));
      for (let k = 1; k < steps; k += 1) {
        const ang = a0 + (sweep * k) / steps;
        out.push({ x: cx + Math.cos(ang) * r, z: cz + Math.sin(ang) * r });
      }
      out.push({ x: xx, z: xz });
    }
    out.push(pts[pts.length - 1]);
    return out;
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

  /**
   * 下发整条路径并等待终点到达。
   * 半径受限的车会"擦过"个别圆角采样点，逐点握手会死等；因此一次把路径排入车端队列，
   * 由车端顺序执行（自带卡死跳过保护），调度侧只等最终停位。
   */
  private async driveRoute(agvId: string, waypoints: Pose3[], token: RunToken, reverse = false): Promise<void> {
    if (waypoints.length === 0) return;
    for (const wp of waypoints) {
      if (token.cancelled) return;
      this.sendCommand({ agvId, type: 'moveTo', pose: wp, reverse });
    }
    await this.waitAgvReach(agvId, waypoints[waypoints.length - 1], token);
  }

  /** 等待到达终点：距离达标、或长时间无进展（不再死等，避免整条任务卡住）。 */
  private async waitAgvReach(agvId: string, target: Pose3, token: RunToken): Promise<void> {
    const probe = this.probe();
    const start = Date.now();
    let best = Number.POSITIVE_INFINITY;
    let stall = 0;
    for (;;) {
      if (token.cancelled) return;
      await this.pauseGate(token);
      const pose = probe?.agvPose(agvId);
      if (pose) {
        const d = poseDist(pose, target);
        if (d < 0.5) return;
        if (d < best - 0.05) {
          best = d;
          stall = 0;
        } else {
          stall += POLL_MS;
        }
        if (stall > 6000) {
          this.emitLog('warn', `${agvId} 接近航点受阻（距 ${d.toFixed(1)} m），继续后续动作`);
          return;
        }
      }
      if (Date.now() - start > MAX_LEG_WAIT_MS) {
        this.emitLog('warn', `${agvId} 路径执行超时，继续后续动作`);
        return;
      }
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

/**
 * cargoStore —— 飞机货运 AGV 智能运输系统领域状态（UI/任务/AGV/货物/门/日志的单一镜像）。
 * 数据流：transportBus(下行 AlgorithmEvent) → store.onBusEvent 增量镜像；
 * 用户操作（任务下发/启停/重置/参数）→ store 动作 → transportBus.sendControl(上行)。
 * 场景三维状态由视图层持有并消费同一事件流，本 store 与场景不直接互调。
 */
import { defineStore } from 'pinia';
import type { CargoConfig } from '@/config/cargo';
import { slotIdOf, ULD_META, defaultCargoConfig, mergeCargoConfig } from '@/config/cargo';
import type {
  AgvPhase,
  AlgorithmEvent,
  AlgorithmSourceMode,
  CargoStatus,
  CargoType,
  DoorId,
  DoorState,
  TaskMode,
  TaskStatus
} from '@/types/cargo';
import { agvRoles, fitSlotOf, initialCargoSpecs, parseSlotId, slotCells, slotSpanOf } from '@/utils/layout';
import { formatClock, createId } from '@/utils/time';
import { transportBus } from '@/websocket/TransportMessageBus';

export interface TaskRow {
  taskId: string;
  mode: TaskMode;
  items: Array<{ cargoType: CargoType; slotId: string | null }>;
  status: TaskStatus;
  progress: number;
  message: string;
  time: string;
}

export interface AgvRow {
  id: string;
  name: string;
  role: string;
  phase: AgvPhase;
  taskId: string | null;
  cargoId: string | null;
  cargoType: CargoType | null;
}

export interface CargoRow {
  id: string;
  name: string;
  type: CargoType;
  status: CargoStatus;
  slotId: string | null;
}

export interface LogRow {
  id: string;
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface SlotTile {
  slotId: string;
  side: 'L' | 'R';
  column: number;
  state: 'free' | 'occupied' | 'pending' | 'selected';
}

function cargoNameOf(type: CargoType, id: string): string {
  const matched = /^C(\d+)$/.exec(id);
  return matched ? `${type}-${matched[1]}` : id;
}

function cloneConfig(config: CargoConfig): CargoConfig {
  return JSON.parse(JSON.stringify(config)) as CargoConfig;
}

/** 已放置货物按"列跨度"展开的占用槽位集合（PMX/PAX 占用连续列）。 */
function occupiedSetOf(config: CargoConfig, cargos: CargoRow[]): Set<string> {
  const set = new Set<string>();
  for (const cargo of cargos) {
    if (cargo.status !== 'placed' || !cargo.slotId) continue;
    const parsed = parseSlotId(cargo.slotId);
    if (!parsed) continue;
    const span = slotSpanOf(config, cargo.type);
    for (let k = 0; k < span && parsed.column + k < config.slotCount; k++) {
      set.add(slotIdOf(parsed.side, parsed.column + k));
    }
  }
  return set;
}

/** 某件货物（按列跨度）应预留/释放的槽位 id 列表。 */
function spanSlotIdsOf(config: CargoConfig, type: CargoType, baseSlotId: string): string[] {
  const parsed = parseSlotId(baseSlotId);
  if (!parsed) return [];
  const span = slotSpanOf(config, type);
  const ids: string[] = [];
  for (let k = 0; k < span && parsed.column + k < config.slotCount; k++) {
    ids.push(slotIdOf(parsed.side, parsed.column + k));
  }
  return ids;
}

export const useCargoStore = defineStore('cargo', {
  state: () => ({
    mode: 'mock' as AlgorithmSourceMode,
    connected: false,
    sourceLabel: '演示编排',
    runState: 'idle' as 'idle' | 'running' | 'paused',
    autoDemo: false,
    config: cloneConfig(defaultCargoConfig),
    epoch: 0,
    taskSeq: 0,
    tasks: [] as TaskRow[],
    agvs: [] as AgvRow[],
    cargos: [] as CargoRow[],
    doors: { forward: 'close', aft: 'close' } as Record<DoorId, DoorState>,
    logs: [] as LogRow[],
    pendingSlots: [] as string[],
    selectedSlotId: null as string | null
  }),
  getters: {
    activeTaskCount: (state) => state.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
    doneTaskCount: (state) => state.tasks.filter((t) => t.status === 'done').length,
    agvBusyCount: (state) => state.agvs.filter((a) => a.phase !== 'idle').length,
    /** 本舱货物槽位数（L+R）。 */
    slotCountTotal: (state) => state.config.slotCount * 2,
    freeSlotCount(state): number {
      const occupied = occupiedSetOf(state.config, state.cargos);
      const pending = new Set(state.pendingSlots);
      return slotCells(state.config).filter((c) => !occupied.has(c.slotId) && !pending.has(c.slotId)).length;
    },
    slotTiles(state): SlotTile[] {
      const occupied = occupiedSetOf(state.config, state.cargos);
      const pending = new Set(state.pendingSlots);
      return slotCells(state.config).map((cell) => {
        let tile: SlotTile['state'] = 'free';
        if (occupied.has(cell.slotId)) tile = 'occupied';
        else if (pending.has(cell.slotId)) tile = 'pending';
        if (state.selectedSlotId === cell.slotId) tile = 'selected';
        return { slotId: cell.slotId, side: cell.side, column: cell.column, state: tile };
      });
    },
    canDispatch(state): boolean {
      return state.connected && state.runState === 'running' && this.activeTaskCount === 0 && this.freeSlotCount > 0;
    }
  },
  actions: {
    /** 应用冷启动/模式切换初始化（由视图 onMounted 调用一次）。 */
    boot() {
      this.rebuildAgvRows();
      this.seedCargos();
      this.pushLog('info', '系统初始化完成，演示编排源已就绪');
    },

    connectSource(mode: AlgorithmSourceMode, url?: string) {
      if (mode === 'mock') {
        transportBus.connectSource('mock');
      } else {
        transportBus.connectSource('algorithm', { mode: 'algorithm', transport: 'ws', url });
      }
    },

    /** 由总线状态通知同步（视图订阅 transportBus.subscribeStatus）。 */
    onBusStatus(status: { mode: AlgorithmSourceMode; connected: boolean; label: string }) {
      this.mode = status.mode;
      this.connected = status.connected;
      this.sourceLabel = status.label;
      if (!status.connected && status.mode === 'algorithm') {
        this.runState = 'idle';
      }
    },

    /** 单点入口：消费下行事件更新镜像（SceneCommand 子集由场景消费，此处仅取状态相关）。 */
    onBusEvent(event: AlgorithmEvent) {
      switch (event.type) {
        case 'log':
          this.pushLog(event.payload.level, event.payload.message);
          break;
        case 'task:state': {
          const p = event.payload;
          const row = this.tasks.find((t) => t.taskId === p.taskId);
          if (row) {
            row.status = p.status;
            row.progress = Math.round(p.progress * 100);
            if (p.message) row.message = p.message;
            if (p.status === 'done' || p.status === 'failed' || p.status === 'cancelled') {
              row.items.forEach((item) => item.slotId && this.releaseSpan(item.cargoType, item.slotId));
            }
            if (p.status === 'done' || p.status === 'failed') {
              // 供演示自动续单。
              window.setTimeout(() => this.maybeAutoDispatch(), 600);
            }
          }
          break;
        }
        case 'agv:state': {
          const p = event.payload;
          const row = this.agvs.find((a) => a.id === p.agvId);
          if (row) {
            row.phase = p.phase;
            row.taskId = p.taskId ?? null;
            row.cargoId = p.cargoId ?? null;
            row.cargoType = p.cargoType ?? null;
          }
          break;
        }
        case 'cargo:spawn': {
          const p = event.payload;
          if (!this.cargos.some((c) => c.id === p.cargoId)) {
            this.cargos.push({ id: p.cargoId, name: cargoNameOf(p.cargoType, p.cargoId), type: p.cargoType, status: 'waiting', slotId: null });
          }
          break;
        }
        case 'cargo:state': {
          const p = event.payload;
          const row = this.cargos.find((c) => c.id === p.cargoId);
          if (row) {
            row.status = p.status;
            row.slotId = p.slotId ?? null;
            if (p.cargoType) row.type = p.cargoType;
            if (p.status === 'placed' && p.slotId) {
              // 按列跨度释放预留（宽体货柜占连续列）。
              this.releaseSpan(row.type, p.slotId);
            } else if (p.status !== 'placed') {
              this.releaseOccupied(p.cargoId);
            }
          } else {
            const type = p.cargoType ?? 'AKE';
            this.cargos.push({
              id: p.cargoId,
              name: cargoNameOf(type, p.cargoId),
              type,
              status: p.status,
              slotId: p.slotId ?? null
            });
            if (p.status === 'placed' && p.slotId) this.releaseSpan(type, p.slotId);
          }
          break;
        }
        case 'door:set':
          this.doors[event.payload.doorId] = event.payload.state;
          break;
        case 'scene:reset': {
          // 算法方自持配置并整体重建（覆盖本地布局）。
          const next = event.payload.config;
          this.config = JSON.parse(JSON.stringify(next));
          transportBus.setConfig(this.config);
          this.epoch++;
          this.pendingSlots = [];
          this.seedCargos();
          this.rebuildAgvRows();
          this.doors = { forward: 'close', aft: 'close' };
          this.pushLog('warn', '收到算法端场景重建指令，布局已按算法配置重置');
          break;
        }
        case 'obstacle:event':
          break;
        default:
          break;
      }
    },

    // ------------------------------------------------------------------
    // 场景/会话控制
    // ------------------------------------------------------------------

    /** 整场重置（场景重建由视图 watch config/epoch 触发）。 */
    resetSession() {
      this.stopAutoDemo();
      transportBus.sendControl({ type: 'system:reset' });
      transportBus.setConfig(this.config);
      this.runState = 'idle';
      this.tasks = [];
      this.pendingSlots = [];
      this.doors = { forward: 'close', aft: 'close' };
      this.epoch++;
      this.seedCargos();
      this.logs = [];
      this.pushLog('info', '系统已重置，货舱场景已重建');
    },

    /** 应用参数变更（补丁式合并；触发场景重建并中止当前演示任务）。 */
    applyConfig(patch: Partial<CargoConfig>): boolean {
      const next = mergeCargoConfig(this.config, patch);
      if (JSON.stringify(next) === JSON.stringify(this.config)) return false;
      this.stopAutoDemo();
      transportBus.sendControl({ type: 'config:change', config: next });
      transportBus.setConfig(next);
      this.config = next;
      this.runState = 'idle';
      this.tasks = [];
      this.pendingSlots = [];
      this.doors = { forward: 'close', aft: 'close' };
      this.epoch++;
      this.seedCargos();
      this.rebuildAgvRows();
      this.pushLog('warn', '布局参数已更新，三维场景已按新尺寸重建');
      return true;
    },

    /** 恢复默认参数（等价于带默认值的参数应用）。 */
    resetParams() {
      this.applyConfig(cloneConfig(defaultCargoConfig));
      this.pushLog('info', '已恢复默认布局参数');
    },

    startRun() {
      this.runState = 'running';
      transportBus.sendControl({ type: 'system:start' });
      this.pushLog('info', '系统运行中，可下发装载任务');
      this.maybeAutoDispatch();
    },

    pauseRun() {
      if (this.runState !== 'running') return;
      this.runState = 'paused';
      transportBus.sendControl({ type: 'system:pause' });
    },

    resumeRun() {
      this.runState = 'running';
      transportBus.sendControl({ type: 'system:start' });
    },

    toggleAutoDemo() {
      this.autoDemo = !this.autoDemo;
      if (this.autoDemo && this.runState === 'running') this.maybeAutoDispatch();
    },

    setDoor(doorId: DoorId, state: DoorState) {
      this.doors[doorId] = state;
      transportBus.sendControl({ type: 'door:override', doorId, state });
    },

    selectSlot(slotId: string | null) {
      this.selectedSlotId = slotId;
    },

    // ------------------------------------------------------------------
    // 任务
    // ------------------------------------------------------------------

    /** 候选槽位（含列跨度适配，供下拉选择/自动分配）。 */
    candidateSlots(type: CargoType): string[] {
      const occupied = occupiedSetOf(this.config, this.cargos);
      const pending = new Set(this.pendingSlots);
      const isFree = (slotId: string) => !occupied.has(slotId) && !pending.has(slotId);
      const span = slotSpanOf(this.config, type);
      const result: string[] = [];
      for (const side of ['L', 'R'] as const) {
        for (let start = 0; start + span <= this.config.slotCount; start++) {
          let ok = true;
          for (let c = start; c < start + span; c++) {
            if (!isFree(slotIdOf(side, c))) {
              ok = false;
              break;
            }
          }
          if (ok) result.push(slotIdOf(side, start));
        }
      }
      return result;
    },

    /**
     * 下发装载任务。
     * @param input mode 单/多；type 货型；count 多货物件数；slotId 指定槽位（自动则填 null）。
     */
    dispatchTask(input: { mode: TaskMode; type: CargoType; count?: number; slotId?: string | null }): string | null {
      if (!this.canDispatch) {
        this.pushLog('warn', '当前无法下发任务：请先启动系统并保持空闲');
        return null;
      }
      const items: Array<{ cargoType: CargoType; slotId: string | null }> = [];
      const demoMode = this.mode === 'mock';
      if (!demoMode) {
        // 算法接入模式：槽位决策交给算法方，前端仅声明货型。
        if (input.mode === 'single') {
          items.push({ cargoType: input.type, slotId: null });
        } else {
          const count = Math.max(2, Math.min(6, input.count ?? 3));
          for (let i = 0; i < count; i++) items.push({ cargoType: i % 2 === 0 ? input.type : 'AKE', slotId: null });
        }
      } else {
        const occupied = occupiedSetOf(this.config, this.cargos);
        const isFree = (slotId: string) => !occupied.has(slotId) && !this.pendingSlots.includes(slotId);
        if (input.mode === 'single') {
          const prefer = input.slotId && isFree(input.slotId) ? input.slotId : null;
          const slotId = prefer ?? fitSlotOf(this.config, input.type, isFree, 'L') ?? fitSlotOf(this.config, input.type, isFree, 'R');
          if (!slotId) {
            this.pushLog('warn', `货舱内没有适配 ${ULD_META[input.type].label} 的空闲货位`);
            return null;
          }
          this.reserveSpan(input.type, slotId);
          items.push({ cargoType: input.type, slotId });
        } else {
          const count = Math.max(2, Math.min(6, input.count ?? 3));
          for (let i = 0; i < count; i++) {
            const type = i % 2 === 0 ? input.type : 'AKE';
            const slotId = fitSlotOf(this.config, type, isFree, i % 2 === 0 ? 'L' : 'R');
            if (!slotId) break;
            this.reserveSpan(type, slotId);
            items.push({ cargoType: type, slotId });
          }
          if (items.length < 2) {
            items.forEach((item) => item.slotId && this.releaseSpan(item.cargoType, item.slotId));
            this.pushLog('warn', '空闲货位不足，无法组成多货物同时装载任务');
            return null;
          }
        }
      }

      const taskId = `T-${String(++this.taskSeq).padStart(3, '0')}`;
      this.tasks.unshift({
        taskId,
        mode: input.mode,
        items: [...items],
        status: 'queued',
        progress: 0,
        message: input.mode === 'single' ? '等待执行' : `等待执行（${items.length} 件）`,
        time: formatClock()
      });
      transportBus.sendControl({ type: 'task:dispatch', task: { id: taskId, mode: input.mode, items: [...items] } });
      this.pushLog('info', `任务 ${taskId} 已下发（${input.mode === 'single' ? '单货物' : `多货物 ${items.length} 件`}）`);
      return taskId;
    },

    cancelTask(taskId: string) {
      const row = this.tasks.find((t) => t.taskId === taskId);
      if (!row) return;
      if (row.status === 'queued' || row.status === 'running') {
        transportBus.sendControl({ type: 'task:cancel', taskId });
        row.status = 'cancelled';
        row.message = '已取消';
        row.items.forEach((item) => item.slotId && this.releaseSpan(item.cargoType, item.slotId));
      }
    },

    /** 自动演示：空闲时自动循环下发单/多装载任务。 */
    maybeAutoDispatch() {
      if (!this.autoDemo || this.runState !== 'running' || this.activeTaskCount > 0) return;
      if (this.freeSlotCount === 0) {
        this.autoDemo = false;
        this.pushLog('warn', '货舱货位已满，自动演示停止（可重置后继续）');
        return;
      }
      const round = this.taskSeq;
      const mode: TaskMode = round % 2 === 0 ? 'single' : 'multi';
      const type: CargoType = round % 3 === 0 ? 'PAX' : round % 3 === 1 ? 'PMX' : 'AKE';
      this.dispatchTask({ mode, type, count: 3 });
    },

    // ------------------------------------------------------------------
    // 内部辅助
    // ------------------------------------------------------------------

    rebuildAgvRows() {
      const roles = agvRoles(this.config);
      this.agvs = roles.map((role) => ({
        id: role.id,
        name: `转运AGV ${role.id.replace('AGV-', '')}`,
        role: role.fromColumn === 0 ? '机头空场 · 前舱门装卸' : '机尾空场 · 后舱门装卸',
        phase: 'idle' as AgvPhase,
        taskId: null,
        cargoId: null,
        cargoType: null
      }));
    },

    seedCargos() {
      this.cargos = initialCargoSpecs(this.config).map((spec) => ({
        id: spec.id,
        name: spec.name,
        type: spec.type,
        status: 'placed' as CargoStatus,
        slotId: spec.slotId
      }));
    },

    /** 预留某货件占用的连续列（演示编排期间防重叠）。 */
    reserveSpan(type: CargoType, baseSlotId: string) {
      spanSlotIdsOf(this.config, type, baseSlotId).forEach((id) => {
        if (!this.pendingSlots.includes(id)) this.pendingSlots.push(id);
      });
    },

    /** 释放某货件预留的连续列。 */
    releaseSpan(type: CargoType, baseSlotId: string) {
      spanSlotIdsOf(this.config, type, baseSlotId).forEach((id) => {
        const index = this.pendingSlots.indexOf(id);
        if (index >= 0) this.pendingSlots.splice(index, 1);
      });
    },

    releaseOccupied(cargoId: string) {
      const row = this.cargos.find((c) => c.id === cargoId);
      if (row && row.status !== 'placed') row.slotId = null;
    },

    stopAutoDemo() {
      this.autoDemo = false;
    },

    pushLog(level: 'info' | 'warn' | 'error', message: string) {
      const row: LogRow = { id: createId('log'), time: formatClock(), level, message };
      this.logs = [row, ...this.logs].slice(0, 60);
    }
  }
});

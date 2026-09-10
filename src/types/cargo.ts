/**
 * 飞机货运 AGV 智能运输领域类型（消息契约的唯一依据，见 docs/方案.md §4）。
 * 坐标系（机体右手系，硬约束）：机头为原点 O(0,0,0)，+X 逆航向指向机尾，
 * +Y 竖直向上（地板上表面 Y=0），+Z 指向飞行方向左侧（左舷）。
 * 单位统一为米；与 three.js 场景坐标同构，无需轴重映射。
 * 方向语义：yaw=0 朝向 +X；yaw=+π/2 朝向 -Z；yaw=-π/2 朝向 +Z。
 */

/** 三维位姿（机体坐标系），yaw 为绕 +Y 轴的航向角（弧度）。 */
export interface Pose3 {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** 标准货柜/货盘类型：AKE(LD-3 集装箱)、PMX/PAX(托盘)。 */
export type CargoType = 'AKE' | 'PMX' | 'PAX';

export type DoorId = 'forward' | 'aft';
export type DoorState = 'open' | 'close';

/** 外部算法下发的 AGV 增量指令类型。 */
export type AGVCommandType = 'moveTo' | 'turnTo' | 'stop' | 'pick' | 'place';

export interface AGVCommand {
  agvId: string;
  type: AGVCommandType;
  pose?: Pose3;
  speed?: number;
  /** 指令时间戳（单调递增，用于去重/排序）。 */
  ts: number;
}

/** 货物状态：waiting=待装载(交接位/平台)，inTransit=AGV 载运中，placed=已放入槽位。 */
export type CargoStatus = 'waiting' | 'inTransit' | 'placed';

export interface CargoItem {
  id: string;
  name: string;
  type: CargoType;
  status: CargoStatus;
  slotId: string | null;
  pose: Pose3;
}

/** 算法规划的运行路径（折线点集，含避让绕行点）。 */
export interface PlannedPath {
  agvId: string;
  waypoints: Pose3[];
}

/** 障碍物事件（仅标注展示，避让策略由算法侧给出）。 */
export interface ObstacleEvent {
  agvId: string;
  pose: Pose3;
  radius: number;
}

export interface PickupCommand {
  agvId: string;
  cargoId: string;
}

export interface PlaceCommand {
  agvId: string;
  cargoId: string;
  slotId: string;
}

/** 货物生成（出现在舱门装卸平台/交接位，随后可 cargo:move 送入舱内）。 */
export interface SpawnCargoCommand {
  cargoId: string;
  cargoType: CargoType;
  pose: Pose3;
}

/** 货物在位姿间平移动画（进舱滑入交接位等）。 */
export interface MoveCargoCommand {
  cargoId: string;
  pose: Pose3;
}

/** 场景整体重建（算法方自持配置时可下发，覆盖当前布局）。 */
export interface SceneResetPayload {
  config: import('@/config/cargo').CargoConfig;
}

/** 目标槽位标记（闪烁提示 抵达目标/指派目标）。 */
export interface SlotMarkCommand {
  slotId: string;
  state: 'pending' | 'clear';
}

export interface DoorSetCommand {
  doorId: DoorId;
  state: DoorState;
}

/** 三维场景直接消费的命令联合类型（由算法源/演示编排源发出）。 */
export type SceneCommand =
  | { type: 'scene:reset'; payload: SceneResetPayload }
  | { type: 'agv:command'; payload: AGVCommand }
  | { type: 'cargo:pickup'; payload: PickupCommand }
  | { type: 'cargo:place'; payload: PlaceCommand }
  | { type: 'cargo:spawn'; payload: SpawnCargoCommand }
  | { type: 'cargo:move'; payload: MoveCargoCommand }
  | { type: 'path:plan'; payload: PlannedPath }
  | { type: 'obstacle:event'; payload: ObstacleEvent }
  | { type: 'slot:mark'; payload: SlotMarkCommand }
  | { type: 'door:set'; payload: DoorSetCommand };

// ---------------------------------------------------------------------------
// 任务 / 状态事件 / 上行控制（UI ↔ 算法/演示源，docs/方案.md §4）
// ---------------------------------------------------------------------------

/** 装载模式：单货物装载 / 多货物同时装载。 */
export type TaskMode = 'single' | 'multi';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务中的一件货物：类型 + 目标槽位（槽位由算法/演示编排最终确定；算法接入时可暂缺省）。 */
export interface TransportItem {
  cargoType: CargoType;
  slotId?: string | null;
}

export interface TransportTask {
  id: string;
  mode: TaskMode;
  items: TransportItem[];
}

export interface TaskStateEvent {
  taskId: string;
  status: TaskStatus;
  /** 0..1。 */
  progress: number;
  message?: string;
}

/** AGV 任务/运输阶段（看板展示层，非场景运行时状态）。 */
export type AgvPhase = 'idle' | 'toPickup' | 'pickup' | 'transport' | 'placing' | 'done' | 'error';

export interface AgvStateEvent {
  agvId: string;
  phase: AgvPhase;
  taskId?: string;
  cargoId?: string | null;
  /** 载货类型（有载货时提供，供看板显示）。 */
  cargoType?: CargoType | null;
}

export interface CargoStateEvent {
  cargoId: string;
  status: CargoStatus;
  slotId?: string | null;
  cargoType?: CargoType;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** 下行：算法源 → 前端（场景消费 SceneCommand 子集，store 消费其余子集）。 */
export type AlgorithmEvent =
  | SceneCommand
  | { type: 'task:state'; payload: TaskStateEvent }
  | { type: 'agv:state'; payload: AgvStateEvent }
  | { type: 'cargo:state'; payload: CargoStateEvent }
  | { type: 'log'; payload: LogEvent };

/** 前端 → 算法源/演示源 的控制命令（上行）。 */
export type ControlCommand =
  | { type: 'system:init' }
  | { type: 'system:start' }
  | { type: 'system:pause' }
  | { type: 'system:reset' }
  | { type: 'config:change'; config: import('@/config/cargo').CargoConfig }
  | { type: 'task:dispatch'; task: TransportTask }
  | { type: 'task:cancel'; taskId: string }
  | { type: 'door:override'; doorId: DoorId; state: DoorState };

// ---------------------------------------------------------------------------
// 场景探针（编排源只读查询场景位姿，作指令完成判定）
// ---------------------------------------------------------------------------

export interface SceneProbe {
  agvPose(agvId: string): Pose3 | null;
  cargoPose(cargoId: string): Pose3 | null;
  /** 舱门开启进度 0..1（未接入场景返回 null）。 */
  doorProgress?(doorId: DoorId): number | null;
}

// ---------------------------------------------------------------------------
// 接入源模式
// ---------------------------------------------------------------------------

export type AlgorithmSourceMode = 'mock' | 'algorithm';

export interface AlgorithmSourceSettings {
  mode: AlgorithmSourceMode;
  /** algorithm 模式下的传输通道：目前支持 WS，HTTP 预留。 */
  transport?: 'ws';
  url?: string;
}

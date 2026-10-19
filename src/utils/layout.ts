/**
 * 布局几何纯函数（scene / store / 演示编排 / UI 共用，杜绝各处自行推演产生偏差）。
 * 坐标系：货舱前隔板原点 O，+X 指向机尾，+Z 指向前方左侧（左舷）；单位米。
 * 布局约定（docs/方案.md §2/§6）：
 *  - 货舱地板全宽度可放货：左舷(L) / 中央(C) / 右舷(R) 三排货位，不再为 AGV 预留专用通道；
 *  - 货位从机尾向机头方向（列号由大到小）依次填充，保证机头一侧始终留出 AGV 进出与转向的空场；
 *  - 唯一舱门在右舷（-Z）前段；AGV 在舱门外平台待命，凭任务把货物直接带上车再驶入舱内。
 */
import type { CargoConfig } from '@/config/cargo';
import { slotIdOf } from '@/config/cargo';
import type { CargoType, DoorId, Pose3 } from '@/types/cargo';

export type { SlotSide } from '@/config/cargo';

export interface SlotCell {
  side: 'L' | 'R' | 'C';
  column: number;
  x: number;
  z: number;
  slotId: string;
}

/** 货位排顺序（UI 展示与自动选位顺序）。 */
export const SLOT_SIDE_ORDER = ['L', 'R', 'C'] as const;

/** 某排货位的中心 Z（中央排固定 0，左右两排对称）。 */
export function slotRowZ(config: CargoConfig, side: 'L' | 'R' | 'C'): number {
  if (side === 'C') return 0;
  return side === 'L' ? config.slotZ : -config.slotZ;
}

/** 全量货位格（列升序；同一列内按 L→R→C）。 */
export function slotCells(config: CargoConfig): SlotCell[] {
  const cells: SlotCell[] = [];
  for (let column = 0; column < config.slotCount; column++) {
    const x = config.slotStartX + column * config.slotPitch;
    for (const side of SLOT_SIDE_ORDER) {
      cells.push({ side, column, x, z: slotRowZ(config, side), slotId: slotIdOf(side, column) });
    }
  }
  return cells;
}

/** 解析 SLOT-L-00 / SLOT-R-00 / SLOT-C-00 → 排/列，非法返回 null。 */
export function parseSlotId(slotId: string): { side: 'L' | 'R' | 'C'; column: number } | null {
  const matched = /^SLOT-([LRC])-(\d+)$/.exec(slotId);
  if (!matched) return null;
  return { side: matched[1] as 'L' | 'R' | 'C', column: Number(matched[2]) };
}

export function slotCellOf(config: CargoConfig, slotId: string): SlotCell | null {
  const parsed = parseSlotId(slotId);
  if (!parsed) return null;
  const cell = slotCells(config).find((c) => c.side === parsed.side && c.column === parsed.column);
  return cell ?? null;
}

/** 货物长轴沿 X 时所需的连续列数（演示编排可行性过滤用，非排布算法）。 */
export function slotSpanOf(config: CargoConfig, type: CargoType): number {
  const length = config.uld[type].length;
  return Math.max(1, Math.ceil(length / config.slotPitch - 1e-6));
}

/** 货位区 X 起点（首列外缘）。 */
export function rackXStart(config: CargoConfig): number {
  const cell = slotCells(config)[0];
  return cell ? cell.x - config.uld.AKE.length / 2 : config.slotStartX;
}

/** 货位区 X 终点（末列外缘）。 */
export function rackXEnd(config: CargoConfig): number {
  const cells = slotCells(config);
  const cell = cells[cells.length - 1];
  return cell ? cell.x + config.uld.AKE.length / 2 : config.slotStartX;
}

/** 货物在货位内原地转向时的扫掠半径（半对角线 + 安全余量）。 */
export function cargoSwingRadius(config: CargoConfig, type: CargoType): number {
  const spec = config.uld[type];
  return Math.hypot(spec.length / 2, spec.width / 2) + 0.06;
}

/**
 * 该货型允许放置的货位排：排中心到侧壁内沿的净距必须 ≥ 扫掠半径，
 * 否则载货 AGV 在两侧排转弯/对位时会扫到舱壁（AGV 与货物穿墙）。
 * 默认参数下：AKE 三排都可放；PMX/PAX 只能放中央排。
 */
export function rowsForCargo(config: CargoConfig, type: CargoType): Array<'L' | 'R' | 'C'> {
  const swing = cargoSwingRadius(config, type);
  const wallInnerZ = config.hold.floorWidth / 2;
  const rows = SLOT_SIDE_ORDER.filter((side) => wallInnerZ - Math.abs(slotRowZ(config, side)) >= swing);
  return rows.length > 0 ? [...rows] : ['C'];
}

/**
 * 候选货位：给定类型与占用判定，按 `preferSide` 优先，**列号由大到小**（机尾→机头）扫描，
 * 返回首个连续空列适配的货位 id（演示层使用）。
 *
 * 为什么从机尾往机头填：AGV 只能从前舱门进舱，从机头一侧的空场接近目标列。
 * 由机尾向机头填充可保证"目标列之前（更靠机头）的货位始终是空的"，
 * 于是 AGV 进出路径永远只经过空货位，不会压到已装货柜。
 */
export function fitSlotOf(
  config: CargoConfig,
  type: CargoType,
  isFree: (slotId: string) => boolean,
  preferSide?: 'L' | 'R' | 'C',
  sides: Array<'L' | 'R' | 'C'> = [...SLOT_SIDE_ORDER]
): string | null {
  const span = slotSpanOf(config, type);
  const columns = config.slotCount;
  const order: Array<'L' | 'R' | 'C'> = preferSide
    ? [preferSide, ...sides.filter((s) => s !== preferSide)]
    : [...sides];
  for (const side of order) {
    if (!sides.includes(side)) continue;
    for (let start = columns - span; start >= 0; start -= 1) {
      let ok = true;
      for (let c = start; c < start + span; c++) {
        if (!isFree(slotIdOf(side, c))) {
          ok = false;
          break;
        }
      }
      if (ok) return slotIdOf(side, start);
    }
  }
  return null;
}

/** 舱门洞 X 窗口 [minX, maxX]。 */
export function doorWindowX(config: CargoConfig, doorId: DoorId): { minX: number; maxX: number } {
  const door = config.doors[doorId];
  return { minX: door.x - door.width / 2, maxX: door.x + door.width / 2 };
}

/** 右舷侧壁外沿 Z。 */
export function starboardOuterZ(config: CargoConfig): number {
  return -(config.hold.floorWidth / 2 + config.hold.wallThickness);
}

/** 舱内入口位（门内侧一点，穿过门洞后的落脚点）。 */
export function entryPose(config: CargoConfig, doorId: DoorId = 'forward'): Pose3 {
  return { x: config.doors[doorId].x, y: 0, z: -1.0, yaw: 0 };
}

/** 舱外装卸平台中心位（AGV 待命/取货起点；平台顶面与货舱地板同高）。 */
export function dockPose(config: CargoConfig, doorId: DoorId = 'forward'): Pose3 {
  return {
    x: config.doors[doorId].x,
    y: 0,
    z: starboardOuterZ(config) - 1.2,
    yaw: -Math.PI / 2
  };
}

/** 舱内机头空场中的“横向转场线”X：AGV 在此完成跨排横移，保证不穿越货位区。 */
export function frontLaneX(config: CargoConfig): number {
  return Math.max(config.doors.forward.x + 0.6, rackXStart(config) - 1.2);
}

/** 入位前的推送间距：AGV 停在目标列前方该距离处，货物沿 +X 推入货位。
 *  取 2.2 m 以留出"AGV 车体 + 货物半长"的净距，避免停位时外廓压到目标货位。 */
export const PLACE_PUSH = 2.2;

export interface AgvRole {
  id: string;
  home: Pose3;
  /** 看板展示用职责说明。 */
  roleLabel: string;
}

/**
 * AGV 角色与待命位：全部在前舱门外平台，**沿门洞宽度方向并排**待命（车头朝舱门 +Z）。
 * 为什么并排而不是前后排：两台车若在同一条进出线上，后车出库必然从候车车里穿过去。
 * 并排后各自进出互不占位（间距 1.4 m，车宽 1.1 m，留 0.3 m 余量）。
 */
export function agvRoles(config: CargoConfig): AgvRole[] {
  const roles: AgvRole[] = [];
  const count = Math.max(1, Math.min(4, Math.round(config.agv.count)));
  const doorX = config.doors.forward.x;
  const dock = dockPose(config);
  for (let i = 0; i < count; i += 1) {
    // 以门洞中心对称排布；间距按门洞宽度限制，保证所有待命位都在门洞投影内（≤±0.75 m）。
    const step = count > 1 ? Math.min(1.4, 1.5 / (count - 1)) : 0;
    const offset = (i - (count - 1) / 2) * step;
    roles.push({
      id: `AGV-${String(i + 1).padStart(2, '0')}`,
      home: { x: doorX + offset, y: 0, z: dock.z, yaw: dock.yaw },
      roleLabel: '舱外待命 · 前舱门装卸'
    });
  }
  return roles;
}

/** 初始装载规格（场景构建与 store 镜像共用，保证单一来源）。 */
export function initialCargoSpecs(config: CargoConfig): Array<{ id: string; name: string; type: CargoType; slotId: string }> {
  const specs: Array<{ id: string; name: string; type: CargoType; slotId: string }> = [];
  const perSide = Math.min(config.initialAkePerSide, config.slotCount);
  // 初始装载放在机尾一侧（列号大的端），把机头一侧空场留给 AGV 进出与转场。
  for (const side of ['L', 'R'] as const) {
    for (let k = 0; k < perSide; k += 1) {
      const column = config.slotCount - 1 - k;
      specs.push({
        id: `SEED-AKE-${side}-${column}`,
        name: `AKE-${side}${String(column + 1).padStart(2, '0')}`,
        type: 'AKE',
        slotId: slotIdOf(side, column)
      });
    }
  }
  return specs;
}

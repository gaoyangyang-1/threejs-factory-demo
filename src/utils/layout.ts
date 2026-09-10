/**
 * 布局几何纯函数（scene / store / 演示编排 / UI 共用，杜绝各处自行推演产生偏差）。
 * 坐标系：机头原点 O，+X 机尾向，+Z 左舷；单位米。
 * 布局约定见 docs/方案.md §2/§6：
 *  - 槽位每侧一排（列心 Z=±slotZ），首列 X=slotStartX，列距 slotPitch；
 *  - 槽位区之前/之后为机头/机尾空场（装卸交接、AGV 驻泊、转向、避障演示）；
 *  - 舱门均位于右舷（-Z）侧壁，装卸交接位在门内侧 X=门心、Z=-1.0。
 */
import type { CargoConfig } from '@/config/cargo';
import { slotIdOf } from '@/config/cargo';
import type { CargoType, DoorId, Pose3 } from '@/types/cargo';

export interface SlotCell {
  side: 'L' | 'R';
  column: number;
  x: number;
  z: number;
  slotId: string;
}

/** 全量槽位格（列升序，每列 L 在 R 前）。 */
export function slotCells(config: CargoConfig): SlotCell[] {
  const cells: SlotCell[] = [];
  for (let column = 0; column < config.slotCount; column++) {
    const x = config.slotStartX + column * config.slotPitch;
    cells.push({ side: 'L', column, x, z: config.slotZ, slotId: slotIdOf('L', column) });
    cells.push({ side: 'R', column, x, z: -config.slotZ, slotId: slotIdOf('R', column) });
  }
  return cells;
}

/** 解析 SLOT-L-00 / SLOT-R-00 → 侧/列，非法返回 null。 */
export function parseSlotId(slotId: string): { side: 'L' | 'R'; column: number } | null {
  const matched = /^SLOT-([LR])-(\d+)$/.exec(slotId);
  if (!matched) return null;
  return { side: matched[1] as 'L' | 'R', column: Number(matched[2]) };
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

/** 槽位区 X 范围（外缘）。 */
export function rackXStart(config: CargoConfig): number {
  const cell = slotCells(config)[0];
  return cell ? cell.x - config.uld.AKE.length / 2 : config.slotStartX;
}

export function rackXEnd(config: CargoConfig): number {
  const cells = slotCells(config);
  const cell = cells[cells.length - 1];
  return cell ? cell.x + config.uld.AKE.length / 2 : config.slotStartX;
}

/**
 * 候选槽位：给定类型与占用判定，返回首个连续空列适配且侧向偏好满足的槽位 id（演示层使用）。
 * isFree(slotId) 由调用方（store 占用镜像）提供。
 */
export function fitSlotOf(
  config: CargoConfig,
  type: CargoType,
  isFree: (slotId: string) => boolean,
  preferSide?: 'L' | 'R'
): string | null {
  const span = slotSpanOf(config, type);
  const columns = config.slotCount;
  const sides: Array<'L' | 'R'> = preferSide ? [preferSide, preferSide === 'L' ? 'R' : 'L'] : ['L', 'R'];
  for (const side of sides) {
    for (let start = 0; start + span <= columns; start++) {
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

/** 舱内交接位（门内侧，货物进舱后的停留/取货点）。 */
export function handoffPose(config: CargoConfig, doorId: DoorId): Pose3 {
  return { x: config.doors[doorId].x, y: 0, z: -1.0, yaw: 0 };
}

/** 门外装卸平台位（货物生成起点；平台顶面与货舱地板同高 Y=0）。 */
export function platformPose(config: CargoConfig, doorId: DoorId): Pose3 {
  return {
    x: config.doors[doorId].x,
    y: 0,
    z: starboardOuterZ(config) - 1.05,
    yaw: 0
  };
}

export interface AgvRole {
  id: string;
  home: Pose3;
  /** 服务槽位列范围（半开区间 [fromColumn, toColumn)），按门分工。 */
  fromColumn: number;
  toColumn: number;
}

/** AGV 分工与驻泊位：前半台数驻机头空场（前门装卸），其余驻机尾空场（后门装卸）。 */
export function agvRoles(config: CargoConfig): AgvRole[] {
  const roles: AgvRole[] = [];
  const count = Math.max(1, Math.round(config.agv.count));
  const frontCount = Math.ceil(count / 2);
  const half = config.slotCount / 2;
  for (let i = 0; i < count; i++) {
    const isFront = i < frontCount;
    const doorX = config.doors[isFront ? 'forward' : 'aft'].x;
    const lane = i - (isFront ? 0 : frontCount);
    const z = lane === 0 ? 0 : lane % 2 === 0 ? -0.55 * lane : 0.55 * lane;
    const x = isFront
      ? Math.max(0.7, doorX - 2.6)
      : Math.min(config.hold.length - 0.7, doorX + 2.2);
    roles.push({
      id: `AGV-${String(i + 1).padStart(2, '0')}`,
      home: { x, y: 0, z, yaw: isFront ? 0 : Math.PI },
      fromColumn: isFront ? 0 : Math.ceil(half),
      toColumn: isFront ? Math.ceil(half) : config.slotCount
    });
  }
  return roles;
}

/** 台 AGV 是否服务指定槽位列。 */
export function agvServesColumn(role: AgvRole, column: number): boolean {
  return column >= role.fromColumn && column < role.toColumn;
}

/** 初始装载规格（场景构建与 store 镜像共用，保证单一来源）。 */
export function initialCargoSpecs(config: CargoConfig): Array<{ id: string; name: string; type: CargoType; slotId: string }> {
  const specs: Array<{ id: string; name: string; type: CargoType; slotId: string }> = [];
  const perSide = Math.min(config.initialAkePerSide, config.slotCount);
  for (let column = 0; column < perSide; column++) {
    for (const side of ['L', 'R'] as const) {
      const id = `SEED-AKE-${side}-${column}`;
      specs.push({ id, name: `AKE-${side}${String(column + 1).padStart(2, '0')}`, type: 'AKE', slotId: slotIdOf(side, column) });
    }
  }
  return specs;
}

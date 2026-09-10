/**
 * 货舱/AGV/货物尺寸与布局默认参数（单点定义，支持 UI 动态修改并同步重建三维场景）。
 * 坐标系：机头原点 O，+X 指向机尾，+Y 向上，+Z 指向飞行方向左侧（左舷）。
 * 尺寸默认值见 docs/方案.md §2（米；ULD 数据按毫米换算）。
 * 舱门均位于右舷（-Z 侧壁），与真实货机惯例一致。
 */
import type { CargoType } from '@/types/cargo';

export interface UldSpec {
  /** 轴向 X 长度(m)。 */
  length: number;
  /** 横向 Z 宽度(m)。 */
  width: number;
  /** 高度 Y(m)。 */
  height: number;
}

export interface DoorSpec {
  /** 门中心沿机身轴向 X 位置(m)。 */
  x: number;
  /** 门洞宽度(沿 X，m)。 */
  width: number;
  /** 门洞高度(沿 Y，m)。 */
  height: number;
}

export interface CargoConfig {
  /** 货舱尺寸。length 起于机头 X=0，止于机尾 X=length。 */
  hold: {
    length: number;
    floorWidth: number;
    /** 舱壁高度（自地板向上）。 */
    wallHeight: number;
    /** 舱壁厚度(m)，决定侧壁外沿 Z 坐标。 */
    wallThickness: number;
  };
  /** 中央 AGV 通道半宽(±Z，油漆示意)。 */
  aisleHalfWidth: number;
  /** 单侧 rack 槽位排中心 Z。 */
  slotZ: number;
  /** 槽位轴向间距。 */
  slotPitch: number;
  /** 槽位首列 X 起点（其后为机头空场，前为装卸/驻泊/避障区）。 */
  slotStartX: number;
  /** 槽位列数（每侧）。 */
  slotCount: number;
  /** 初始装载 AKE 数（每侧，自机头方向起算）。 */
  initialAkePerSide: number;
  doors: {
    forward: DoorSpec;
    aft: DoorSpec;
  };
  agv: {
    count: number;
    /** 车体长(X)×宽(Z)×高(Y)。 */
    length: number;
    width: number;
    height: number;
    /** 顶升台抬升行程。 */
    liftHeight: number;
    /** 默认巡航速度(m/s)。 */
    speed: number;
  };
  /** 三种标准货柜尺寸（AKE 采用 IATA LD-3 标准，PMX/PAX 为可配置近似值）。 */
  uld: Record<CargoType, UldSpec>;
}

export const defaultCargoConfig: CargoConfig = {
  hold: {
    length: 24,
    floorWidth: 6.8,
    wallHeight: 2.6,
    wallThickness: 0.18
  },
  aisleHalfWidth: 1.15,
  slotZ: 2.2,
  slotPitch: 1.72,
  slotStartX: 6.8,
  slotCount: 6,
  initialAkePerSide: 2,
  doors: {
    // 均位于右舷 -Z 侧壁。
    forward: { x: 4.4, width: 2.6, height: 2.0 },
    aft: { x: 19.2, width: 2.6, height: 2.0 }
  },
  agv: {
    count: 2,
    length: 1.75,
    width: 1.1,
    height: 0.52,
    liftHeight: 0.35,
    speed: 1.6
  },
  uld: {
    AKE: { length: 1.562, width: 1.534, height: 1.626 },
    PMX: { length: 2.438, width: 1.98, height: 1.63 },
    PAX: { length: 2.235, width: 1.524, height: 1.6 }
  }
};

export const ULD_TYPES: CargoType[] = ['AKE', 'PMX', 'PAX'];

export interface UldMeta {
  label: string;
  short: string;
  color: string;
}

/** UI/展示用元信息（中文名 + 主题色）。 */
export const ULD_META: Record<CargoType, UldMeta> = {
  AKE: { label: 'AKE 集装箱(LD-3)', short: 'AKE', color: '#3b82f6' },
  PMX: { label: 'PMX 半尺寸托盘', short: 'PMX', color: '#22b573' },
  PAX: { label: 'PAX 标准托盘', short: 'PAX', color: '#ffab2e' }
};

export const DOOR_LABEL: Record<'forward' | 'aft', string> = {
  forward: '前货舱门',
  aft: '后货舱门'
};

/** 浅合并配置，保证缺省字段回落默认值。 */
export function mergeCargoConfig(base: CargoConfig, patch: Partial<CargoConfig> | null | undefined): CargoConfig {
  if (!patch) return base;
  const next: CargoConfig = { ...base, ...patch };
  // 嵌套对象按层合并。
  if (patch.hold) next.hold = { ...base.hold, ...patch.hold };
  if (patch.doors) {
    next.doors = {
      forward: { ...base.doors.forward, ...patch.doors.forward },
      aft: { ...base.doors.aft, ...patch.doors.aft }
    };
  }
  if (patch.agv) next.agv = { ...base.agv, ...patch.agv };
  if (patch.uld) {
    next.uld = {
      AKE: { ...base.uld.AKE, ...patch.uld.AKE },
      PMX: { ...base.uld.PMX, ...patch.uld.PMX },
      PAX: { ...base.uld.PAX, ...patch.uld.PAX }
    };
  }
  return next;
}

/** 由列号生成 rack 槽位 id：SLOT-L-01 / SLOT-R-01。 */
export function slotIdOf(side: 'L' | 'R', column: number): string {
  return `SLOT-${side}-${String(column).padStart(2, '0')}`;
}

/** 槽位占用区半宽（稍大于 AKE 半长，用于高亮格显示）。 */
export const slotHalfSpan = 0.85;

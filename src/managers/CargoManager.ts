/**
 * 货物(ULD: AKE/PMX/PAX)管理器。
 * 负责按参数创建标准货柜网格、管理双侧 rack 槽位占用、提供 pick/place 时场景与 AGV 载货挂点间的移交方法。
 * 本身不含排列/调度算法——"放哪个槽位"由算法消息(cargo:place)给定或通过 findFreeSlot 提供候选。
 */
import * as THREE from 'three';
import type { CargoConfig } from '@/config/cargo';
import { slotIdOf, slotHalfSpan } from '@/config/cargo';
import type { CargoItem, CargoType, Pose3 } from '@/types/cargo';

const ULD_COLOR: Record<CargoType, number> = {
  AKE: 0x3b82f6,
  PMX: 0x22b573,
  PAX: 0xffab2e
};

const ULD_EDGE: Record<CargoType, number> = {
  AKE: 0x1e5fd6,
  PMX: 0x15935c,
  PAX: 0xdd8b00
};

export interface CargoMeshGroup extends THREE.Group {
  userData: { type: 'cargo'; id: string; cargoType: CargoType };
}

interface SlotPose {
  side: 'L' | 'R';
  column: number;
  x: number;
  z: number;
}

export class CargoManager {
  readonly group = new THREE.Group();
  readonly cargo = new Map<string, CargoMeshGroup>();
  /** slotId -> cargoId 占用表。 */
  readonly occupancy = new Map<string, string>();
  /** 槽位占用/空闲共享状态，供调度侧查询候选（外部算法通过 API 决策）。 */
  private readonly slotPoses: SlotPose[] = [];

  constructor(private readonly config: CargoConfig) {
    this.group.name = 'CargoManager';
    for (let column = 0; column < config.slotCount; column++) {
      const x = config.slotStartX + column * config.slotPitch;
      this.slotPoses.push({ side: 'L', column, x, z: config.slotZ });
      this.slotPoses.push({ side: 'R', column, x, z: -config.slotZ });
    }
  }

  get count(): number {
    return this.cargo.size;
  }

  getSlotPose(slotId: string): { x: number; z: number; yaw: number } | null {
    const parsed = this.parseSlotId(slotId);
    if (!parsed) return null;
    return { x: parsed.x, z: parsed.z, yaw: parsed.side === 'L' ? 0 : 0 };
  }

  isSlotFree(slotId: string): boolean {
    return !this.occupancy.has(slotId);
  }

  findFreeSlot(side?: 'L' | 'R'): string | null {
    const filtered = side ? this.slotPoses.filter((slot) => slot.side === side) : this.slotPoses;
    const free = filtered.find((slot) => !this.occupancy.has(slotIdOf(slot.side, slot.column)));
    return free ? slotIdOf(free.side, free.column) : null;
  }

  /** 按槽位生成世界坐标落位（货物长轴沿 X，中心贴槽位中心）。 */
  placeCargo(cargoId: string, cargoType: CargoType, slotId: string): CargoMeshGroup | null {
    const slot = this.getSlotPose(slotId);
    if (!slot) return null;
    const mesh = this.createCargoMesh(cargoId, cargoType);
    mesh.position.set(slot.x, 0, slot.z);
    this.group.add(mesh);
    this.occupancy.set(slotId, cargoId);
    this.cargo.set(cargoId, mesh);
    return mesh;
  }

  /** 算法给定任意位姿时，直接摆放（例：舱门装载台待取）。pose.y 为箱底高度。 */
  placeCargoAtPose(cargoId: string, cargoType: CargoType, pose: Pose3): CargoMeshGroup {
    const mesh = this.createCargoMesh(cargoId, cargoType);
    mesh.position.set(pose.x, pose.y, pose.z);
    mesh.rotation.y = pose.yaw;
    this.group.add(mesh);
    this.cargo.set(cargoId, mesh);
    return mesh;
  }

  /** 卸货(place 完成)登记：货物被 AGV 带到目标槽位后落到 floor 上，更新占用表。 */
  finalizePlace(cargoId: string, slotId: string): void {
    this.occupancy.set(slotId, cargoId);
  }

  /** 清除指定货物所占槽位占用记录（如从槽位取货交给 AGV 时）。 */
  releaseOccupancy(cargoId: string): void {
    for (const [slotId, id] of this.occupancy) {
      if (id === cargoId) this.occupancy.delete(slotId);
    }
  }

  /** 从 floor 移除并交给 AGV（pick）。返回 cargo mesh 组。 */
  takeFromSlot(cargoId: string): { mesh: CargoMeshGroup; slotId: string | null } | null {
    const mesh = this.cargo.get(cargoId);
    if (!mesh) return null;
    let slotId: string | null = null;
    this.occupancy.forEach((id, key) => {
      if (id === cargoId) slotId = key;
    });
    if (slotId) this.occupancy.delete(slotId);
    return { mesh, slotId };
  }

  removeCargo(cargoId: string): void {
    const mesh = this.cargo.get(cargoId);
    if (!mesh) return;
    mesh.traverse((object) => {
      const m = object as THREE.Mesh;
      m.geometry?.dispose();
      const material = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
    this.group.remove(mesh);
    this.cargo.delete(cargoId);
  }

  createCargoMesh(cargoId: string, cargoType: CargoType): CargoMeshGroup {
    const spec = this.config.uld[cargoType];
    const length = spec.length;
    const width = spec.width;
    const height = spec.height;

    const root = new THREE.Group() as CargoMeshGroup;
    root.name = cargoId;
    root.userData = { type: 'cargo', id: cargoId, cargoType };

    const color = ULD_COLOR[cargoType];
    const edgeColor = ULD_EDGE[cargoType];

    // 主体：底部到顶部完整箱体。
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(length, height, width),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: 0.2,
        transparent: true,
        opacity: 0.92
      })
    );
    body.position.y = height / 2;
    body.castShadow = true;
    body.receiveShadow = true;

    // 顶部斜面示意：AKE 为斜角集装箱、PMX/PAX 为平顶。用楔形体表示斜面结构。
    const wedgeMat = new THREE.MeshStandardMaterial({ color: ULD_COLOR[cargoType], roughness: 0.6 });
    const slope = new THREE.Mesh(
      new THREE.CylinderGeometry(width / 2, width / 2, 0.1, 4),
      wedgeMat
    );
    slope.visible = false;

    // 轮廓线框（标准柜金属框视觉效果）。
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(length, height, width)),
      new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.9 })
    );
    edges.position.y = height / 2;

    // 底面托盘示意。
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(length + 0.06, 0.05, width + 0.06),
      new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.7, roughness: 0.3 })
    );
    tray.position.y = 0.025;

    root.add(body, edges, tray, slope);
    return root;
  }

  /** 生成槽位占用(已装)/空闲(可用)格，供场景高亮。 */
  createSlotHighlight(): THREE.Group {
    const group = new THREE.Group();
    const matFree = new THREE.MeshBasicMaterial({ color: 0x1d8fff, transparent: true, opacity: 0.12 });
    const matTaken = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0 });
    for (const slot of this.slotPoses) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(slotHalfSpan * 2, slotHalfSpan * 2), matFree);
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(slot.x, 0.012, slot.z);
      tile.userData = { type: 'slot-highlight', side: slot.side, column: slot.column };
      group.add(tile);
    }
    void matTaken;
    return group;
  }

  private parseSlotId(slotId: string): SlotPose | null {
    const matched = /^SLOT-([LR])-(\d+)$/.exec(slotId);
    if (!matched) return null;
    const side = matched[1] as 'L' | 'R';
    const column = Number(matched[2]);
    const slot = this.slotPoses.find((item) => item.side === side && item.column === column);
    return slot ?? null;
  }

  dispose(): void {
    [...this.cargo.keys()].forEach((id) => this.removeCargo(id));
    this.occupancy.clear();
  }
}

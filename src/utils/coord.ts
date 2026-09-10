/**
 * 坐标与单位换算工具。
 * 场景坐标即机体坐标（右手系，+X 逆航向，+Y 上，+Z 向左舷，1 单位 = 1 米）。
 * 本模块作为 Pose/方向/毫米 换算的唯一入口，避免各模块各自实现产生偏差。
 */
import * as THREE from 'three';
import type { Pose3 } from '@/types/cargo';

const DEG = Math.PI / 180;

/** 归一化航向角到 [-PI, PI]。 */
export function normalizeYaw(yaw: number): number {
  let value = yaw;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

/** 最短角差（-PI, PI]。 */
export function yawDelta(from: number, to: number): number {
  return normalizeYaw(to - from);
}

/** 由位姿新建 Object3D（位置 + 绕 Y 偏航）。 */
export function applyPose(object: THREE.Object3D, pose: Pose3, liftY = 0): void {
  object.position.set(pose.x, pose.y + liftY, pose.z);
  object.rotation.set(0, pose.yaw, 0);
}

/** 向量构造位姿。 */
export function poseFromObject3D(object: THREE.Object3D): Pose3 {
  return {
    x: object.position.x,
    y: object.position.y,
    z: object.position.z,
    yaw: object.rotation.y
  };
}

export interface PoseLike {
  x: number;
  y: number;
  z: number;
}

/** 毫米 → 米。 */
export function mm(value: number): number {
  return value / 1000;
}

export function dist2D(a: PoseLike, b: PoseLike): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** 依据目标朝向做单位化转向补偿，生成带朝向的平面移动步进。 */
export function stepToward(current: PoseLike, target: PoseLike, maxDistance: number, targetYaw?: number): { dx: number; dz: number; dYaw: number } {
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const dYaw = targetYaw === undefined ? 0 : 0;
  if (distance < 1e-5) {
    return { dx: 0, dz: 0, dYaw };
  }
  const ratio = Math.min(1, maxDistance / distance);
  return { dx: dx * ratio, dz: dz * ratio, dYaw };
}

export { DEG };

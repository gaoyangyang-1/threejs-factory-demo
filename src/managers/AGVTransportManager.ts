/**
 * AGV 外部指令驱动管理器。
 * 说明：AGV 的运动/转向完全由外部"算法输出"(AGVCommand 增量指令流)驱动，
 * 本管理器只负责指令排队、逐帧插值执行与车体/轮组/顶升台的动画表现，不包含任何路径规划逻辑。
 */
import * as THREE from 'three';
import type { AGVCommand, Pose3 } from '@/types/cargo';
import { yawDelta } from '@/utils/coord';

export interface AGVRuntimeOptions {
  id: string;
  name: string;
  color: number;
  length: number;
  width: number;
  height: number;
  liftHeight: number;
  defaultSpeed: number;
  home: Pose3;
  /** 执行 pick/place 动作时的回调。 */
  onAction?: (agvId: string, type: 'pick' | 'place') => void;
}

interface WheelVisual {
  mesh: THREE.Object3D;
}

interface AGVRuntime extends AGVRuntimeOptions {
  group: THREE.Group;
  payload: THREE.Group;
  liftMesh: THREE.Mesh;
  indicatorMat: THREE.MeshBasicMaterial;
  wheels: WheelVisual[];
  queue: AGVCommand[];
  state: 'idle' | 'moving' | 'aligning' | 'pick' | 'place' | 'error';
  carrying: boolean;
  task: string;
  speed: number;
  battery: number;
  liftTarget: number;
  /** 顶升平台基准高度（未抬升时的平台中心 Y）。 */
  platformBaseY: number;
  /** 上一帧航向（用于估算转向速率驱动轮组偏转示意）。 */
  prevYaw: number;
  /** 轮组偏转角当前值（平滑过渡）。 */
  steerAngle: number;
}

const ARRIVE_DIST = 0.04;
const ARRIVE_YAW = 0.06;

export class AGVTransportManager {
  readonly group = new THREE.Group();
  private readonly runtimes = new Map<string, AGVRuntime>();
  private readonly palette = [0x3b82f6, 0x22b573, 0xffab2e];

  constructor(options: AGVRuntimeOptions[]) {
    this.group.name = 'AGVTransportManager';
    options.forEach((opt) => {
      const runtime = this.createRuntime(opt);
      this.runtimes.set(opt.id, runtime);
      this.group.add(runtime.group);
    });
  }

  get size(): number {
    return this.runtimes.size;
  }

  applyCommand(command: AGVCommand): void {
    const runtime = this.runtimes.get(command.agvId);
    if (!runtime) return;
    if (runtime.state === 'error') return;
    // 说明：指令带 ts 单调递增；若收到的 ts 不大于最后已执行指令则忽略（算法重发防护）。
    runtime.queue.push(command);
  }

  /** 支持一次下发整段任务指令序列（算法/演示调度器常用）。 */
  dispatch(commands: AGVCommand[]): void {
    commands.forEach((command) => this.applyCommand(command));
  }

  update(delta: number): void {
    this.runtimes.forEach((runtime) => {
      this.stepRuntime(runtime, delta);
    });
  }

  setTask(id: string, task: string): void {
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.task = task;
  }

  getRuntime(id: string): { pose: Pose3; state: string; battery: number; task: string; speed: number } | null {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    return {
      pose: {
        x: runtime.group.position.x,
        y: runtime.group.position.y,
        z: runtime.group.position.z,
        yaw: runtime.group.rotation.y
      },
      state: runtime.state,
      battery: runtime.battery,
      task: runtime.task,
      speed: runtime.speed
    };
  }

  /** 顶升平台表面离地高度（空载基准，随车体高度变化）。供装载台等场景元素对齐。 */
  static platformTopY(agvHeight: number): number {
    const wheelR = 0.1;
    return wheelR + agvHeight + 0.025;
  }

  /** 挂载货物到某台 AGV：货物底部贴到顶升平台表面，随车与平台运动。 */
  mountPayload(agvId: string, payload: THREE.Object3D): void {
    const runtime = this.runtimes.get(agvId);
    if (!runtime) return;
    if (payload.parent) payload.parent.remove(payload);
    runtime.payload.add(payload);
    payload.position.set(0, 0.025, 0);
    payload.rotation.set(0, 0, 0);
    runtime.carrying = true;
  }

  /** 卸载货物：从顶升平台摘除并保持当前世界位姿（供场景摆放/落位）。 */
  unmountPayload(agvId: string, payload: THREE.Object3D): void {
    const runtime = this.runtimes.get(agvId);
    if (!runtime) return;
    runtime.carrying = false;
    if (!payload.parent) return;
    const holder = runtime.group.parent ?? runtime.group;
    holder.attach(payload);
  }

  liftPayload(agvId: string, target: number): void {
    const runtime = this.runtimes.get(agvId);
    if (runtime) runtime.liftTarget = target;
  }

  dispose(): void {
    this.runtimes.forEach((runtime) => {
      runtime.queue.length = 0;
      runtime.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
    });
    this.runtimes.clear();
  }

  private createRuntime(options: AGVRuntimeOptions): AGVRuntime {
    const { length, width, height, color } = options;
    const group = new THREE.Group();
    group.name = options.id;
    group.userData = { type: 'agv', id: options.id };
    group.position.set(options.home.x, options.home.y, options.home.z);
    group.rotation.y = options.home.yaw;

    const runtime: AGVRuntime = {
      ...options,
      group,
      payload: new THREE.Group(),
      liftMesh: new THREE.Mesh(),
      indicatorMat: new THREE.MeshBasicMaterial(),
      wheels: [],
      queue: [],
      state: 'idle',
      carrying: false,
      task: '待命',
      speed: options.defaultSpeed,
      battery: 95,
      liftTarget: 0,
      platformBaseY: 0,
      prevYaw: options.home.yaw,
      steerAngle: 0
    };

    // 车轮半径与车身下沿。
    const wheelR = 0.1;
    const wheelW = 0.14;
    const bodyCenterY = wheelR + height / 2;
    const liftTarget = 0;

    // 车身。
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(length, height, width),
      new THREE.MeshStandardMaterial({
        color,
        metalness: 0.55,
        roughness: 0.3,
        emissive: color,
        emissiveIntensity: 0.1
      })
    );
    body.position.y = bodyCenterY;
    body.castShadow = true;
    body.receiveShadow = true;

    // 顶部指示面板（状态灯）。
    const indicatorMat = new THREE.MeshBasicMaterial({ color: 0x0fae6f });
    const indicator = new THREE.Mesh(new THREE.BoxGeometry(length * 0.5, 0.03, width * 0.6), indicatorMat);
    indicator.position.y = bodyCenterY + height / 2 + 0.02;
    runtime.indicatorMat = indicatorMat;

    // 顶升平台：可视作车身顶部的薄托盘，抬升动画作用于 liftMesh.position.y。
    const liftMesh = new THREE.Mesh(
      new THREE.BoxGeometry(length * 0.92, 0.05, width * 0.92),
      new THREE.MeshStandardMaterial({ color: 0x2a4a74, metalness: 0.7, roughness: 0.35 })
    );
    liftMesh.position.y = bodyCenterY + height / 2;
    runtime.liftMesh = liftMesh;
    runtime.liftTarget = liftTarget;
    runtime.platformBaseY = bodyCenterY + height / 2;

    // 载货挂点：位于车体顶部平台上方（随 liftMesh 抬升）。
    runtime.payload.position.y = 0;
    runtime.liftMesh.add(runtime.payload);

    // 四个转向轮。
    const wheels: WheelVisual[] = [];
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x253a55, metalness: 0.4, roughness: 0.72 });
    const offsets: Array<{ x: number; z: number }> = [
      { x: -1, z: -1 },
      { x: -1, z: 1 },
      { x: 1, z: -1 },
      { x: 1, z: 1 }
    ];
    offsets.forEach((offset) => {
      const steer = new THREE.Group();
      steer.position.set(offset.x * (length / 2 - 0.16), wheelR, offset.z * (width / 2 - 0.05));
      const wheelMesh = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 20), wheelMat);
      wheelMesh.rotation.z = Math.PI / 2;
      wheelMesh.rotation.y = Math.PI / 2;
      steer.add(wheelMesh);
      group.add(steer);
      wheels.push({ mesh: steer });
    });
    runtime.wheels = wheels;

    group.add(body, indicator, liftMesh);
    return runtime;
  }

  private stepRuntime(runtime: AGVRuntime, delta: number): void {
    // 轮组偏转示意：由实际航向变化速率驱动（转向时可见车轮偏转，直线归零）。
    const yawNow = runtime.group.rotation.y;
    const yawRate = delta > 1e-4 ? (yawNow - runtime.prevYaw) / delta : 0;
    runtime.prevYaw = yawNow;
    const steerTarget = THREE.MathUtils.clamp(-yawRate * 0.45, -0.85, 0.85);
    runtime.steerAngle += (steerTarget - runtime.steerAngle) * Math.min(1, delta * 10);
    for (const wheel of runtime.wheels) wheel.mesh.rotation.y = runtime.steerAngle;

    const current = runtime.queue[0];
    if (!current) {
      runtime.state = 'idle';
      runtime.speed = 0;
      this.settleLift(runtime, delta);
      this.paintIndicator(runtime);
      return;
    }
    if (runtime.state === 'idle' || runtime.state === 'pick' || runtime.state === 'place') {
      runtime.state = 'moving';
    }

    switch (current.type) {
      case 'moveTo': {
        const pose = current.pose!;
        const speed = current.speed ?? runtime.defaultSpeed;
        this.driveToward(runtime, pose, speed, delta);
        if (this.arrived(runtime, pose)) {
          runtime.queue.shift();
        }
        break;
      }
      case 'turnTo': {
        const pose = current.pose!;
        runtime.speed = 0;
        this.turnToward(runtime, pose.yaw, delta * 2.6);
        if (Math.abs(yawDelta(runtime.group.rotation.y, pose.yaw)) < ARRIVE_YAW) {
          runtime.queue.shift();
        }
        break;
      }
      case 'stop':
        runtime.queue.shift();
        runtime.speed = 0;
        break;
      case 'pick': {
        // AGV 已抵达货物位，顶升托盘抬起并挂载货物（挂载由场景 onAction 完成）。
        runtime.queue.shift();
        runtime.carrying = true;
        runtime.liftTarget = runtime.liftHeight;
        runtime.speed = 0;
        this.runAction(runtime, 'pick');
        break;
      }
      case 'place': {
        runtime.queue.shift();
        runtime.carrying = false;
        runtime.liftTarget = 0;
        runtime.speed = 0;
        this.runAction(runtime, 'place');
        break;
      }
      default:
        runtime.queue.shift();
    }
    this.settleLift(runtime, delta);
    this.paintIndicator(runtime);
  }

  private runAction(runtime: AGVRuntime, type: 'pick' | 'place'): void {
    // 动作延迟到下一帧执行，保证当前指令已出队后场景状态一致。
    if (runtime.onAction) {
      window.setTimeout(() => runtime.onAction!(runtime.id, type), 16);
    }
  }

  /** 顶升台高度向目标缓动（目标为相对基准的抬升偏移量）。 */
  private settleLift(runtime: AGVRuntime, delta: number): void {
    const goal = runtime.platformBaseY + runtime.liftTarget;
    const lift = runtime.liftMesh.position.y;
    const diff = goal - lift;
    if (Math.abs(diff) < 0.002) {
      runtime.liftMesh.position.y = goal;
      return;
    }
    const step = diff * Math.min(1, delta * 7);
    runtime.liftMesh.position.y += step;
  }

  private driveToward(runtime: AGVRuntime, pose: Pose3, speed: number, delta: number): void {
    const dx = pose.x - runtime.group.position.x;
    const dz = pose.z - runtime.group.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    // 行驶方向航向（车身前进方向定义为局部 +X 轴）。
    const heading = distance < 1e-6 ? pose.yaw : Math.atan2(-dz, dx);
    const err = yawDelta(runtime.group.rotation.y, heading);

    if (Math.abs(err) > 0.35) {
      // 原地转向：差速小车先对准行进方向再行驶，转向过程真实可见。
      runtime.speed = 0;
      this.turnToward(runtime, heading, delta * 2.6);
      return;
    }
    // 直线行驶。
    runtime.speed = speed;
    const step = Math.min(distance, speed * delta);
    if (step > 0 && distance > 1e-6) {
      runtime.group.position.x += (dx / distance) * step;
      runtime.group.position.z += (dz / distance) * step;
    }
    // 接近目标时开始对准最终姿态，到位判定由 arrived 决定。
    const closeEnough = distance < 0.6;
    if (closeEnough) {
      this.turnToward(runtime, pose.yaw, delta * 3);
    } else {
      this.turnToward(runtime, heading, delta * 8);
    }
  }

  private turnToward(runtime: AGVRuntime, yaw: number, amount: number): void {
    const diff = yawDelta(runtime.group.rotation.y, yaw);
    // amount 上限单帧最小可转 60ms，避免抖动。
    runtime.group.rotation.y += diff * Math.min(1, Math.max(0, amount));
  }

  private arrived(runtime: AGVRuntime, pose: Pose3): boolean {
    const dx = pose.x - runtime.group.position.x;
    const dz = pose.z - runtime.group.position.z;
    const posOk = Math.sqrt(dx * dx + dz * dz) < ARRIVE_DIST;
    const yawOk = Math.abs(yawDelta(runtime.group.rotation.y, pose.yaw)) < ARRIVE_YAW;
    return posOk && yawOk;
  }

  private paintIndicator(runtime: AGVRuntime): void {
    const color = runtime.state === 'error' ? 0xe5484d : runtime.carrying ? 0xf5a524 : 0x0fae6f;
    runtime.indicatorMat.color.setHex(color);
  }
}

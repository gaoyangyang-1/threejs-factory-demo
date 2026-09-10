/**
 * FactoryScene —— 飞机货运 AGV 智能运输三维场景（集中实现，docs/方案.md §6/§8）。
 * 坐标系（机体右手系，硬约束）：机头 O(0,0,0)，+X 指向机尾，+Y 竖直向上，
 * +Z 指向飞行方向左侧（左舷）。1 单位 = 1 米。
 * 职责：
 *  - 按 config 搭建货舱/舱门(右舷 -Z，含墙洞开口)/槽位/装卸平台等静态布局并支持重建；
 *  - 消费 AlgorithmEvent 中的 SceneCommand 子集驱动动画（AGV 指令、取放、门、路径、障碍、目标槽）；
 *  - 暴露 SceneProbe 供演示编排源/算法方轮询 AGV 与货物位姿。
 * 路径规划/避障/排列/调度/RL 等算法不在此实现。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { CargoConfig } from '@/config/cargo';
import { defaultCargoConfig } from '@/config/cargo';
import { AGVTransportManager } from '@/managers/AGVTransportManager';
import { CargoManager } from '@/managers/CargoManager';
import type { DoorId, PlannedPath, Pose3, SceneCommand } from '@/types/cargo';
import { agvRoles, initialCargoSpecs, slotCells, starboardOuterZ } from '@/utils/layout';

interface FactorySceneOptions {
  container: HTMLElement;
}

interface DoorVisual {
  doorId: DoorId;
  leaf: THREE.Mesh;
  /** 关门时叶片的 X（门洞中心）。 */
  baseX: number;
  /** 开门叶片沿机身的滑移方向（前门向后滑、后门向前滑，均在外侧）。 */
  slideDir: number;
  open: number;
  target: number;
}

interface CargoTween {
  mesh: THREE.Group;
  fromX: number;
  fromZ: number;
  fromY: number;
  fromYaw: number;
  toPose: Pose3;
  progress: number;
  duration: number;
}

interface ObstacleMarker {
  group: THREE.Group;
  born: number;
  life: number;
}

interface SlotPulse {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  active: boolean;
  phase: number;
}

// 场景色板（白色亮色主题；与全局 UI 状态色一致）。
const C_WALL = 0xd6e2f1; // 舱壁 浅灰蓝
const C_DECK = 0xf3f8fd; // 地板 近白
const C_STRUCT = 0x93aecd; // 骨架 中性钢蓝
const C_BLUE = 0x1677ff;
const C_GREEN = 0x0fae6f;
const C_AMBER = 0xf5a524;
const C_RED = 0xe5484d;

export class FactoryScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private readonly container: HTMLElement;
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly fxaaPass: ShaderPass;
  private readonly clock = new THREE.Clock();

  private config: CargoConfig = defaultCargoConfig;
  private cargoManager!: CargoManager;
  private agvManager!: AGVTransportManager;
  private ground?: THREE.Mesh;
  private readonly world = new THREE.Group();
  private readonly pathLayer = new THREE.Group();
  private readonly doorVisuals: DoorVisual[] = [];
  private readonly cargoTweens = new Map<string, CargoTween>();
  private readonly obstacleMarkers: ObstacleMarker[] = [];
  private readonly pickupTargets = new Map<string, string>();
  private readonly placeTargets = new Map<string, { cargoId: string; slotId: string }>();
  private readonly slotPulses = new Map<string, SlotPulse>();
  private readonly worldQuat = new THREE.Quaternion();
  private readonly worldEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  private frameId = 0;
  private disposed = false;
  /** 窄屏（手机）标记：用于降低渲染倍率与阴影分辨率，保证移动端帧率。 */
  private readonly compactView: boolean;
  /** 上次取景时的横竖屏状态；仅在方向变化时重新取景，避免地址栏收放抖动视角。 */
  private portraitFramed: boolean | null = null;

  constructor(options: FactorySceneOptions) {
    this.container = options.container;
    this.compactView = window.matchMedia('(max-width: 900px)').matches;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 180);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0xe9f0f8, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.compactView ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 46;

    const renderPass = new RenderPass(this.scene, this.camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.4, 0.7, 0.82);
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(bloomPass);
    this.composer.addPass(this.fxaaPass);

    this.configureScene();
    this.scene.add(this.world);
    this.scene.add(this.pathLayer);
    this.buildAll();

    this.resize();
    window.addEventListener('resize', this.handleResize);
  }

  start(): void {
    this.clock.start();
    this.frameId = window.requestAnimationFrame(() => this.animate());
  }

  stop(): void {
    window.cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  resize(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    const pixelRatio = this.renderer.getPixelRatio();
    this.fxaaPass.material.uniforms.resolution.value.set(1 / (width * pixelRatio), 1 / (height * pixelRatio));

    // 横竖屏切换（手机旋转、窗口拉伸）后重新取景，保证整舱仍在画面内。
    const portrait = height > width;
    if (this.portraitFramed !== portrait) {
      this.portraitFramed = portrait;
      this.frameCamera();
    }
  }

  /**
   * 取景：
   *  - 横向（桌面大屏 / 手机横屏）：沿用原大屏取景，自右舷后上方观察并突出双舱门；
   *  - 竖向（手机竖屏）：改沿机身纵向俯视，屏幕竖向承载 24m 舱长，并按内容包围盒精确求距，
   *    保证整舱（两侧货位、右舷舱门与装卸平台）完整落入画面——同样适用于横竖屏切换与参数重建。
   */
  private frameCamera(): void {
    const cfg = this.config;
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1;

    if (aspect >= 1) {
      const camDist = 11 + cfg.hold.length * 0.55;
      this.camera.position.set(camDist * 0.4, camDist * 0.42, -camDist * 0.42);
      this.controls.target.set(cfg.hold.length / 2, 0.3, 0);
      this.controls.maxDistance = 46;
      this.controls.update();
      return;
    }

    // 竖屏：目标点取货舱高度中部，沿机身轴线略偏右舷（可看到双舱门），仰角 38°。
    const target = new THREE.Vector3(cfg.hold.length / 2, Math.max(0.9, cfg.hold.wallHeight * 0.45), 0);
    const azimuth = (14 * Math.PI) / 180;
    const elevation = (38 * Math.PI) / 180;
    const dir = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.sin(azimuth) * Math.cos(elevation)
    ).normalize();

    let dist = this.fitCameraDistance(target, dir);
    // 竖屏窄长，投影后有偏移：按内容包围盒中心平移目标点并重新求距，让整舱居中且尽量填满屏幕。
    for (let i = 0; i < 2; i += 1) {
      const shift = this.frameShift(target, dir, dist);
      if (!shift) break;
      target.add(shift);
      dist = this.fitCameraDistance(target, dir);
    }

    this.placeCamera(target, dir, dist);
    this.controls.target.copy(target);
    // 竖屏取景距离远大于桌面默认上限，放宽缩放上限避免 OrbitControls 把相机拉回。
    this.controls.maxDistance = Math.max(46, dist * 1.35);
    this.controls.update();
  }

  /** 内容包围盒：整舱 + 舱壁厚度 + 右舷装卸平台 + 舱门标牌高度。 */
  private contentBounds() {
    const cfg = this.config;
    const halfW = cfg.hold.floorWidth / 2 + cfg.hold.wallThickness;
    return {
      x0: -0.6,
      x1: cfg.hold.length + 0.6,
      y0: 0,
      y1: Math.max(3.1, cfg.hold.wallHeight + 0.6),
      z0: -halfW - 2.1,
      z1: halfW
    };
  }

  /** 内容包围盒 8 个角点（取景与求距共用）。 */
  private contentCorners(): THREE.Vector3[] {
    const box = this.contentBounds();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.x0, box.x1]) {
      for (const y of [box.y0, box.y1]) {
        for (const z of [box.z0, box.z1]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    return corners;
  }

  /** 按给定距离摆好相机（供取景计算使用）。 */
  private placeCamera(target: THREE.Vector3, dir: THREE.Vector3, distance: number): void {
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
  }

  /** 二分求能把内容包围盒完整收进画面（留 10% 边距）的最小相机距离。 */
  private fitCameraDistance(target: THREE.Vector3, dir: THREE.Vector3): number {
    const corners = this.contentCorners();
    const ndc = new THREE.Vector3();
    const fits = (distance: number): boolean => {
      this.placeCamera(target, dir, distance);
      return corners.every((corner) => {
        ndc.copy(corner).project(this.camera);
        return Math.abs(ndc.x) <= 0.9 && Math.abs(ndc.y) <= 0.9;
      });
    };

    let lo = 6;
    let hi = 400;
    if (fits(lo)) return lo;
    for (let i = 0; i < 28; i += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /** 内容投影包围盒中心相对画面中心的偏移（世界坐标），用于把内容摆正到画面中间。 */
  private frameShift(target: THREE.Vector3, dir: THREE.Vector3, distance: number): THREE.Vector3 | null {
    this.placeCamera(target, dir, distance);
    const ndc = new THREE.Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const corner of this.contentCorners()) {
      ndc.copy(corner).project(this.camera);
      minX = Math.min(minX, ndc.x);
      maxX = Math.max(maxX, ndc.x);
      minY = Math.min(minY, ndc.y);
      maxY = Math.max(maxY, ndc.y);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    if (Math.abs(centerX) < 0.01 && Math.abs(centerY) < 0.01) return null;

    const halfHeight = distance * Math.tan((this.camera.fov * Math.PI) / 360);
    const halfWidth = halfHeight * this.camera.aspect;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    // 目标点平移量与投影偏移同向即可把内容拉回中心（0.9 阻尼避免过冲）。
    return right.multiplyScalar(0.9 * centerX * halfWidth).add(up.multiplyScalar(0.9 * centerY * halfHeight));
  }

  private handleResize = (): void => this.resize();

  /** 参数变更：整场景按新配置重建（含初始装载）。 */
  applyConfig(config: CargoConfig): void {
    this.config = config;
    this.buildAll();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.controls.dispose();
    this.disposeSubtree(this.world);
    this.disposeSubtree(this.pathLayer);
    this.agvManager?.dispose();
    this.cargoManager?.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------------------
  // SceneProbe 只读位姿查询（世界坐标，供编排源判定完成）
  // ---------------------------------------------------------------------------

  getAgvPose(agvId: string): Pose3 | null {
    if (!this.agvManager) return null;
    const runtime = this.agvManager.getRuntime(agvId);
    if (!runtime) return null;
    return { x: runtime.pose.x, y: runtime.pose.y, z: runtime.pose.z, yaw: runtime.pose.yaw };
  }

  getCargoPose(cargoId: string): Pose3 | null {
    if (!this.cargoManager) return null;
    const mesh = this.cargoManager.cargo.get(cargoId);
    if (!mesh) return null;
    mesh.getWorldPosition(this.tmpVec);
    mesh.getWorldQuaternion(this.worldQuat);
    this.worldEuler.setFromQuaternion(this.worldQuat);
    return { x: this.tmpVec.x, y: this.tmpVec.y, z: this.tmpVec.z, yaw: this.worldEuler.y };
  }

  /** 舱门开启进度（0 关 → 1 全开），供编排源判断可通行时机。 */
  doorProgress(doorId: DoorId): number | null {
    const door = this.doorVisuals.find((item) => item.doorId === doorId);
    return door ? door.open : null;
  }

  private readonly tmpVec = new THREE.Vector3();

  // ---------------------------------------------------------------------------
  // 外部算法事件消费（SceneCommand 子集）
  // ---------------------------------------------------------------------------

  handleSceneCommand(command: SceneCommand): void {
    switch (command.type) {
      case 'scene:reset':
        this.applyConfig(command.payload.config);
        break;
      case 'agv:command':
        // pick/place 目标由 cargo:pickup / cargo:place 预登记；此处仅执行增量指令。
        this.agvManager.dispatch([command.payload]);
        break;
      case 'cargo:pickup': {
        this.pickupTargets.set(command.payload.agvId, command.payload.cargoId);
        break;
      }
      case 'cargo:place': {
        const p = command.payload;
        this.placeTargets.set(p.agvId, { cargoId: p.cargoId, slotId: p.slotId });
        break;
      }
      case 'cargo:spawn': {
        const p = command.payload;
        this.cargoManager.placeCargoAtPose(p.cargoId, p.cargoType, p.pose);
        break;
      }
      case 'cargo:move': {
        const p = command.payload;
        const mesh = this.cargoManager.cargo.get(p.cargoId);
        if (mesh && mesh.parent === this.cargoManager.group) {
          this.cargoTweens.set(p.cargoId, this.makeCargoTween(mesh, p.pose));
        }
        break;
      }
      case 'path:plan':
        this.renderPlannedPath(command.payload);
        break;
      case 'obstacle:event':
        this.spawnObstacleMarker(command.payload.agvId, command.payload.pose, command.payload.radius);
        break;
      case 'slot:mark': {
        const p = command.payload;
        const pulse = this.slotPulses.get(p.slotId);
        if (pulse) pulse.active = p.state === 'pending';
        break;
      }
      case 'door:set': {
        const door = this.doorVisuals.find((item) => item.doorId === command.payload.doorId);
        if (door) door.target = command.payload.state === 'open' ? 1 : 0;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 场景初始化/重建
  // ---------------------------------------------------------------------------

  private configureScene(): void {
    this.scene.fog = new THREE.Fog(0xe9f0f8, 45, 120);
    const hemi = new THREE.HemisphereLight(0xffffff, 0xbdd2ea, 1.1);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(8, 16, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(this.compactView ? 1024 : 2048, this.compactView ? 1024 : 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -16;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x87b6ff, 0.7);
    fill.position.set(-10, 7, -10);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffe3b8, 0.45);
    rim.position.set(0, 5, 14);
    this.scene.add(rim);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140),
      new THREE.MeshBasicMaterial({ color: 0xdfe9f5 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(12, -0.03, 0);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  private buildAll(): void {
    this.clearGroupChildren(this.world);
    this.clearGroupChildren(this.pathLayer);
    for (const marker of this.obstacleMarkers) this.disposeSubtree(marker.group);
    this.agvManager?.dispose();
    this.agvManager?.group.removeFromParent();
    this.cargoManager?.dispose();
    this.cargoManager?.group.removeFromParent();
    this.cargoTweens.clear();
    this.obstacleMarkers.length = 0;
    this.pickupTargets.clear();
    this.placeTargets.clear();
    this.doorVisuals.length = 0;
    this.slotPulses.clear();

    const cfg = this.config;
    const centerX = cfg.hold.length / 2;

    // 相机与轨道目标随货舱长度、视口宽高比自适应（见 frameCamera）。
    this.frameCamera();
    if (this.ground) this.ground.position.x = centerX;

    this.cargoManager = new CargoManager(cfg);
    this.scene.add(this.cargoManager.group);

    // AGV 角色与驻泊位（机头/机尾空场，见 utils/layout agvRoles）。
    this.agvManager = new AGVTransportManager(
      agvRoles(cfg).map((role) => ({
        id: role.id,
        name: role.id,
        color: role.fromColumn === 0 ? C_GREEN : C_AMBER,
        length: cfg.agv.length,
        width: cfg.agv.width,
        height: cfg.agv.height,
        liftHeight: cfg.agv.liftHeight,
        defaultSpeed: cfg.agv.speed,
        home: role.home,
        onAction: (agvId, action) => this.onAgvAction(agvId, action)
      }))
    );
    this.scene.add(this.agvManager.group);

    this.buildHull();
    this.buildDoors();
    this.buildFloorLayout();
    this.buildSlotPulses();
    this.buildSeededCargo();
  }

  private buildHull(): void {
    const cfg = this.config;
    const len = cfg.hold.length;
    const deckHalf = cfg.hold.floorWidth / 2;
    const outerZ = starboardOuterZ(cfg); // 侧壁外沿（右舷为负）
    const wallT = cfg.hold.wallThickness;
    const wallH = cfg.hold.wallHeight;
    const cx = len / 2;

    // 地板（顶面与 Y=0 地板面齐平）。
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.14, deckHalf * 2),
      new THREE.MeshStandardMaterial({ color: C_DECK, roughness: 0.94, metalness: 0.08 })
    );
    deck.position.set(cx, -0.07, 0);
    deck.receiveShadow = true;
    this.world.add(deck);

    const wallMat = new THREE.MeshStandardMaterial({
      color: C_WALL,
      roughness: 0.85,
      metalness: 0.35,
      side: THREE.DoubleSide
    });
    const wallCenterZ = outerZ - wallT / 2;
    // 左舷(+Z)整墙。
    this.world.add(this.wallSegment(wallMat, len, wallH, wallT, 0, len, cx, wallCenterZ));

    // 右舷(-Z)墙：按前后舱门洞开窗分段（洞宽 door.width、洞高 door.height）。
    const bands = [
      { minX: cfg.doors.forward.x - cfg.doors.forward.width / 2, maxX: cfg.doors.forward.x + cfg.doors.forward.width / 2 },
      { minX: cfg.doors.aft.x - cfg.doors.aft.width / 2, maxX: cfg.doors.aft.x + cfg.doors.aft.width / 2 }
    ].sort((a, b) => a.minX - b.minX);
    let cursor = 0;
    for (const band of bands) {
      if (band.minX > cursor + 0.02) this.world.add(this.wallSegment(wallMat, len, wallH, wallT, cursor, band.minX, cx, -wallCenterZ));
      cursor = band.maxX;
    }
    if (cursor < len - 0.02) this.world.add(this.wallSegment(wallMat, len, wallH, wallT, cursor, len, cx, -wallCenterZ));
    // 门洞上方墙体段（Y: doorHeight..wallHeight）。
    for (const spec of [cfg.doors.forward, cfg.doors.aft]) {
      const header = new THREE.Mesh(new THREE.BoxGeometry(spec.width + wallT, wallH - spec.height, wallT), wallMat);
      header.position.set(spec.x, spec.height + (wallH - spec.height) / 2, -wallCenterZ);
      this.world.add(header);
    }

    // 机头/机尾隔板。
    const endWallMat = new THREE.MeshStandardMaterial({ color: C_WALL, roughness: 0.85, metalness: 0.35, side: THREE.DoubleSide });
    const endWall = (x: number) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(wallT, wallH, deckHalf * 2), endWallMat);
      wall.position.set(x, wallH / 2, 0);
      this.world.add(wall);
    };
    endWall(wallT / 2);
    endWall(len - wallT / 2);

    // 顶部纵梁与机身圆弧示意骨架。
    const ribMat = new THREE.MeshStandardMaterial({
      color: C_STRUCT,
      roughness: 0.65,
      metalness: 0.45,
      transparent: true,
      opacity: 0.62
    });
    for (let x = 1.4; x < len; x += 3.4) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(deckHalf + 0.24, 0.05, 6, 28, Math.PI), ribMat);
      rib.rotation.y = Math.PI / 2;
      rib.position.set(x, wallH * 0.52, 0);
      this.world.add(rib);
    }
    const spineMat = new THREE.MeshStandardMaterial({ color: C_STRUCT, roughness: 0.6, metalness: 0.4 });
    const spine = new THREE.Mesh(new THREE.BoxGeometry(len, 0.07, 0.07), spineMat);
    spine.position.set(cx, wallH + 0.02, 0);
    this.world.add(spine);
  }

  private wallSegment(
    material: THREE.Material,
    len: number,
    wallH: number,
    wallT: number,
    fromX: number,
    toX: number,
    cx: number,
    z: number
  ): THREE.Mesh {
    const segLen = Math.max(0.05, toX - fromX);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(segLen, wallH, wallT), material);
    seg.position.set(cx - len / 2 + (fromX + toX) / 2, wallH / 2, z);
    return seg;
  }

  private buildDoors(): void {
    const cfg = this.config;
    const outerZ = starboardOuterZ(cfg);
    const leafZ = outerZ + 0.045;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x7f9cc4, roughness: 0.55, metalness: 0.55 });
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0xb9cde8,
      roughness: 0.35,
      metalness: 0.6,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide
    });
    const t = cfg.hold.wallThickness + 0.22;

    for (const entry of [
      { doorId: 'forward' as DoorId, spec: cfg.doors.forward, slideDir: 1 },
      { doorId: 'aft' as DoorId, spec: cfg.doors.aft, slideDir: -1 }
    ]) {
      const { doorId, spec, slideDir } = entry;
      const x = spec.x;
      const w = spec.width;
      const h = spec.height;
      // 门框（围绕洞口的四根边框）。
      const bar = (bw: number, bh: number, bx: number, by: number) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, t), frameMat);
        mesh.position.set(bx, by, outerZ - cfg.hold.wallThickness / 2);
        this.world.add(mesh);
      };
      bar(w + 0.3, 0.12, x, h + 0.06); // 上
      bar(w + 0.3, 0.12, x, -0.06); // 下
      bar(0.14, h + 0.3, x - w / 2 - 0.07, h / 2);
      bar(0.14, h + 0.3, x + w / 2 + 0.07, h / 2);

      // 门扇：位于墙外，开门沿机身轴向滑移避开门洞（前门向后、后门向前）。
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, h - 0.1, 0.1), panelMat);
      leaf.position.set(x, h / 2, leafZ);
      this.world.add(leaf);
      this.doorVisuals.push({ doorId, leaf, baseX: x, slideDir, open: 0, target: 0 });

      // 门外装卸平台（顶面与地板同高）。
      const dock = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.7, 0.08, 2.1),
        new THREE.MeshStandardMaterial({ color: 0xcfdcea, roughness: 0.75, metalness: 0.12 })
      );
      dock.position.set(x, -0.04, outerZ - 1.05);
      dock.receiveShadow = true;
      this.world.add(dock);
      const dockMark = new THREE.MeshBasicMaterial({ color: C_AMBER, transparent: true, opacity: 0.3 });
      const line = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.2, 0.03), dockMark);
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.012, outerZ - 0.6);
      this.world.add(line);
    }

    // 门位标牌（亮色背景下使用深蓝/深绿文字）。
    this.world.add(this.createTextSprite('前货舱门 · FORWARD', { x: cfg.doors.forward.x, y: 2.75, z: outerZ - 0.6 }, 0.5, 0x1257c4));
    this.world.add(this.createTextSprite('后货舱门 · AFT', { x: cfg.doors.aft.x, y: 2.75, z: outerZ - 0.6 }, 0.5, 0x1257c4));
    this.world.add(this.createTextSprite('机头 O(0,0,0) → 机尾 +X', { x: 1.0, y: 2.9, z: 0 }, 0.45, 0x0e8f5d));
  }

  private buildFloorLayout(): void {
    const cfg = this.config;
    // 通道边线与地面安全线。
    const lineMat = new THREE.MeshBasicMaterial({ color: C_AMBER, transparent: true, opacity: 0.28 });
    for (const z of [cfg.aisleHalfWidth, -cfg.aisleHalfWidth]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(cfg.hold.length, 0.035), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(cfg.hold.length / 2, 0.006, z);
      this.world.add(line);
    }
    // 槽位格 + 编号。
    for (const cell of slotCells(cfg)) {
      const mat = new THREE.MeshBasicMaterial({
        color: cell.side === 'L' ? C_BLUE : C_GREEN,
        transparent: true,
        opacity: cell.side === 'L' ? 0.07 : 0.05
      });
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(cfg.slotPitch * 0.94, 1.5), mat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(cell.x, 0.008, cell.z);
      this.world.add(pad);
      const label = this.createTextSprite(
        `${cell.side}${String(cell.column).padStart(2, '0')}`,
        { x: cell.x, y: 0.02, z: cell.z + (cell.side === 'L' ? -0.32 : 0.32) },
        0.4,
        cell.side === 'L' ? C_BLUE : C_GREEN
      );
      this.world.add(label);
    }
  }

  private buildSlotPulses(): void {
    const cfg = this.config;
    const geometry = new THREE.PlaneGeometry(1.4, 1.4);
    for (const cell of slotCells(cfg)) {
      const material = new THREE.MeshBasicMaterial({ color: C_AMBER, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cell.x, 0.02, cell.z);
      this.world.add(mesh);
      this.slotPulses.set(cell.slotId, { mesh, material, active: false, phase: Math.random() * Math.PI * 2 });
    }
  }

  private buildSeededCargo(): void {
    for (const spec of initialCargoSpecs(this.config)) {
      this.cargoManager.placeCargo(spec.id, spec.type, spec.slotId);
    }
  }

  private onAgvAction(agvId: string, action: 'pick' | 'place'): void {
    if (action === 'pick') {
      const cargoId = this.pickupTargets.get(agvId);
      this.pickupTargets.delete(agvId);
      if (!cargoId) return;
      const mesh = this.cargoManager.cargo.get(cargoId);
      if (!mesh) return;
      // 释放原槽位占用并挂载到顶升平台。
      this.cargoManager.releaseOccupancy(cargoId);
      this.agvManager.mountPayload(agvId, mesh);
    } else {
      const target = this.placeTargets.get(agvId);
      this.placeTargets.delete(agvId);
      if (!target) return;
      const mesh = this.cargoManager.cargo.get(target.cargoId);
      const slot = this.cargoManager.getSlotPose(target.slotId);
      if (!mesh || !slot) return;
      // 从 AGV 卸载（保持当前世界位姿）后横移入位。
      this.agvManager.unmountPayload(agvId, mesh);
      this.cargoManager.group.add(mesh);
      const pose = this.getCargoPose(target.cargoId);
      // 入位后货物长轴仍沿 X：就近吸附到 0 或 ±π，避免放置过程中出现旋转。
      const snapYaw = Math.round(mesh.rotation.y / Math.PI) * Math.PI;
      this.cargoTweens.set(target.cargoId, {
        mesh,
        fromX: mesh.position.x,
        fromZ: mesh.position.z,
        fromY: pose?.y ?? mesh.position.y,
        fromYaw: mesh.rotation.y,
        toPose: { x: slot.x, y: 0, z: slot.z, yaw: snapYaw },
        progress: 0,
        duration: 0.9
      });
      this.cargoManager.finalizePlace(target.cargoId, target.slotId);
    }
  }

  private makeCargoTween(mesh: THREE.Group, toPose: Pose3): CargoTween {
    return {
      mesh,
      fromX: mesh.position.x,
      fromZ: mesh.position.z,
      fromY: mesh.position.y,
      fromYaw: mesh.rotation.y,
      toPose,
      progress: 0,
      duration: 1.7
    };
  }

  private renderPlannedPath(path: PlannedPath): void {
    this.clearGroupChildren(this.pathLayer);
    if (!path.waypoints || path.waypoints.length < 2) return;
    const points = path.waypoints.map((wp) => new THREE.Vector3(wp.x, 0.055, wp.z));
    const lineMat = new THREE.LineBasicMaterial({ color: C_GREEN, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMat);
    this.pathLayer.add(line);
    const dotMat = new THREE.MeshBasicMaterial({ color: C_GREEN });
    for (const pt of points) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), dotMat);
      dot.position.set(pt.x, 0.055, pt.z);
      this.pathLayer.add(dot);
    }
    // 路径起点光点（AGV 当前位置闪烁提示）。
    void path.agvId;
  }

  private spawnObstacleMarker(agvId: string, pose: Pose3, radius: number): void {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.55, radius, 32),
      new THREE.MeshBasicMaterial({ color: C_AMBER, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.55, 8),
      new THREE.MeshBasicMaterial({ color: C_RED })
    );
    beacon.position.y = 0.3;
    group.add(ring, beacon);
    group.position.set(pose.x, 0, pose.z);
    this.scene.add(group);
    this.obstacleMarkers.push({ group, born: performance.now(), life: 7000 });
    void agvId;
  }

  // ---------------------------------------------------------------------------
  // 帧循环
  // ---------------------------------------------------------------------------

  private animate = (): void => {
    if (this.disposed) return;
    this.frameId = window.requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.controls.update();
    this.agvManager?.update(delta);
    this.animateDoors(delta);
    this.animateCargoTweens(delta);
    this.animateObstacles();
    this.animateSlotPulses();
    this.composer.render();
  };

  private animateDoors(delta: number): void {
    for (const door of this.doorVisuals) {
      if (Math.abs(door.target - door.open) < 0.001) continue;
      door.open = THREE.MathUtils.damp(door.open, door.target, 1.4, delta);
      door.leaf.position.x = door.baseX + door.open * door.slideDir * 3.1;
      door.leaf.visible = door.open < 0.99;
    }
  }

  private animateCargoTweens(delta: number): void {
    for (const [id, tween] of this.cargoTweens) {
      tween.progress += delta / tween.duration;
      const k = Math.min(tween.progress, 1);
      const ease = 1 - (1 - k) * (1 - k);
      const mesh = tween.mesh;
      mesh.position.x = THREE.MathUtils.lerp(tween.fromX, tween.toPose.x, ease);
      mesh.position.z = THREE.MathUtils.lerp(tween.fromZ, tween.toPose.z, ease);
      mesh.position.y = THREE.MathUtils.lerp(tween.fromY, tween.toPose.y, ease);
      const diff = tween.toPose.yaw - tween.fromYaw;
      mesh.rotation.y = tween.fromYaw + Math.atan2(Math.sin(diff), Math.cos(diff)) * ease;
      if (tween.progress >= 1) this.cargoTweens.delete(id);
    }
  }

  private animateObstacles(): void {
    for (let i = this.obstacleMarkers.length - 1; i >= 0; i--) {
      const marker = this.obstacleMarkers[i];
      if (performance.now() - marker.born > marker.life) {
        this.disposeSubtree(marker.group);
        this.obstacleMarkers.splice(i, 1);
      }
    }
  }

  private animateSlotPulses(): void {
    const now = performance.now() / 1000;
    this.slotPulses.forEach((pulse) => {
      if (!pulse.active) {
        if (pulse.material.opacity > 0.01) pulse.material.opacity = THREE.MathUtils.lerp(pulse.material.opacity, 0, 0.25);
        else pulse.material.opacity = 0;
        return;
      }
      pulse.material.opacity = 0.2 + Math.abs(Math.sin(now * 4 + pulse.phase)) * 0.5;
      const s = 1 + Math.sin(now * 5 + pulse.phase) * 0.08;
      pulse.mesh.scale.set(s, s, 1);
    });
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  private createTextSprite(text: string, pos: { x: number; y: number; z: number }, size: number, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    ctx.shadowColor = hex;
    ctx.shadowBlur = 18;
    ctx.fillStyle = hex;
    ctx.font = '700 72px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(aspect * size * 0.24, size * 0.24, 1);
    sprite.position.set(pos.x, pos.y, pos.z);
    return sprite;
  }

  private disposeSubtree(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((item) => {
          item.dispose();
          const map = (item as THREE.MeshBasicMaterial).map;
          map?.dispose();
        });
      } else if (material) {
        material.dispose();
        const map = (material as THREE.MeshBasicMaterial).map;
        map?.dispose();
      }
    });
    root.removeFromParent();
  }

  private clearGroupChildren(group: THREE.Group): void {
    const children = [...group.children];
    for (const child of children) this.disposeSubtree(child);
  }
}

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
import { agvRoles, initialCargoSpecs, slotCellOf, slotCells, starboardOuterZ } from '@/utils/layout';

interface FactorySceneOptions {
  container: HTMLElement;
  /** 安全告警回调（贴近舱壁/干涉时上报 UI 日志）。 */
  onSafety?: (level: 'warn' | 'error', message: string) => void;
}

/** 安全间隙阈值（m）：低于该值即报警。 */
const CLEARANCE_WARN = 0.25;

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
const C_WALL = 0xc9d9ec; // 舱壁 浅灰蓝
const C_DECK = 0xd7e3f1; // 地板 冷淡蓝（压低亮度，避免货位格线被高光冲淡）
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
  private readonly onSafety?: (level: 'warn' | 'error', message: string) => void;
  /** 间隙告警环（每台 AGV 一个，临近舱壁时显示）。 */
  private readonly safetyRings = new Map<string, THREE.Mesh>();
  private readonly safetyCooldown = new Map<string, number>();
  private safetyFrame = 0;
  private readonly pathLayer = new THREE.Group();
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
    this.onSafety = options.onSafety;
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
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.7, 0.92);
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

    // 仅开发环境：暴露场景实例便于无头浏览器验证取景/几何（生产构建会被摇掉）。
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__dtScene = this;
    }
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
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1;
    const box = this.contentBounds();
    const center = new THREE.Vector3((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2);

    // 观察方向：横屏自右舷后上方俯视整机（仰角要够高，否则右舷墙会挡住舱内）；
    // 竖屏沿机身纵轴略偏右舷（能看到舱门与舱外待命区）。
    let dir: THREE.Vector3;
    if (aspect >= 1) {
      // 略偏右舷的前上方大俯角：机身长轴在屏幕上接近竖向，避开左右两侧面板的遮挡。
      dir = new THREE.Vector3(0.34, 1.15, -0.5).normalize();
    } else {
      const azimuth = (14 * Math.PI) / 180;
      const elevation = (38 * Math.PI) / 180;
      dir = new THREE.Vector3(
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        -Math.sin(azimuth) * Math.cos(elevation)
      ).normalize();
    }

    // 按内容包围盒二分求距，保证机头/机尾/舱门/待命区完整入画并居中。
    let dist = this.fitCameraDistance(center, dir);
    for (let i = 0; i < 2; i += 1) {
      const shift = this.frameShift(center, dir, dist);
      if (!shift) break;
      center.add(shift);
      dist = this.fitCameraDistance(center, dir);
    }
    // 目标点不要沉到地板以下（否则相机会压得很低，侧墙挡住舱内），并按修正后的目标重新求距。
    center.y = Math.max(0.8, Math.min(center.y, 2.2));
    dist = this.fitCameraDistance(center, dir);

    this.placeCamera(center, dir, dist);
    this.controls.target.copy(center);
    this.controls.maxDistance = Math.max(60, dist * 1.4);
    this.controls.update();
  }

  /** 内容包围盒：机头锥段 + 整舱 + 尾部 + 舱壁厚度 + 右舷装卸平台 + 标牌高度。 */
  private contentBounds() {
    const cfg = this.config;
    const halfW = cfg.hold.floorWidth / 2 + cfg.hold.wallThickness;
    return {
      x0: -(cfg.nose.length + 0.8),
      x1: cfg.hold.length + 0.8,
      y0: 0,
      y1: Math.max(cfg.hold.wallHeight + 1.5, 4.0),
      z0: -halfW - 2.6,
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

  /**
   * 二分求能把内容包围盒收进画面「安全区」的最小相机距离。
   * 左右两栏面板 + 顶栏/日志栏会遮挡画布边缘，故横向阈值收紧到 0.62、纵向 0.86，
   * 保证机头/机尾/舱门/待命区落在面板之间的可见区域。
   */
  private fitCameraDistance(target: THREE.Vector3, dir: THREE.Vector3): number {
    const corners = this.contentCorners();
    const ndc = new THREE.Vector3();
    const limitX = 0.46;
    const limitY = 0.84;
    const fits = (distance: number): boolean => {
      this.placeCamera(target, dir, distance);
      return corners.every((corner) => {
        ndc.copy(corner).project(this.camera);
        return Math.abs(ndc.x) <= limitX && Math.abs(ndc.y) <= limitY;
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

  /** 舱门开启进度：门常开（无门扇），恒为 1。 */
  doorProgress(_doorId: DoorId): number | null {
    return 1;
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
      case 'door:set':
        // 舱门常开且无门扇，开门/关门指令忽略（保留契约兼容）。
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // 场景初始化/重建
  // ---------------------------------------------------------------------------

  private configureScene(): void {
    this.scene.fog = new THREE.Fog(0xe9f0f8, 45, 120);
    const hemi = new THREE.HemisphereLight(0xffffff, 0xbdd2ea, 0.9);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
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
    this.slotPulses.clear();
    this.safetyRings.clear();
    this.safetyCooldown.clear();

    const cfg = this.config;
    // 整机（机头锥段 + 货舱 + 机尾锥段）中心，用作地面与取景基准。
    const centerX = (cfg.hold.length - cfg.nose.length) / 2;

    // 相机与轨道目标随货舱长度、视口宽高比自适应（见 frameCamera）。
    this.frameCamera();
    if (this.ground) this.ground.position.x = centerX;

    this.cargoManager = new CargoManager(cfg);
    this.scene.add(this.cargoManager.group);

    // AGV 角色与待命位（全部在前舱门外平台待命，见 utils/layout agvRoles）。
    this.agvManager = new AGVTransportManager(
      agvRoles(cfg).map((role, index) => ({
        id: role.id,
        name: role.id,
        color: index === 0 ? C_GREEN : C_AMBER,
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

    this.buildNose();
    this.buildHull();
    this.buildDoors();
    this.buildFloorLayout();
    this.buildSlotPulses();
    this.buildSeededCargo();
  }

  /**
   * 机头锥段（沿 -X 自货舱前隔板向前延伸）：椭圆截面收束的机身壳 + 驾驶舱舷窗，
   * 用于在三维上直观区分机头/机尾——机身坐标 +X 指向机尾，故机头位于 X<0。
   */
  private buildNose(): void {
    const cfg = this.config;
    const noseLen = cfg.nose.length;
    if (noseLen <= 0.2) return;
    const aZ = cfg.hold.floorWidth / 2 + cfg.hold.wallThickness - 0.16;
    const aY = cfg.hold.wallHeight * 0.78;
    const centerY = cfg.hold.wallHeight * 0.42;

    const rings = 18;
    const segs = 32;
    const positions: number[] = [];
    const indices: number[] = [];
    const profileScale = (t: number): number => Math.max(0.05, Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.3))));
    for (let i = 0; i <= rings; i += 1) {
      const t = i / rings;
      const x = -t * noseLen;
      const s = profileScale(t);
      for (let j = 0; j <= segs; j += 1) {
        const ang = (j / segs) * Math.PI * 2;
        positions.push(x, centerY + Math.sin(ang) * aY * s, Math.cos(ang) * aZ * s);
      }
    }
    const rowLen = segs + 1;
    for (let i = 0; i < rings; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const a = i * rowLen + j;
        const b = a + 1;
        const c = a + rowLen;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const shell = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0xe7eef8,
        roughness: 0.55,
        metalness: 0.3,
        side: THREE.DoubleSide
      })
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.world.add(shell);

    // 驾驶舱舷窗：贴在机头上部两侧（沿曲面外法线朝外）。
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x16324f,
      roughness: 0.12,
      metalness: 0.92,
      emissive: 0x0d2038,
      emissiveIntensity: 0.5
    });
    const windowAt = (t: number, angOffset: number, w: number, h: number): void => {
      const s = profileScale(t);
      const x = -t * noseLen;
      const ang = Math.PI / 2 + angOffset;
      const p = new THREE.Vector3(x, centerY + Math.sin(ang) * aY * s, Math.cos(ang) * aZ * s);
      const radial = new THREE.Vector3(0, p.y - centerY, p.z).normalize();
      const win = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat);
      win.position.copy(p).addScaledVector(radial, 0.02);
      win.lookAt(p.clone().add(radial));
      this.world.add(win);
    };
    for (const sign of [1, -1]) {
      // 前风挡（靠近机头中线）与侧窗（靠外侧）。
      windowAt(0.46, sign * 0.2, 0.92, 0.4);
      windowAt(0.6, sign * 0.44, 0.7, 0.34);
      windowAt(0.72, sign * 0.58, 0.5, 0.3);
    }

    // 机头雷达罩分色线（示意）。
    const radome = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.03, 6, 36),
      new THREE.MeshStandardMaterial({ color: 0x9fb4cf, roughness: 0.7, metalness: 0.3 })
    );
    const radomeT = 0.86;
    const rs = profileScale(radomeT);
    radome.scale.set(aZ * rs, aY * rs, 1);
    radome.rotation.y = Math.PI / 2;
    radome.position.set(-noseLen * radomeT, centerY, 0);
    this.world.add(radome);

    this.world.add(this.createTextSprite('机头 · NOSE', { x: -noseLen * 0.45, y: aY + 0.95, z: 0 }, 0.55, 0x1257c4));
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
    // 侧壁 Z 向：左舷为 +Z，右舷（AGV 进舱、有舱门）为 -Z。
    const portZ = cfg.hold.floorWidth / 2 + wallT / 2;
    const starboardZ = -(cfg.hold.floorWidth / 2 + wallT / 2);
    // 左舷(+Z)：整面封闭舱壁。
    this.world.add(this.wallSegment(wallMat, len, wallH, wallT, 0, len, cx, portZ));

    // 右舷(-Z)：仅保留一个前舱门开口，其余整段封闭。
    const door = cfg.doors.forward;
    const holeMin = door.x - door.width / 2;
    const holeMax = door.x + door.width / 2;
    if (holeMin > 0.02) this.world.add(this.wallSegment(wallMat, len, wallH, wallT, 0, holeMin, cx, starboardZ));
    if (holeMax < len - 0.02) this.world.add(this.wallSegment(wallMat, len, wallH, wallT, holeMax, len, cx, starboardZ));
    // 门洞上方墙体（门洞净高达舱壁高度时不再需要）。
    const headerH = wallH - door.height;
    if (headerH > 0.02) {
      const header = new THREE.Mesh(new THREE.BoxGeometry(door.width + wallT, headerH, wallT), wallMat);
      header.position.set(door.x, door.height + headerH / 2, starboardZ);
      this.world.add(header);
    }

    // 机头（前）/机尾（后）隔框。
    const endWallMat = new THREE.MeshStandardMaterial({ color: C_WALL, roughness: 0.85, metalness: 0.35, side: THREE.DoubleSide });
    const endWall = (x: number) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(wallT, wallH, deckHalf * 2), endWallMat);
      wall.position.set(x, wallH / 2, 0);
      this.world.add(wall);
    };
    endWall(wallT / 2);
    endWall(len - wallT / 2);
    // 机尾一侧不做尾锥外形，仅保留平直后隔框 + 标牌，避免与机头外形混淆。
    this.world.add(this.createTextSprite('机尾 · TAIL', { x: len - 0.9, y: wallH + 0.6, z: 0 }, 0.5, 0xe07a1f));

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
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x7f9cc4, roughness: 0.55, metalness: 0.55 });
    const t = cfg.hold.wallThickness + 0.22;

    const spec = cfg.doors.forward;
    const x = spec.x;
    const w = spec.width;
    const h = spec.height;
    // 门框（围绕洞口的四根边框）；不做门扇——舱门常开，只有 AGV 旁边的这一处开口。
    const bar = (bw: number, bh: number, bx: number, by: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, t), frameMat);
      mesh.position.set(bx, by, outerZ - cfg.hold.wallThickness / 2);
      this.world.add(mesh);
    };
    bar(w + 0.3, 0.12, x, h + 0.06); // 上
    bar(w + 0.3, 0.12, x, -0.06); // 下
    bar(0.14, h + 0.3, x - w / 2 - 0.07, h / 2);
    bar(0.14, h + 0.3, x + w / 2 + 0.07, h / 2);

    // 舱外装卸平台（AGV 待命区；顶面与地板同高），沿 Z 方向加深以容纳多台排队待命。
    const dockWidth = Math.max(w + 2.4, 4.6);
    const dockDepth = 2.6 + Math.max(0, cfg.agv.count - 1) * 2.4;
    const dock = new THREE.Mesh(
      new THREE.BoxGeometry(dockWidth, 0.08, dockDepth),
      new THREE.MeshStandardMaterial({ color: 0xcfdcea, roughness: 0.75, metalness: 0.12 })
    );
    dock.position.set(x, -0.04, outerZ - 0.3 - dockDepth / 2);
    dock.receiveShadow = true;
    this.world.add(dock);
    const dockMark = new THREE.MeshBasicMaterial({ color: C_AMBER, transparent: true, opacity: 0.3 });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(dockWidth - 0.4, 0.05), dockMark);
    line.rotation.x = -Math.PI / 2;
    line.position.set(x, 0.012, outerZ - 0.55);
    this.world.add(line);
    // 待命位标线（每台 AGV 一条）。
    for (let i = 0; i < Math.max(1, Math.round(cfg.agv.count)); i += 1) {
      const standLine = new THREE.Mesh(new THREE.PlaneGeometry(dockWidth - 1.0, 0.04), dockMark);
      standLine.rotation.x = -Math.PI / 2;
      standLine.position.set(x, 0.012, outerZ - 1.2 - i * 2.4);
      this.world.add(standLine);
    }

    // 门位标牌（常开）。
    this.world.add(this.createTextSprite('前舱门 · 常开', { x, y: h + 0.42, z: outerZ - 0.6 }, 0.5, 0x1257c4));
  }

  private buildFloorLayout(): void {
    const cfg = this.config;
    // 货舱地板全宽度可放货：按三排货位铺格线，不再绘制 AGV 专用通道。
    const sideColor: Record<'L' | 'R' | 'C', number> = { L: C_BLUE, R: C_GREEN, C: C_AMBER };
    const sideInk: Record<'L' | 'R' | 'C', number> = { L: 0x1257c4, R: 0x0a7a4c, C: 0xa8690a };
    for (const cell of slotCells(cfg)) {
      // 货位格底色：比地板略深，保证亮色主题下也能看出"每块都能放货"。
      const mat = new THREE.MeshBasicMaterial({
        color: sideColor[cell.side],
        transparent: true,
        opacity: cell.side === 'C' ? 0.13 : 0.16
      });
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(cfg.slotPitch * 0.9, 1.9), mat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(cell.x, 0.008, cell.z);
      this.world.add(pad);

      // 格边线（细边框，强化货位边界）。
      const edgeMat = new THREE.LineBasicMaterial({ color: sideInk[cell.side], transparent: true, opacity: 0.5 });
      const hw = (cfg.slotPitch * 0.9) / 2;
      const hd = 1.9 / 2;
      const edge = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(cell.x - hw, 0.014, cell.z - hd),
          new THREE.Vector3(cell.x + hw, 0.014, cell.z - hd),
          new THREE.Vector3(cell.x + hw, 0.014, cell.z + hd),
          new THREE.Vector3(cell.x - hw, 0.014, cell.z + hd)
        ]),
        edgeMat
      );
      this.world.add(edge);

      const labelZ = cell.z + (cell.side === 'R' ? 0.72 : cell.side === 'L' ? -0.72 : 0.7);
      const label = this.createTextSprite(
        `${cell.side}${String(cell.column).padStart(2, '0')}`,
        { x: cell.x, y: 0.05, z: labelZ },
        0.5,
        sideInk[cell.side]
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
        duration: 1.15
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
    this.animateCargoTweens(delta);
    this.animateObstacles();
    this.animateSlotPulses();
    // 每 6 帧做一次间隙校核（AGV+货物外廓 vs 舱壁/已放货柜），贴近即报警。
    this.safetyFrame = (this.safetyFrame + 1) % 6;
    if (this.safetyFrame === 0) this.checkSafety();
    this.composer.render();
  };

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

  // ---------------------------------------------------------------------------
  // 安全间隙校核：AGV（含所载货物）外廓 vs 舱壁 / 已放货柜
  // ---------------------------------------------------------------------------

  /**
   * 用"AGV+货物"的有向矩形（OBB）做间隙校核：
   *  - 舱壁：左舷/右舷（右舷按门洞开口豁免）/机头隔框/机尾隔框；
   *  - 已放货柜：OBB 与货柜包围盒的分离距离（SAT，取各轴最大间隙，负值表示重叠）。
   * 舱外待命（z 在右舷壁之外）不做舱壁判定，避免把"在门外排队"误报成穿墙。
   */
  private checkSafety(): void {
    if (!this.agvManager) return;
    const cfg = this.config;
    const wallZ = cfg.hold.floorWidth / 2;
    const frontX = cfg.hold.wallThickness;
    const aftX = cfg.hold.length - cfg.hold.wallThickness;
    const doorSpec = cfg.doors.forward;
    const holeMin = doorSpec.x - doorSpec.width / 2;
    const holeMax = doorSpec.x + doorSpec.width / 2;
    const now = performance.now();

    for (const role of agvRoles(cfg)) {
      const pose = this.getAgvPose(role.id);
      if (!pose) continue;
      const payload = this.agvManager.getPayload(role.id);
      const cargoSpec = payload ? cfg.uld[payload.cargoType as keyof typeof cfg.uld] : null;
      const halfL = Math.max(cfg.agv.length, cargoSpec?.length ?? 0) / 2;
      const halfW = Math.max(cfg.agv.width, cargoSpec?.width ?? 0) / 2;
      const c = Math.cos(pose.yaw);
      const s = Math.sin(pose.yaw);

      const xs: number[] = [];
      const zs: number[] = [];
      for (const a of [-1, 1]) {
        for (const b of [-1, 1]) {
          xs.push(pose.x + a * halfL * c + b * halfW * s);
          zs.push(pose.z - a * halfL * s + b * halfW * c);
        }
      }
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs);
      const zMin = Math.min(...zs);
      const zMax = Math.max(...zs);

      let clearance = Infinity;
      let what = '';

      // 舱外待命/进出舱门阶段（整机在右舷壁之外）不做舱壁判定。
      const outsideHold = zMax < -wallZ + 0.02;
      if (!outsideHold) {
        const candidates: Array<[number, string]> = [
          [wallZ - zMax, '左舷舱壁'],
          [xMin - frontX, '机头隔框'],
          [aftX - xMax, '机尾隔框']
        ];
        // 右舷壁：整个车体 x 落在门洞内且正在穿越时豁免。
        const inDoorBand = xMin >= holeMin - 0.05 && xMax <= holeMax + 0.05;
        if (!inDoorBand) candidates.push([Math.min(Math.abs(zMax + wallZ), Math.abs(zMin + wallZ)), '右舷舱壁']);
        for (const [gap, name] of candidates) {
          if (gap < clearance) {
            clearance = gap;
            what = name;
          }
        }
      }

      // 与已放货柜的分离距离（SAT 近似，负值=重叠）。
      if (this.cargoManager) {
        this.cargoManager.occupancy.forEach((cargoId, slotId) => {
          const cell = slotCellOf(cfg, slotId);
          if (!cell || Math.hypot(cell.x - pose.x, cell.z - pose.z) > 6) return;
          const mesh = this.cargoManager.cargo.get(cargoId);
          const spec = cfg.uld[(mesh?.userData.cargoType ?? 'AKE') as keyof typeof cfg.uld];
          const hx = spec.length / 2;
          const hz = spec.width / 2;
          const dirX = c;
          const dirZ = -s;
          const latX = s;
          const latZ = c;
          const dx = cell.x - pose.x;
          const dz = cell.z - pose.z;
          const gapX = Math.abs(dx) - (hx + halfL * Math.abs(dirX) + halfW * Math.abs(latX));
          const gapZ = Math.abs(dz) - (hz + halfL * Math.abs(dirZ) + halfW * Math.abs(latZ));
          const gapD = Math.abs(dx * dirX + dz * dirZ) - (halfL + hx * Math.abs(dirX) + hz * Math.abs(dirZ));
          const gapL = Math.abs(dx * latX + dz * latZ) - (halfW + hx * Math.abs(latX) + hz * Math.abs(latZ));
          const gap = Math.max(gapX, gapZ, gapD, gapL);
          if (gap < clearance) {
            clearance = gap;
            what = `货位 ${slotId}`;
          }
        });
      }

      if (!Number.isFinite(clearance)) continue;

      const ring = this.ensureSafetyRing(role.id);
      const alarming = clearance < CLEARANCE_WARN;
      ring.visible = alarming;
      if (alarming) {
        ring.position.set(pose.x, 0.05, pose.z);
        const mat = ring.material as THREE.MeshBasicMaterial;
        mat.opacity = clearance < 0 ? 0.55 : 0.3;
        const last = this.safetyCooldown.get(role.id) ?? 0;
        if (now - last > 1800) {
          this.safetyCooldown.set(role.id, now);
          const mm = Math.round(Math.abs(clearance) * 1000);
          this.onSafety?.(
            clearance < 0 ? 'error' : 'warn',
            clearance < 0
              ? `${role.id} 外廓与${what}干涉约 ${mm} mm，请检查路径与货位`
              : `${role.id} 距${what}仅 ${mm} mm（警戒 < ${Math.round(CLEARANCE_WARN * 1000)} mm）`
          );
        }
      }
    }
  }

  private ensureSafetyRing(agvId: string): THREE.Mesh {
    const existing = this.safetyRings.get(agvId);
    if (existing) return existing;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.25, 1.55, 40),
      new THREE.MeshBasicMaterial({ color: C_RED, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    this.world.add(ring);
    this.safetyRings.set(agvId, ring);
    return ring;
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

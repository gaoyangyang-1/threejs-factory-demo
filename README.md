# 飞机货运 AGV 智能运输数字孪生系统

基于 Vue 3 + TypeScript + Three.js 的浏览器端**飞机货舱 AGV 智能运输**数字孪生展示系统（由智慧工厂数字孪生项目二次开发）。围绕
"货物进入飞机货舱 → AGV 自动取货 → 算法规划路径 → 货舱内自主运输 → 障碍物自动避让 → 抵达目标位置 → 货物自动排列放置 → AGV 完成任务"
全流程进行三维实时渲染，参数可配置，并预留真实算法（路径规划/避障/调度/排列/强化学习）接入接口。不依赖真实 ROS/Gazebo 机器人仿真平台。

技术方案与评审修订见 [`docs/方案.md`](./docs/方案.md)，算法对接细节见 [`docs/算法接入协议.md`](./docs/算法接入协议.md)。

## 特性

- **机体坐标硬约束**：机头原点 O(0,0,0)，+X 逆航向（机尾）、+Y 竖直向上、+Z 飞行方向左侧（左舷）；1 单位 = 1 m，与 three.js y-up 右手系同构，直接建模。
- **货舱布局**：剖开式货舱（地板/侧壁/肋骨骨架/机头机尾隔板）；前、后货舱门位于右舷 -Z（含墙洞开口、轴向滑移门扇动画、门外装卸平台）；双排槽位格 + 编号 + 目标槽脉冲闪烁。
- **三种标准货柜参数化**：AKE(LD-3) / PMX / PAX，主体 + 轮廓线框 + 托盘示意，尺寸集中定义、可 UI 修改即重建。
- **AGV 转运模块**：外部指令（moveTo/turnTo/pick/place）增量驱动，位置插值 + 轮组转向示意 + 顶升平台取放 + 状态指示灯；多台 AGV 按前/后舱分工并行作业。
- **演示编排源（MockScheduler）**：浏览器内按消息契约完整演示 单货物/多货物同时装载 流程——开舱门、平台生成货物、滑入舱内交接位、空驶取货、载货走廊运输、障碍检测与路径重规划绕行、目标列横移入位、任务完成复位。非算法实现，仅占位。
- **算法接入接口（AlgorithmAdapter）**：WebSocket 同契约收发（帧编解码 + 断线退避重连），前端 UI 可切换消息源并配置地址。
- **任务与状态面板**：参数控制面板（货舱/门/槽位/AGV/三种 ULD）；任务控制（单/多装载、货型、件数、目标槽选择）；任务列表、AGV 实时卡、舱位占用格、运行日志与 KPI；启停/暂停/重置/自动演示。
- **场景重建与运维**：config 变更即整场景重建（几何 dispose 防泄漏）、ResizeObserver 自适应、会话重置、双击自动演示至货满。

## 运行与构建

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 质量门：vue-tsc --noEmit && vite build，产物 dist/
npm run preview
```

在线演示（GitHub Pages，push 到 work / main 自动重新部署）：
<https://gaoyangyang-1.github.io/threejs-factory-demo/>

## 移动端适配

窄屏（≤ 900px，手机 / 竖屏平板）自动切换为「三维场景 + 底部标签抽屉」布局，桌面大屏布局与取景保持不变：

- **顶栏**：收起英文副标题，运行操作与 KPI 指标合并为一条可横向滑动的操作条，避免挤出屏幕。
- **底部标签栏**：三维场景 / 参数控制 / 任务调度 / 运行日志；点击展开抽屉，再次点击同一标签或点遮罩收起。
- **抽屉**：参数、任务、日志三块面板改为浮层（约 64% 屏高、内部独立滚动，日志最多展示 60 条），桌面端仍为大屏三栏。
- **触控交互**：三维视口 `touch-action: none`，手势全部交给 OrbitControls（单指旋转、双指缩放/平移）；输入框字号 16px 避免 iOS 聚焦自动缩放；按钮与货位格放大到可点按尺寸。
- **竖屏取景**：按内容包围盒二分求距 + 沿机身纵向俯视，保证整舱（两侧货位、右舷双舱门与装卸平台）完整入画并居中；横竖屏切换、参数重建后自动重新取景。
- **移动端性能**：渲染倍率上限 1.5、阴影响应图 1024，降低移动 GPU 压力。
- **安全区**：`viewport-fit=cover` + `env(safe-area-inset-bottom)`，适配 iPhone 刘海屏与圆角屏。

验证方式（无头 Chrome + CDP）：390×844 / 360×640 竖屏与 844×390 横屏下抽屉、取景、触控目标均已验证；1440×900 桌面渲染与适配前逐像素一致。

## 目录结构（要点）

```text
src/
  config/cargo.ts               布局/尺寸/门位/ULD 参数（唯一默认值）
  types/cargo.ts                SceneCommand / AlgorithmEvent / ControlCommand 契约
  utils/{coord,layout}.ts       坐标换算 / 槽位与走廊几何纯函数
  scene/FactoryScene.ts         货舱 + 门 + 槽位 + 路径/障碍/目标脉冲图层 + 场景探针
  managers/{AGVTransportManager,CargoManager}.ts
  store/cargoStore.ts           任务/AGV/货物/门/日志单一状态镜像
  websocket/TransportMessageBus.ts   下行分发 + 上行控制 + 探针
  websocket/MockScheduler.ts    演示编排源（非算法）
  websocket/AlgorithmAdapter.ts 真实算法 WS 接入（预留）
  views/CargoDigitalTwin.vue    页面编排
  components/scene/ThreeCargoViewport.vue  场景生命周期 + SceneCommand 路由 + config 重建
  components/layout/*.vue       顶栏/参数面板/任务与状态面板/日志
docs/ 方案.md · 算法接入协议.md
```

## 坐标系速查

| 记号 | 含义 |
|---|---|
| O(0,0,0) | 机头原点；地板上表面 Y=0 |
| +X / 机尾向 | 机头 → 机尾（逆航向） |
| +Y | 竖直向上 |
| +Z | 飞行方向左侧（左舷 port） |
| 舱门 | forward/aft，均位于右舷 -Z |
| SLOT-L-xx / SLOT-R-xx | 左舷/右舷货位（机头起 00 递增） |

## 浏览器兼容

建议使用支持 WebGL2 的现代浏览器：Chrome / Edge / Firefox / Safari 16+。

## 开源协议

MIT License（见 [LICENSE](./LICENSE)）。

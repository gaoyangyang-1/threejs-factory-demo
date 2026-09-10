# Copilot Instructions

Smart Factory Digital Twin — a Vue 3 + TypeScript + Three.js portfolio project that renders a factory floor with AGVs, IoT devices, live alarms, and ECharts dashboards. All data is mocked in the frontend.

## Commands

```bash
npm install       # install dependencies
npm run dev       # dev server on http://localhost:5173 (host 0.0.0.0)
npm run build     # type-check (vue-tsc --noEmit) then vite build -> dist/
npm run preview   # serve the production build locally
```

- There is **no test suite and no linter configured**. `npm run build` is the single gate: it runs `vue-tsc --noEmit` for type checking plus the Vite build.
- To type-check only: `npx vue-tsc --noEmit`.

## Architecture

### Real-time data flow (unidirectional, mock-driven)

```
WebSocketService (simulated source)
  └─ FactoryMessage union → subscribe(handler)         (src/websocket/WebSocketService.ts)
       └─ Pinia factoryStore — single source of truth  (src/store/factoryStore.ts)
            ├─ Vue panels/charts (TopBar, LeftPanel, RightPanel, DataCharts, ...)
            └─ ThreeFactoryViewport.vue → FactoryScene.updateDevice()/updateAgv()
```

- `WebSocketService` is a **mock**, not a real socket: it emits a `FactoryMessage` discriminated union (`snapshot | device:update | agv:update | alarm | log`) on a `setInterval`. Swapping in a real WebSocket must preserve that message structure.
- The view `FactoryDigitalTwin.vue` subscribes in `onMounted` and forwards every message type into the store; it unsubscribes and calls `disconnect()` on unmount.
- Store mutations follow this convention: snapshots replace whole collections; single entities use `updateDevice`/`updateAgv` (upsert by `id`); alarms/logs are prepended with a hard cap (8 alarms, 12 logs).

### 3D scene (src/scene/, src/managers/, src/three/)

- `ThreeFactoryViewport.vue` owns the `FactoryScene` lifecycle: constructed in `onMounted`, `dispose()` in `onBeforeUnmount`, resized via a `ResizeObserver`. Vue component ↔ scene communication goes through imperative methods (`updateDevice`, `updateAgv`, `resize`, `dispose`) driven by deep watchers on props.
- `FactoryScene` composes sub-systems: `DeviceManager` (device meshes + status visuals), one `AGVController` per AGV, and `ModelManager`. Render loop is a single `requestAnimationFrame` in `animate()`; render goes through `EffectComposer` (RenderPass → UnrealBloomPass → FXAA). FXAA's `resolution` uniform must be updated in `resize()`.
- **AGV motion is simulated locally in the scene**, not from telemetry: `AGVController.update(delta)` advances `progress` along a closed `CatmullRomCurve3` and slerps rotation. Incoming telemetry (`applyTelemetry`) only overrides the state machine (`state`/`battery`/`task`); only `state === 'moving'` advances the path, other states freeze position.
- Device status/power/temperature comes only from telemetry. Status → color/emissive mapping lives in `DeviceManager.statusColor` (3D) and must stay consistent with `.status-*` classes in `src/assets/styles/global.css` (UI). Statuses: `running | warning | error | offline`.
- Picking: `Raycaster` intersects only `deviceManager.getInteractiveObjects()` (device root groups). Attribution walks up via `userData.deviceId`. Root groups carry `userData = { type: 'device'|'agv', ... }`.
- **The whole scene is procedural** — no external glTF/GLB assets are loaded today. `ModelManager` (GLTF + DRACO + KTX2, Promise-based `load` cache, `SkeletonUtils.clone` for instancing) and `public/draco`, `public/basis` decoder files exist for when real models are added.
- Everything is added in one factory-floor coordinate space (~±9 units); factory layout construction (`createZone`, floor, warehouse, conveyors) is defined in `FactoryScene`.

## Conventions

- All imports use the `@/` alias → `src/`. Type-only imports must use `import type` (`isolatedModules` is on). TS is `strict`.
- Domain types live centrally in `src/types/factory.ts` (`DeviceStatus`, `AGVState`, telemetry interfaces, `FactorySnapshot`). Managers keep runtime state in `Map<string, T>` keyed by id.
- Entity IDs: devices `DEV-01`…, AGVs `AGV-01`…, alarms/logs from `createId(prefix)` (`src/utils/time.ts`).
- **Resource disposal is mandatory**: scene classes implement `dispose()` that removes event listeners, stops RAF, disposes geometries/materials (see `src/utils/dispose.ts`), and clears managers. Any new `THREE` object added to a scene must be added to the relevant dispose path and get its geometry/material disposed. DOM listeners are stored as arrow-function class fields so they can be removed.
- `.vue` files use `<script setup lang="ts">`, props typed with `defineProps<T>()`, child → parent via `defineEmits`. Page data comes from the Pinia store via `storeToRefs`.
- Element Plus components are imported individually with their per-component CSS (e.g. `import { ElTag } from 'element-plus'; import 'element-plus/es/components/tag/style/css'`) — no auto-import plugin.
- ECharts is tree-shaken: `echarts/core` + explicit chart/component/renderer imports registered via `echarts.use([...])`.
- Source-code comments are written in **simplified Chinese**; identifiers stay English. UI labels/names (zones, devices, log text) are Chinese.
- The dark "digital twin" palette is defined by `#07111f` background and the accent colors in `statusColor`/`global.css` (`#1d8fff` blue, `#39f5b6` green, `#ffc857` amber, `#ff4d6d` red). Reuse these — do not introduce new ad-hoc colors.
- Vite `manualChunks` in `vite.config.ts` split `vue`/`pinia`, `three`, and `echarts` into separate bundles; new heavy deps should get their own chunk.

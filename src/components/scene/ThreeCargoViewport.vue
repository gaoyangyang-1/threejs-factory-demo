<template>
  <main class="viewport-shell">
    <div ref="containerRef" class="three-container"></div>
  </main>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FactoryScene } from '@/scene/FactoryScene';
import { useCargoStore } from '@/store/cargoStore';
import type { AlgorithmEvent } from '@/types/cargo';
import { transportBus } from '@/websocket/TransportMessageBus';

const store = useCargoStore();
const { config, epoch } = storeToRefs(store);

const containerRef = ref<HTMLDivElement | null>(null);
let scene: FactoryScene | null = null;
let resizeObserver: ResizeObserver | null = null;
let unsubscribeBus: (() => void) | null = null;

/** 场景只消费 SceneCommand 子集，其余状态事件交给 cargoStore。 */
function forwardToScene(event: AlgorithmEvent) {
  if (!scene) return;
  switch (event.type) {
    case 'scene:reset':
    case 'agv:command':
    case 'cargo:pickup':
    case 'cargo:place':
    case 'cargo:spawn':
    case 'cargo:move':
    case 'path:plan':
    case 'obstacle:event':
    case 'slot:mark':
    case 'door:set':
      scene.handleSceneCommand(event);
      break;
    default:
      break;
  }
}

onMounted(() => {
  scene = new FactoryScene({ container: containerRef.value! });
  scene.start();
  transportBus.registerProbe({
    agvPose: (id) => scene!.getAgvPose(id),
    cargoPose: (id) => scene!.getCargoPose(id),
    doorProgress: (id) => scene!.doorProgress(id)
  });
  unsubscribeBus = transportBus.subscribe(forwardToScene);
  resizeObserver = new ResizeObserver(() => scene?.resize());
  resizeObserver.observe(containerRef.value!);
});

// 布局/运行参数或会话重置(epoch) → 整场景按最新 config 重建。
watch(
  () => [config.value, epoch.value],
  () => {
    if (!scene) return;
    scene.applyConfig(JSON.parse(JSON.stringify(config.value)) as never);
  },
  { deep: true }
);

onBeforeUnmount(() => {
  unsubscribeBus?.();
  transportBus.registerProbe(null);
  resizeObserver?.disconnect();
  scene?.dispose();
  scene = null;
});
</script>

<style scoped>
.viewport-shell {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.three-container {
  width: 100%;
  height: 100%;
}

/* 手势全部交给 OrbitControls（单指旋转 / 双指缩放平移），避免页面随之滚动缩放。 */
.three-container :deep(canvas) {
  display: block;
  outline: none;
  touch-action: none;
}
</style>

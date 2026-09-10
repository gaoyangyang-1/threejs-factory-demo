<template>
  <div class="cargo-page" :class="pageClass">
    <TopBar />

    <!-- 内容区：桌面为大屏三栏，移动端为「三维场景 + 底部标签抽屉」 -->
    <div class="stage">
      <ThreeCargoViewport />
      <LeftPanel />
      <RightPanel />
      <BottomLogs />

      <div v-if="sheetOpen" class="sheet-scrim" @click="activeTab = 'scene'"></div>

      <nav v-if="isMobile" class="mobile-tabs panel">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="tab-btn"
          :class="{ on: activeTab === tab.key }"
          @click="selectTab(tab.key)"
        >
          <span class="tab-icon">{{ tab.icon }}</span>
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </nav>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BottomLogs from '@/components/layout/BottomLogs.vue';
import LeftPanel from '@/components/layout/LeftPanel.vue';
import RightPanel from '@/components/layout/RightPanel.vue';
import TopBar from '@/components/layout/TopBar.vue';
import ThreeCargoViewport from '@/components/scene/ThreeCargoViewport.vue';
import { useCargoStore } from '@/store/cargoStore';
import { useIsMobile } from '@/utils/responsive';
import { transportBus } from '@/websocket/TransportMessageBus';

type TabKey = 'scene' | 'params' | 'tasks' | 'logs';

/** 移动端底部标签：三维场景 / 参数控制 / 任务调度 / 运行日志。 */
const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'scene', label: '三维场景', icon: '🛫' },
  { key: 'params', label: '参数控制', icon: '⚙️' },
  { key: 'tasks', label: '任务调度', icon: '📋' },
  { key: 'logs', label: '运行日志', icon: '📜' }
];

const store = useCargoStore();
const isMobile = useIsMobile();
const activeTab = ref<TabKey>('scene');

/** 再次点击当前标签可收起抽屉，回到三维场景。 */
function selectTab(key: TabKey) {
  activeTab.value = activeTab.value === key && key !== 'scene' ? 'scene' : key;
}

const sheetOpen = computed(() => isMobile.value && activeTab.value !== 'scene');
const pageClass = computed(() => (isMobile.value ? ['is-mobile', `tab-${activeTab.value}`] : []));

let unsubscribeBus: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

onMounted(() => {
  // store 镜像订阅（状态/任务/AGV/货物/门/日志）。
  unsubscribeBus = transportBus.subscribe((event) => store.onBusEvent(event));
  unsubscribeStatus = transportBus.subscribeStatus((status) => store.onBusStatus(status));
  // 初始化领域状态并以演示编排源启动。
  store.boot();
  store.connectSource('mock');
});

onBeforeUnmount(() => {
  unsubscribeBus?.();
  unsubscribeStatus?.();
});
</script>

<style scoped>
.cargo-page {
  position: relative;
  display: flex;
  width: 100vw;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  background:
    linear-gradient(90deg, rgba(22, 119, 255, 0.05), transparent 32%, transparent 68%, rgba(15, 174, 111, 0.04)),
    #eef3f9;
}

/* 内容区：顶栏按内容自适应高度，其余空间全部给三维场景（横竖屏都不会错位）。 */
.stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.stage::after {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(255, 255, 255, 0.5), transparent 26%, transparent 74%, rgba(255, 255, 255, 0.5)),
    linear-gradient(180deg, rgba(255, 255, 255, 0.25), transparent 42%, rgba(255, 255, 255, 0.7));
  content: "";
}

/* 抽屉遮罩：位于三维场景之上、面板之下（面板 z-index 为 6）。 */
.sheet-scrim {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: rgba(16, 42, 74, 0.28);
  backdrop-filter: blur(1px);
}

/* 底部标签栏（仅移动端渲染） */
.mobile-tabs {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 7;
  display: flex;
  height: calc(var(--tab-h) + var(--safe-b));
  padding-bottom: var(--safe-b);
  border-radius: 0;
}

.tab-btn {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0;
  border: 0;
  border-top: 2px solid transparent;
  background: transparent;
  color: #5d86ad;
  font-size: 11px;
  cursor: pointer;
  touch-action: manipulation;
}

.tab-btn.on {
  border-top-color: var(--accent);
  color: var(--accent-deep);
  font-weight: 700;
}

.tab-icon {
  font-size: 16px;
  line-height: 1;
}

.tab-label {
  line-height: 1.2;
}

@media (max-width: 900px) {
  /* 三块面板在移动端统一改为底部抽屉：默认收起，点击标签栏展开。 */
  .cargo-page :deep(.left-panel),
  .cargo-page :deep(.right-panel),
  .cargo-page :deep(.bottom-logs) {
    top: auto;
    right: 6px;
    bottom: calc(var(--tab-h) + var(--safe-b) + 6px);
    left: 6px;
    z-index: 6;
    display: none;
    width: auto;
    height: min(64%, 520px);
    max-height: calc(100% - var(--tab-h) - var(--safe-b) - 18px);
    padding: 8px 12px 6px;
    border-radius: 14px;
    box-shadow: 0 -10px 30px rgba(24, 62, 110, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  }

  .tab-params :deep(.left-panel),
  .tab-tasks :deep(.right-panel) {
    display: flex;
  }

  .tab-logs :deep(.bottom-logs) {
    display: flex;
    flex-direction: column;
  }
}
</style>

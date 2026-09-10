<template>
  <header class="top-bar panel">
    <div class="brand-block">
      <div class="brand-mark"></div>
      <div>
        <h1>飞机货运 AGV 智能运输数字孪生</h1>
        <p>Air Cargo AGV Smart Transport · Digital Twin Operation Center</p>
      </div>
    </div>

    <!-- 桌面端 run-strip 为 display:contents（保持原大屏同行布局）；移动端折行为可横向滑动的操作条 -->
    <div class="run-strip">
      <div class="run-controls">
        <button class="c-btn primary" :disabled="store.runState === 'running'" @click="store.startRun()">▶ 启动运行</button>
        <button v-if="store.runState === 'paused'" class="c-btn" @click="store.resumeRun()">⏵ 继续</button>
        <button v-else class="c-btn" :disabled="store.runState !== 'running'" @click="store.pauseRun()">⏸ 暂停</button>
        <button class="c-btn danger" @click="store.resetSession()">⟲ 重置场景</button>
        <label class="c-switch">
          <input type="checkbox" :checked="store.autoDemo" @change="store.toggleAutoDemo()" />
          自动演示
        </label>
      </div>

      <div class="metrics">
        <div class="metric">
          <span>运行状态</span>
          <strong :class="runClass">{{ runLabel }}</strong>
        </div>
        <div class="metric">
          <span>AGV 在途/总数</span>
          <strong>{{ store.agvBusyCount }}/{{ store.agvs.length }}</strong>
        </div>
        <div class="metric">
          <span>已完成任务</span>
          <strong>{{ store.doneTaskCount }}</strong>
        </div>
        <div class="metric connect">
          <span>消息源 · {{ store.sourceLabel }}</span>
          <strong :class="store.connected ? 'online' : 'offline'">{{ store.connected ? 'ONLINE' : 'OFFLINE' }}</strong>
        </div>
        <div class="clock">{{ clock }}</div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useCargoStore } from '@/store/cargoStore';
import { formatClock } from '@/utils/time';

const store = useCargoStore();

const clock = ref(formatClock());
let timer: number | null = null;

const runLabel = computed(() => {
  if (store.runState === 'running') return '运行中';
  if (store.runState === 'paused') return '已暂停';
  return '待命';
});
const runClass = computed(() => (store.runState === 'running' ? 'online' : store.runState === 'paused' ? 'warn' : 'offline'));

onMounted(() => {
  timer = window.setInterval(() => {
    clock.value = formatClock();
  }, 1000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer ?? undefined);
});
</script>

<style scoped>
.top-bar {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 18px;
  height: 76px;
  padding: 0 20px;
  border-radius: 0;
}

.brand-block {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
}

.brand-mark {
  width: 38px;
  height: 38px;
  border: 1px solid rgba(22, 119, 255, 0.7);
  background: linear-gradient(135deg, rgba(22, 119, 255, 0.22), rgba(15, 174, 111, 0.24));
  box-shadow: 0 0 16px rgba(22, 119, 255, 0.28);
  clip-path: polygon(50% 0, 100% 28%, 100% 72%, 50% 100%, 0 72%, 0 28%);
}

h1 {
  margin: 0;
  color: #123b73;
  font-size: 20px;
  font-weight: 800;
  white-space: nowrap;
}

.brand-block p {
  margin: 3px 0 0;
  color: #6484a8;
  font-size: 11px;
  white-space: nowrap;
}

/* 桌面端保持原有「品牌 / 操作 / 指标」同行布局 */
.run-strip {
  display: contents;
}

.run-controls {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.metrics {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
}

.metric {
  min-width: 86px;
  padding: 6px 10px;
  border: 1px solid #d3e0f0;
  border-radius: 6px;
  background: rgba(243, 248, 254, 0.85);
}

.metric.connect {
  min-width: 128px;
}

.metric span {
  display: block;
  overflow: hidden;
  color: #6484a8;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric strong {
  display: block;
  margin-top: 2px;
  color: #16345c;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.metric strong.online {
  color: #0f9d63;
}

.metric strong.warn {
  color: #c37f06;
}

.metric strong.offline {
  color: #c33238;
}

.clock {
  width: 170px;
  color: #16345c;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 移动端：品牌一行、操作与指标合并为一条可横向滑动的操作条 */
@media (max-width: 900px) {
  .top-bar {
    height: auto;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
  }

  .brand-block {
    flex: 1 1 100%;
    min-width: 0;
    gap: 8px;
  }

  .brand-block > div {
    min-width: 0;
  }

  .brand-mark {
    width: 26px;
    height: 26px;
  }

  h1 {
    overflow: hidden;
    font-size: 15px;
    text-overflow: ellipsis;
  }

  .brand-block p {
    display: none;
  }

  .run-strip {
    display: flex;
    flex: 1 1 100%;
    align-items: center;
    gap: 8px;
    padding-bottom: 2px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
  }

  .run-controls {
    flex: 0 0 auto;
    justify-content: flex-start;
    gap: 6px;
  }

  .metrics {
    flex: 0 0 auto;
    gap: 6px;
  }

  .metric {
    min-width: 76px;
    padding: 3px 8px;
  }

  .metric.connect {
    min-width: 108px;
  }

  .metric span {
    font-size: 10px;
  }

  .metric strong {
    margin-top: 1px;
    font-size: 13px;
  }

  .clock {
    display: none;
  }
}
</style>

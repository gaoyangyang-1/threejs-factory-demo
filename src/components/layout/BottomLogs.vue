<template>
  <footer class="bottom-logs panel">
    <div class="panel-title">
      实时运行日志
      <span class="clear-link" @click="store.logs = []">清空</span>
    </div>
    <div class="ticker">
      <div v-for="log in logs" :key="log.id" class="log-item">
        <span class="time">{{ log.time.slice(11) }}</span>
        <span class="level" :class="`lv-${log.level}`">{{ levelText(log.level) }}</span>
        <p>{{ log.message }}</p>
      </div>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useCargoStore } from '@/store/cargoStore';
import { useIsMobile } from '@/utils/responsive';

const store = useCargoStore();
const isMobile = useIsMobile();
/** 桌面端日志条仅 108px 高（约 2 行）；移动端抽屉内可滚动查看更多历史。 */
const logs = computed(() => store.logs.slice(0, isMobile.value ? 60 : 7));
const levelText = (level: string) => (level === 'info' ? '信息' : level === 'warn' ? '预警' : '故障');
</script>

<style scoped>
.bottom-logs {
  position: absolute;
  right: 18px;
  bottom: 16px;
  left: 18px;
  z-index: 3;
  height: 108px;
  padding: 8px 14px;
  overflow: hidden;
}

.panel-title {
  height: 26px;
}

.clear-link {
  color: #6f92b8;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.clear-link:hover {
  color: #1677ff;
}

.ticker {
  display: flex;
  height: 60px;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}

.log-item {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border: 1px solid #e6edf6;
  border-radius: 4px;
  background: #ffffff;
  color: #27476f;
  font-size: 12px;
}

.time {
  flex: 0 0 auto;
  color: #1677ff;
  font-variant-numeric: tabular-nums;
}

.level {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
}

.lv-info {
  background: rgba(22, 119, 255, 0.12);
  color: #0f5fd0;
}

.lv-warn {
  background: rgba(245, 165, 36, 0.16);
  color: #c37f06;
}

.lv-error {
  background: rgba(229, 72, 77, 0.14);
  color: #c33238;
}

.log-item p {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 移动端：日志抽屉内可滚动查看，长文案允许换行显示完整内容 */
@media (max-width: 900px) {
  .panel-title {
    height: 24px;
    font-size: 13px;
  }

  .ticker {
    height: auto;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .log-item {
    align-items: flex-start;
    font-size: 12px;
  }

  .log-item p {
    overflow: visible;
    word-break: break-all;
    white-space: normal;
  }

  .time {
    padding-top: 1px;
  }
}
</style>

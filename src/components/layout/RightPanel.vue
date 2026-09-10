<template>
  <aside class="right-panel panel">
    <div class="panel-title">任务控制 · Task Dispatch</div>
    <div class="scroll-body">
      <!-- 任务下发 -->
      <section class="card">
        <div class="card-title">装载任务下发</div>
        <div class="dispatch-grid">
          <div class="mode-row">
            <button class="seg" :class="{ on: mode === 'single' }" @click="mode = 'single'">单货物装载</button>
            <button class="seg" :class="{ on: mode === 'multi' }" @click="mode = 'multi'">多货物同时装载</button>
          </div>
          <div class="c-field">
            <label>货物类型</label>
            <select v-model="cargoType" class="c-select">
              <option v-for="t in types" :key="t" :value="t">{{ meta[t].label }}</option>
            </select>
          </div>
          <div v-if="mode === 'multi'" class="c-field">
            <label>件数（2-6）</label>
            <select v-model.number="count" class="c-select">
              <option v-for="n in [2, 3, 4, 5, 6]" :key="n" :value="n">{{ n }} 件（多 AGV 并行/串行编排）</option>
            </select>
          </div>
          <div v-else-if="store.mode === 'mock'" class="c-field">
            <label>目标槽位</label>
            <select v-model="slotChoice" class="c-select">
              <option value="">自动适配</option>
              <option v-for="s in candidates" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div v-else class="c-field">
            <label>目标槽位</label>
            <span class="dim-text">由算法方决策</span>
          </div>
        </div>
        <div class="dispatch-actions">
          <button class="c-btn primary" :disabled="!store.canDispatch" @click="dispatch">下发任务</button>
          <span class="hint dim">启动系统且空闲时方可下发</span>
        </div>
      </section>

      <!-- 运行统计 -->
      <section class="card kpis">
        <div class="kpi">
          <span>执行中</span>
          <strong>{{ store.activeTaskCount }}</strong>
        </div>
        <div class="kpi">
          <span>已完成</span>
          <strong>{{ store.doneTaskCount }}</strong>
        </div>
        <div class="kpi">
          <span>空闲货位</span>
          <strong>{{ store.freeSlotCount }}/{{ store.slotCountTotal }}</strong>
        </div>
        <div class="kpi">
          <span>在途 AGV</span>
          <strong>{{ store.agvBusyCount }}/{{ store.agvs.length }}</strong>
        </div>
      </section>

      <!-- 任务列表 -->
      <section class="card grow">
        <div class="card-title">任务列表</div>
        <div v-if="!store.tasks.length" class="empty">暂无任务，请下发</div>
        <div v-for="task in store.tasks.slice(0, 8)" :key="task.taskId" class="task-row">
          <div class="task-head">
            <strong>{{ task.taskId }}</strong>
            <span class="c-chip" :class="task.mode === 'single' ? 'blue' : 'green'">
              {{ task.mode === 'single' ? '单货物' : '多货物' }}
            </span>
            <span class="c-chip" :class="statusChip(task.status)">{{ statusText(task.status) }}</span>
            <button
              v-if="task.status === 'queued' || task.status === 'running'"
              class="c-btn danger sm"
              @click="store.cancelTask(task.taskId)"
            >
              取消
            </button>
          </div>
          <div class="task-items">
            <span v-for="(item, i) in task.items" :key="i" class="item-chip">{{ item.cargoType }}<i v-if="item.slotId">→{{ item.slotId }}</i></span>
          </div>
          <div class="progress">
            <div class="progress-bar" :style="{ width: task.progress + '%' }"></div>
          </div>
          <div class="task-msg">{{ task.message }}<em>{{ task.time.slice(11) }}</em></div>
        </div>
      </section>

      <!-- AGV 状态 -->
      <section class="card">
        <div class="card-title">AGV 实时状态</div>
        <div v-for="agv in store.agvs" :key="agv.id" class="agv-card">
          <div class="agv-head">
            <strong>{{ agv.id }} · {{ agv.name }}</strong>
            <span class="c-chip" :class="phaseChip(agv.phase)">{{ phaseText(agv.phase) }}</span>
          </div>
          <div class="agv-sub">{{ agv.role }}</div>
          <div class="agv-detail">
            <span>任务：{{ agv.taskId ?? '—' }}</span>
            <span v-if="agv.cargoType" class="load-chip" :style="{ borderColor: meta[agv.cargoType].color, color: meta[agv.cargoType].color }">
              载货 {{ agv.cargoType }}
            </span>
            <span v-else class="dim-text">空载</span>
          </div>
        </div>
      </section>

      <!-- 槽位占用图 -->
      <section class="card">
        <div class="card-title">舱位占用（点击可选中为目标槽）</div>
        <div class="slot-legend">
          <span><i class="dot free"></i>空</span>
          <span><i class="dot occupied"></i>已装</span>
          <span><i class="dot pending"></i>指派中</span>
          <span><i class="dot selected"></i>目标</span>
        </div>
        <div class="slot-rows">
          <div class="slot-row">
            <span class="row-side">左 L(+Z)</span>
            <button
              v-for="tile in tiles('L')"
              :key="tile.slotId"
              class="slot-cell"
              :class="tile.state"
              :title="tile.slotId"
              @click="pickTile(tile)"
            >
              {{ tile.column + 1 }}
            </button>
          </div>
          <div class="slot-row">
            <span class="row-side">右 R(-Z)</span>
            <button
              v-for="tile in tiles('R')"
              :key="tile.slotId"
              class="slot-cell"
              :class="tile.state"
              :title="tile.slotId"
              @click="pickTile(tile)"
            >
              {{ tile.column + 1 }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CargoType } from '@/types/cargo';
import { ULD_META, ULD_TYPES } from '@/config/cargo';
import { useCargoStore } from '@/store/cargoStore';

const store = useCargoStore();
const types = ULD_TYPES;
const meta = ULD_META;

const mode = ref<'single' | 'multi'>('single');
const cargoType = ref<CargoType>('AKE');
const count = ref(3);
const slotChoice = ref('');

const candidates = computed(() => (store.mode === 'mock' ? store.candidateSlots(cargoType.value) : []));
watch([cargoType, () => store.mode], () => {
  slotChoice.value = '';
});

function dispatch() {
  const slotId = store.mode === 'mock' && slotChoice.value ? slotChoice.value : null;
  store.dispatchTask({ mode: mode.value, type: cargoType.value, count: count.value, slotId });
}

/** 点击货位格：仅空闲格可选择/取消为目标槽（同步到槽位下拉）。 */
function pickTile(tile: { slotId: string; state: string }) {
  if (tile.state === 'occupied' || tile.state === 'pending') return;
  const next = store.selectedSlotId === tile.slotId ? null : tile.slotId;
  store.selectSlot(next);
  slotChoice.value = next ?? '';
}

function tiles(side: 'L' | 'R') {
  return store.slotTiles.filter((t) => t.side === side).sort((a, b) => a.column - b.column);
}

const statusText = (s: string) =>
  s === 'queued' ? '排队' : s === 'running' ? '执行中' : s === 'done' ? '完成' : s === 'failed' ? '异常' : '已取消';
const statusChip = (s: string) =>
  s === 'done' ? 'green' : s === 'running' ? 'amber' : s === 'failed' ? 'red' : s === 'cancelled' ? 'gray' : 'blue';

const phaseText = (p: string) =>
  p === 'idle' ? '待命' : p === 'toPickup' ? '驶向取货' : p === 'pickup' ? '取货中' : p === 'transport' ? '运输中' : p === 'placing' ? '放置中' : p === 'done' ? '已完成' : p === 'error' ? '异常' : p;
const phaseChip = (p: string) =>
  p === 'idle' ? 'gray' : p === 'error' ? 'red' : p === 'placing' ? 'amber' : p === 'transport' ? 'green' : 'blue';
</script>

<style scoped>
.right-panel {
  position: absolute;
  /* 定位于 .stage 内容区内：16px ≈ 原页面坐标 92px（顶栏 76px + 16px），保持桌面大屏位置不变 */
  top: 16px;
  right: 18px;
  bottom: 126px;
  z-index: 3;
  display: flex;
  width: 400px;
  flex-direction: column;
  padding: 10px 12px 8px;
  overflow: hidden;
}

.panel-title {
  flex: 0 0 auto;
  height: 30px;
}

.scroll-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(22, 119, 255, 0.5) rgba(255, 255, 255, 0.6);
}

.card {
  flex: 0 0 auto;
  padding: 8px 10px;
  border: 1px solid #dfe9f6;
  border-radius: 6px;
  background: #ffffff;
}

.card.grow {
  flex: 1 1 auto;
  min-height: 120px;
}

.card-title {
  margin-bottom: 6px;
  color: #1151a8;
  font-size: 13px;
  font-weight: 700;
}

.dim-text {
  color: #8ba4bf;
  font-size: 12px;
}

.mode-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.seg {
  flex: 1;
  padding: 5px 4px;
  border: 1px solid #c3d5ec;
  border-radius: 5px;
  background: #f4f9ff;
  color: #46698c;
  font-size: 12px;
  cursor: pointer;
}

.seg.on {
  border-color: rgba(15, 174, 111, 0.7);
  background: rgba(15, 174, 111, 0.14);
  color: #0a8a56;
  font-weight: 700;
}

.dispatch-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.hint.dim {
  color: #8ba4bf;
  font-size: 11px;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 6px 10px;
}

.kpi span {
  display: block;
  color: #6484a8;
  font-size: 11px;
}

.kpi strong {
  display: block;
  margin-top: 2px;
  color: #16345c;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}

.empty {
  padding: 14px 0;
  color: #8ba4bf;
  font-size: 12px;
  text-align: center;
}

.task-row {
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid #dfe9f6;
  border-radius: 6px;
  background: #f7faff;
}

.task-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.task-head strong {
  color: #16345c;
  font-size: 12px;
}

.task-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 5px 0;
}

.item-chip {
  padding: 1px 6px;
  border: 1px solid rgba(22, 119, 255, 0.4);
  border-radius: 3px;
  color: #0f5fd0;
  font-size: 10px;
  background: rgba(22, 119, 255, 0.06);
}

.item-chip i {
  margin-left: 3px;
  color: #0a8a56;
  font-style: normal;
}

.progress {
  height: 4px;
  border-radius: 2px;
  background: #e3ebf5;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #1677ff, #0fae6f);
  transition: width 0.3s ease;
}

.task-msg {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: #5d86ad;
  font-size: 11px;
}

.task-msg em {
  color: #9ab0c8;
  font-style: normal;
}

.agv-card {
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid #dfe9f6;
  border-radius: 6px;
  background: #f7faff;
}

.agv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.agv-head strong {
  color: #16345c;
  font-size: 12px;
}

.agv-sub {
  margin: 3px 0;
  color: #8ba4bf;
  font-size: 11px;
}

.agv-detail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #46698c;
  font-size: 11px;
}

.load-chip {
  padding: 1px 6px;
  border: 1px solid;
  border-radius: 3px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.7);
}

.slot-legend {
  display: flex;
  gap: 12px;
  margin-bottom: 6px;
  color: #46698c;
  font-size: 11px;
}

.slot-legend i.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 3px;
  border-radius: 2px;
  vertical-align: -1px;
}

.slot-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slot-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.row-side {
  flex: 0 0 62px;
  color: #46698c;
  font-size: 11px;
}

.slot-cell {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0;
  border: 1px solid #c9d9ec;
  border-radius: 3px;
  background: rgba(22, 119, 255, 0.05);
  color: #7d97b5;
  font-size: 10px;
  cursor: pointer;
}

.slot-cell.occupied {
  border-color: rgba(22, 119, 255, 0.55);
  background: rgba(22, 119, 255, 0.22);
  color: #0f5fd0;
  font-weight: 700;
}

.slot-cell.pending {
  border-color: rgba(245, 165, 36, 0.8);
  background: rgba(245, 165, 36, 0.22);
  color: #a86d00;
}

.slot-cell.selected {
  border-color: #0fae6f;
  background: rgba(15, 174, 111, 0.24);
  color: #0a7a4c;
  font-weight: 700;
  box-shadow: 0 0 8px rgba(15, 174, 111, 0.45);
}

.dot.free {
  background: rgba(22, 119, 255, 0.18);
}

.dot.occupied {
  background: #1677ff;
}

.dot.pending {
  background: #f5a524;
}

.dot.selected {
  background: #0fae6f;
}

.c-field {
  grid-template-columns: 76px 1fr;
}

/* 移动端：抽屉内更紧凑的指标与更大的触控目标 */
@media (max-width: 900px) {
  .panel-title {
    height: 26px;
    font-size: 13px;
  }

  .c-field {
    grid-template-columns: 68px 1fr;
  }

  .kpis {
    gap: 6px;
    padding: 6px 8px;
  }

  .kpi span {
    font-size: 10px;
  }

  .kpi strong {
    font-size: 15px;
  }

  .seg {
    min-height: 34px;
    padding: 8px 4px;
    font-size: 13px;
  }

  .dispatch-actions {
    flex-wrap: wrap;
  }

  .card.grow {
    min-height: 96px;
  }

  /* 货位格加大到手指可点按的尺寸 */
  .slot-cell {
    height: 30px;
    font-size: 11px;
  }

  .row-side {
    flex: 0 0 54px;
    font-size: 10px;
  }

  .slot-legend {
    flex-wrap: wrap;
    gap: 8px;
  }

  .agv-detail {
    flex-wrap: wrap;
    gap: 4px;
  }
}
</style>

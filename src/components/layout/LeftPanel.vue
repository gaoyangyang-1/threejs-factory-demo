<template>
  <aside class="left-panel panel">
    <div class="panel-title">参数控制面板 · Parameter Control</div>
    <div class="scroll-body">
      <!-- 运行接入 -->
      <section class="card">
        <div class="card-title">运行接入</div>
        <div class="row">
          <label class="c-field-label">消息源</label>
          <select v-model="draftMode" class="c-select">
            <option value="mock">演示编排（MockScheduler）</option>
            <option value="algorithm">算法接入（AlgorithmAdapter / WS）</option>
          </select>
        </div>
        <div v-if="draftMode === 'algorithm'" class="connect-row">
          <input v-model="algorithmUrl" class="c-input" placeholder="ws://host:port/algorithm" />
          <button class="c-btn sm" @click="applySource">连接</button>
        </div>
        <div v-else class="connect-row">
          <button class="c-btn sm" @click="applySource">切换演示编排</button>
        </div>
        <div class="hint">
          当前：{{ store.sourceLabel }} · <span :class="store.connected ? 'ok' : 'err'">{{ store.connected ? '已连接' : '未连接' }}</span>
        </div>
        <div class="hint dim">算法接入采用统一消息契约（docs/算法接入协议.md）；规划/避障/调度由算法方输出。</div>
      </section>

      <!-- 货舱布局参数 -->
      <section class="card">
        <div class="card-title">货舱布局（米）</div>
        <div class="field-grid">
          <div v-for="field in holdFields" :key="field.key" class="c-field">
            <label>{{ field.label }}</label>
            <span class="input-wrap">
              <input v-model.number="holdProxy[field.key]" type="number" class="c-input" :step="field.step" :min="field.min" />
              <span class="unit">m</span>
            </span>
          </div>
        </div>
        <div class="card-title sub">槽位与通道</div>
        <div class="field-grid">
          <div v-for="field in slotFields" :key="field.key" class="c-field">
            <label>{{ field.label }}</label>
            <span class="input-wrap">
              <input v-model.number="(form as any)[field.key]" type="number" class="c-input" :step="field.step" :min="field.min" />
              <span class="unit">{{ field.unit }}</span>
            </span>
          </div>
        </div>
      </section>

      <!-- 舱门 -->
      <section class="card">
        <div class="card-title">舱门（右舷 -Z · 位置/洞口尺寸）</div>
        <div class="door-grid">
          <div v-for="door in (['forward', 'aft'] as const)" :key="door" class="door-box">
            <div class="door-head">
              <strong>{{ door === 'forward' ? '前货舱门' : '后货舱门' }}</strong>
              <span class="c-chip" :class="store.doors[door] === 'open' ? 'green' : 'gray'">
                {{ store.doors[door] === 'open' ? '已开启' : '已关闭' }}
              </span>
            </div>
            <div v-for="field in doorFields" :key="field.key" class="c-field">
              <label>{{ field.label }}</label>
              <span class="input-wrap">
                <input v-model.number="doorProxy[door][field.key]" type="number" class="c-input" :step="field.step" :min="field.min" />
                <span class="unit">m</span>
              </span>
            </div>
            <div class="door-actions">
              <button class="c-btn sm" :disabled="store.mode !== 'mock'" @click="store.setDoor(door, 'open')">开门</button>
              <button class="c-btn sm" :disabled="store.mode !== 'mock'" @click="store.setDoor(door, 'close')">关门</button>
            </div>
          </div>
        </div>
      </section>

      <!-- AGV 参数 -->
      <section class="card">
        <div class="card-title">AGV 转运车参数（米）</div>
        <div class="field-grid">
          <div v-for="field in agvFields" :key="field.key" class="c-field">
            <label>{{ field.label }}</label>
            <span class="input-wrap">
              <input v-model.number="agvProxy[field.key]" type="number" class="c-input" :step="field.step" :min="field.min" />
              <span class="unit">{{ field.unit }}</span>
            </span>
          </div>
        </div>
      </section>

      <!-- ULD 参数 -->
      <section class="card">
        <div class="card-title">标准货柜尺寸（米）</div>
        <div v-for="type in types" :key="type" class="uld-row">
          <div class="uld-head">
            <strong>{{ meta[type].label }}</strong>
            <span class="color-dot" :style="{ background: meta[type].color }"></span>
          </div>
          <div class="field-grid three">
            <div v-for="field in uldFields" :key="field.key" class="c-field">
              <label>{{ field.label }}</label>
              <span class="input-wrap">
                <input v-model.number="uldProxy[type][field.key]" type="number" class="c-input" :step="field.step" :min="field.min" />
                <span class="unit">m</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <div class="action-bar">
        <button class="c-btn primary" @click="applyParams">应用参数</button>
        <button class="c-btn" @click="resetParams">恢复默认</button>
        <span class="hint dim">应用后中止当前任务并按新尺寸重建三维场景</span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { CargoConfig, DoorSpec, UldSpec } from '@/config/cargo';
import { ULD_META, ULD_TYPES } from '@/config/cargo';
import { useCargoStore } from '@/store/cargoStore';

const store = useCargoStore();
const types = ULD_TYPES;
const meta = ULD_META;

const draftMode = ref<'mock' | 'algorithm'>(store.mode);
const algorithmUrl = ref('ws://127.0.0.1:9001/algorithm');
watch(
  () => store.mode,
  (mode) => {
    draftMode.value = mode;
  }
);

function cloneConfig(c: CargoConfig): CargoConfig {
  return JSON.parse(JSON.stringify(c)) as CargoConfig;
}
const form = reactive<CargoConfig>(cloneConfig(store.config));
/** 数字控件代理（放宽 key 类型便于模板动态索引）。 */
const uldProxy = form.uld as unknown as Record<string, Record<string, number>>;
const doorProxy = form.doors as unknown as Record<'forward' | 'aft', Record<string, number>>;
const holdProxy = form.hold as unknown as Record<string, number>;
const agvProxy = form.agv as unknown as Record<string, number>;

/** 将 store 配置同步到本地表单（深层覆盖）。 */
function syncForm() {
  const c = store.config;
  form.hold = { ...c.hold };
  form.aisleHalfWidth = c.aisleHalfWidth;
  form.slotZ = c.slotZ;
  form.slotPitch = c.slotPitch;
  form.slotStartX = c.slotStartX;
  form.slotCount = c.slotCount;
  form.initialAkePerSide = c.initialAkePerSide;
  form.doors.forward = { ...c.doors.forward };
  form.doors.aft = { ...c.doors.aft };
  form.agv = { ...c.agv };
  form.uld = {
    AKE: { ...c.uld.AKE },
    PMX: { ...c.uld.PMX },
    PAX: { ...c.uld.PAX }
  };
}

watch(() => store.config, syncForm, { deep: true });

interface FieldDef {
  key: string;
  label: string;
  step?: number;
  min?: number;
  unit?: string;
}

const holdFields: FieldDef[] = [
  { key: 'length', label: '货舱长度', step: 0.5, min: 8 },
  { key: 'floorWidth', label: '地板宽度', step: 0.1, min: 2 },
  { key: 'wallHeight', label: '舱壁高度', step: 0.1, min: 1 },
  { key: 'wallThickness', label: '舱壁厚度', step: 0.02, min: 0.05 }
];
const slotFields: FieldDef[] = [
  { key: 'aisleHalfWidth', label: '通道半宽', step: 0.05, min: 0.3 },
  { key: 'slotZ', label: '货位中心 Z', step: 0.1, min: 0.5 },
  { key: 'slotPitch', label: '货位列距', step: 0.05, min: 0.5 },
  { key: 'slotStartX', label: '首列 X', step: 0.1, min: 0.5 },
  { key: 'slotCount', label: '每侧列数', step: 1, min: 1, unit: '列' },
  { key: 'initialAkePerSide', label: '初始 AKE/侧', step: 1, min: 0, unit: '件' }
];
const doorFields: FieldDef[] = [
  { key: 'x', label: '中心 X', step: 0.1, min: 0.5 },
  { key: 'width', label: '门洞宽', step: 0.1, min: 0.5 },
  { key: 'height', label: '门洞高', step: 0.1, min: 0.5 }
];
const agvFields: FieldDef[] = [
  { key: 'count', label: '数量', step: 1, min: 1, unit: '台' },
  { key: 'length', label: '车长', step: 0.05, min: 0.5 },
  { key: 'width', label: '车宽', step: 0.05, min: 0.3 },
  { key: 'height', label: '车高', step: 0.05, min: 0.2 },
  { key: 'liftHeight', label: '顶升行程', step: 0.05, min: 0 },
  { key: 'speed', label: '行驶速度', step: 0.1, min: 0.2, unit: 'm/s' }
];
const uldFields: FieldDef[] = [
  { key: 'length', label: '长 L', step: 0.01, min: 0.1 },
  { key: 'width', label: '宽 W', step: 0.01, min: 0.1 },
  { key: 'height', label: '高 H', step: 0.01, min: 0.1 }
];

function patchFromForm(): Partial<CargoConfig> {
  return {
    hold: { ...form.hold },
    aisleHalfWidth: form.aisleHalfWidth,
    slotZ: form.slotZ,
    slotPitch: form.slotPitch,
    slotStartX: form.slotStartX,
    slotCount: Math.max(1, Math.round(form.slotCount)),
    initialAkePerSide: Math.max(0, Math.round(form.initialAkePerSide)),
    doors: {
      forward: { ...form.doors.forward } as DoorSpec,
      aft: { ...form.doors.aft } as DoorSpec
    },
    agv: { ...form.agv, count: Math.max(1, Math.round(form.agv.count)) },
    uld: {
      AKE: { ...form.uld.AKE } as UldSpec,
      PMX: { ...form.uld.PMX } as UldSpec,
      PAX: { ...form.uld.PAX } as UldSpec
    }
  };
}

function applyParams() {
  const changed = store.applyConfig(patchFromForm());
  if (!changed) store.pushLog('info', '参数无变化');
  else syncForm();
}

function resetParams() {
  store.resetParams();
  syncForm();
}

function applySource() {
  store.connectSource(draftMode.value, algorithmUrl.value || undefined);
  // 切换消息源后整场重置（场景重建、任务清空），避免双源运行状态交错。
  store.resetSession();
}
</script>

<style scoped>
.left-panel {
  position: absolute;
  /* 定位于 .stage 内容区内：16px ≈ 原页面坐标 92px（顶栏 76px + 16px），保持桌面大屏位置不变 */
  top: 16px;
  bottom: 126px;
  left: 18px;
  z-index: 3;
  display: flex;
  width: 348px;
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

.card-title {
  margin-bottom: 6px;
  color: #1151a8;
  font-size: 13px;
  font-weight: 700;
}

.card-title.sub {
  margin-top: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.c-field-label {
  flex: 0 0 58px;
  color: #46698c;
  font-size: 12px;
}

.connect-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.hint {
  margin-top: 6px;
  color: #5d86ad;
  font-size: 11px;
  line-height: 1.5;
}

.hint.dim {
  color: #8ba4bf;
}

.hint .ok {
  color: #0f9d63;
  font-weight: 700;
}

.hint .err {
  color: #c33238;
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0 8px;
}

.field-grid.three {
  grid-template-columns: repeat(3, 1fr);
}

.input-wrap {
  position: relative;
  display: block;
}

.input-wrap .unit {
  position: absolute;
  top: 50%;
  right: 7px;
  color: #9ab0c8;
  font-size: 10px;
  pointer-events: none;
  transform: translateY(-50%);
}

.c-field :deep(.c-input) {
  padding-right: 34px;
}

.door-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.door-box {
  padding: 6px 8px;
  border: 1px solid #dfe9f6;
  border-radius: 6px;
  background: #f7faff;
}

.door-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.door-head strong {
  color: #16345c;
  font-size: 12px;
}

.door-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.uld-row {
  margin-bottom: 8px;
  padding: 6px;
  border: 1px solid #dfe9f6;
  border-radius: 6px;
  background: #f7faff;
}

.uld-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.uld-head strong {
  color: #16345c;
  font-size: 12px;
}

.color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 6px rgba(22, 119, 255, 0.35);
}

.action-bar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 2px 0 4px;
}

.c-field {
  grid-template-columns: 62px 1fr;
}

.c-field > label {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 移动端：抽屉内单列布局 + 更大触控目标 */
@media (max-width: 900px) {
  .panel-title {
    height: 26px;
    font-size: 13px;
  }

  .c-field {
    grid-template-columns: 68px 1fr;
  }

  .c-field > label {
    font-size: 12px;
  }

  /* ULD 三围：标签压在输入框上方，窄屏也能三列并排读数 */
  .field-grid.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 6px;
  }

  .field-grid.three .c-field {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  /* 舱门参数改单列，避免左右两栏在手机上互相挤压 */
  .door-grid {
    grid-template-columns: 1fr;
  }

  .card {
    padding: 8px;
  }

  .row {
    flex-wrap: wrap;
  }

  .c-field-label {
    flex: 0 0 52px;
  }

  /* 应用/恢复按钮吸底，长表单滚动时随时可点 */
  .action-bar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    padding: 8px 0 4px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0), #ffffff 42%);
  }
}
</style>

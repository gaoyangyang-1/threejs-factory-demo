/**
 * TransportMessageBus —— 应用级消息总线。
 * 职责：
 *  - 下行分发：算法源(AlgorithmEvent) → 订阅者（3D 场景消费 SceneCommand 子集，cargoStore 消费状态子集）；
 *  - 上行控制：UI/业务层 ControlCommand → 当前消息源（演示编排源 / 真实算法适配器）；
 *  - 持有场景探针（SceneProbe）与最新 CargoConfig，供编排源查询位姿/几何。
 * 单例导出：transportBus。
 */
import type { CargoConfig } from '@/config/cargo';
import { defaultCargoConfig } from '@/config/cargo';
import type { AlgorithmEvent, AlgorithmSourceMode, AlgorithmSourceSettings, ControlCommand, SceneProbe } from '@/types/cargo';
import { MockScheduler } from './MockScheduler';
import { AlgorithmAdapter } from './AlgorithmAdapter';

export interface SourceLike {
  kind: AlgorithmSourceMode;
  start(): void;
  dispose(): void;
  onControl(command: ControlCommand): void;
  onConfigChange(config: CargoConfig): void;
}

export interface BusStatus {
  mode: AlgorithmSourceMode;
  connected: boolean;
  label: string;
}

type BusListener = (event: AlgorithmEvent) => void;
type StatusListener = (status: BusStatus) => void;

export class TransportMessageBus {
  private readonly listeners = new Set<BusListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private source: SourceLike | null = null;
  private mode: AlgorithmSourceMode = 'mock';
  private connected = false;
  private label = '演示编排';
  private config: CargoConfig = defaultCargoConfig;
  private probe: SceneProbe | null = null;

  /** 下行事件投递。 */
  emitDown(event: AlgorithmEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  getMode(): AlgorithmSourceMode {
    return this.mode;
  }

  getStatus(): BusStatus {
    return { mode: this.mode, connected: this.connected, label: this.label };
  }

  getConfig(): CargoConfig {
    return this.config;
  }

  getProbe(): SceneProbe | null {
    return this.probe;
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  /** 布局/业务配置更新（场景重建由视图层 watch store.config 触发；此处同步给编排源并中止其进行中的任务）。 */
  setConfig(config: CargoConfig): void {
    this.config = config;
    this.source?.onConfigChange(config);
  }

  /** 视图层注册场景探针（供编排源轮询 AGV/货物位姿判定完成）。 */
  registerProbe(probe: SceneProbe | null): void {
    this.probe = probe;
  }

  /** 切换消息源（演示编排 或 算法接入）。 */
  connectSource(mode: AlgorithmSourceMode, settings?: AlgorithmSourceSettings): void {
    this.source?.dispose();
    this.source = null;
    this.connected = false;
    this.mode = mode;
    if (mode === 'mock') {
      this.label = '演示编排';
      const source = new MockScheduler({
        emit: (event) => this.emitDown(event),
        probe: () => this.getProbe(),
        config: () => this.getConfig()
      });
      source.start();
      this.source = source;
      this.connected = true;
    } else {
      this.label = settings?.url ? `算法接入 · ${settings.url}` : '算法接入';
      const source = new AlgorithmAdapter({
        emit: (event) => this.emitDown(event),
        url: settings?.url,
        onStatus: (connected) => {
          this.connected = connected;
          this.notifyStatus();
        }
      });
      source.start();
      this.source = source;
    }
    this.notifyStatus();
  }

  disconnectSource(): void {
    this.source?.dispose();
    this.source = null;
    this.connected = false;
    this.notifyStatus();
  }

  /** 上行控制 → 当前源。 */
  sendControl(command: ControlCommand): void {
    this.source?.onControl(command);
  }

  private notifyStatus(): void {
    const status = this.getStatus();
    this.statusListeners.forEach((listener) => listener(status));
  }
}

export const transportBus = new TransportMessageBus();

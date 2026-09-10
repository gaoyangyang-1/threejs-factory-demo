/**
 * AlgorithmAdapter —— 真实算法接入适配器（预留，演示用 MockScheduler 占位）。
 *
 * 与算法服务端的对接契约见 docs/算法接入协议.md：
 *  - 上行帧（前端 → 算法）：{ v:1, dst:'algorithm', cmd:<ControlCommand> }
 *  - 下行帧（算法 → 前端）：{ v:1, src:'algorithm', t:<event type>, payload:<event payload> }
 *    其中 event type 与 payload 结构完全等同于 src/types/cargo.ts 的 AlgorithmEvent。
 *
 * 传输：WebSocket。断线自动重连（指数退避上限 8s）；不实现任何算法逻辑。
 */
import type { AlgorithmEvent, AlgorithmSourceMode, ControlCommand } from '@/types/cargo';

export interface AlgorithmAdapterOptions {
  emit: (event: AlgorithmEvent) => void;
  url?: string;
  onStatus: (connected: boolean) => void;
}

export const PROTOCOL_VERSION = 1;

/** 下行帧 → AlgorithmEvent（供外部帧解析与单元校验；未知/非法帧返回 null）。 */
export function decodeDownlinkFrame(frame: unknown): AlgorithmEvent | null {
  if (!frame || typeof frame !== 'object') return null;
  const record = frame as Record<string, unknown>;
  if (record.v !== PROTOCOL_VERSION || record.src !== 'algorithm') return null;
  const t = record.t as string | undefined;
  const payload = record.payload;
  if (!t || payload === undefined || payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  switch (t) {
    case 'scene:reset':
      return { type: 'scene:reset', payload: p as never };
    case 'agv:command':
      return { type: 'agv:command', payload: p as never };
    case 'cargo:pickup':
      return { type: 'cargo:pickup', payload: p as never };
    case 'cargo:place':
      return { type: 'cargo:place', payload: p as never };
    case 'cargo:spawn':
      return { type: 'cargo:spawn', payload: p as never };
    case 'cargo:move':
      return { type: 'cargo:move', payload: p as never };
    case 'path:plan':
      return { type: 'path:plan', payload: p as never };
    case 'obstacle:event':
      return { type: 'obstacle:event', payload: p as never };
    case 'slot:mark':
      return { type: 'slot:mark', payload: p as never };
    case 'door:set':
      return { type: 'door:set', payload: p as never };
    case 'task:state':
      return { type: 'task:state', payload: p as never };
    case 'agv:state':
      return { type: 'agv:state', payload: p as never };
    case 'cargo:state':
      return { type: 'cargo:state', payload: p as never };
    case 'log':
      return { type: 'log', payload: p as never };
    default:
      return null;
  }
}

/** 上行 ControlCommand → 上行帧。 */
export function encodeUplinkFrame(command: ControlCommand): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, dst: 'algorithm', cmd: command });
}

export class AlgorithmAdapter {
  kind: AlgorithmSourceMode = 'algorithm';
  private readonly emit: (event: AlgorithmEvent) => void;
  private readonly url?: string;
  private readonly onStatus: (connected: boolean) => void;
  private socket: WebSocket | null = null;
  private disposed = false;
  private reconnectDelay = 1000;
  private reconnectTimer: number | null = null;

  constructor(options: AlgorithmAdapterOptions) {
    this.emit = options.emit;
    this.url = options.url;
    this.onStatus = options.onStatus;
  }

  start(): void {
    if (!this.url) {
      this.onStatus(false);
      this.emit({ type: 'log', payload: { level: 'warn', message: '算法接入：未配置服务地址，请填写 WebSocket URL 后连接' } });
      return;
    }
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
    this.onStatus(false);
  }

  onControl(command: ControlCommand): void {
    if (command.type === 'config:change') {
      // 本地布局变更仅通知算法方；三维场景重建由视图层自行完成。
      this.emit({ type: 'log', payload: { level: 'info', message: '算法接入：布局参数已变更并同步至算法方' } });
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.emit({ type: 'log', payload: { level: 'warn', message: '算法接入：未连接，控制指令未发送' } });
      return;
    }
    this.socket.send(encodeUplinkFrame(command));
  }

  onConfigChange(): void {
    // 见 onControl(config:change)。
  }

  private connect(): void {
    if (this.disposed || !this.url) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.onStatus(true);
      this.reconnectDelay = 1000;
      this.emit({ type: 'log', payload: { level: 'info', message: `算法接入：已连接 ${this.url}` } });
    };
    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as unknown;
        const decoded = decodeDownlinkFrame(parsed);
        if (decoded) {
          this.emit(decoded);
        } else {
          this.emit({ type: 'log', payload: { level: 'warn', message: `算法接入：忽略无法解析的帧 ${String(event.data).slice(0, 120)}` } });
        }
      } catch {
        this.emit({ type: 'log', payload: { level: 'error', message: '算法接入：帧解码失败' } });
      }
    };
    socket.onerror = () => {
      // onclose 统一处理重连。
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.onStatus(false);
      if (this.disposed) return;
      this.emit({ type: 'log', payload: { level: 'warn', message: `算法接入：连接断开，${Math.round(this.reconnectDelay / 1000)}s 后重连` } });
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
        this.connect();
      }, this.reconnectDelay);
    };
  }
}

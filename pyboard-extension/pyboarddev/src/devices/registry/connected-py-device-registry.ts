/**
 * Module overview:
 * Stores active connected-device state and exposes lookup/snapshot helpers
 * keyed by device ID and port path.
 */
import { PyDeviceRuntimeInfo } from '../model/py-device-runtime-info';
import { ConnectedPyDeviceState } from './connected-py-device-state';
import { ConnectedPyDeviceSnapshot } from './connected-py-device-snapshot';

/**
 * In-memory registry for active board connections and port-to-device mappings.
 */
export class ConnectedPyDeviceRegistry {
  private readonly connectedPyDevices = new Map<string, ConnectedPyDeviceState>();
  private readonly deviceIdByPortPath = new Map<string, string>();

  isConnected(): boolean {
    return this.connectedPyDevices.size > 0;
  }

  getByDeviceId(deviceId?: string): ConnectedPyDeviceState | undefined {
    if (!deviceId) {
      return this.getActiveBoardState();
    }
    return this.connectedPyDevices.get(deviceId);
  }

  getByPortPath(devicePath: string): ConnectedPyDeviceState | undefined {
    const existingDeviceId = this.deviceIdByPortPath.get(devicePath);
    if (!existingDeviceId) {
      return undefined;
    }
    return this.connectedPyDevices.get(existingDeviceId);
  }

  add(state: ConnectedPyDeviceState): void {
    this.connectedPyDevices.set(state.deviceId, state);
    this.deviceIdByPortPath.set(state.board.device, state.deviceId);
  }

  remove(deviceId: string): ConnectedPyDeviceState | undefined {
    const state = this.connectedPyDevices.get(deviceId);
    if (!state) {
      return undefined;
    }
    this.connectedPyDevices.delete(deviceId);
    this.deviceIdByPortPath.delete(state.board.device);
    return state;
  }

  hasDeviceId(deviceId: string): boolean {
    return this.connectedPyDevices.has(deviceId);
  }

  getDeviceIdForPortPath(devicePath: string): string | undefined {
    return this.getByPortPath(devicePath)?.deviceId;
  }

  getConnectedDeviceIds(): string[] {
    return this.getSnapshots().map((item) => item.deviceId);
  }

  beginExecution(deviceId: string): boolean {
    const state = this.connectedPyDevices.get(deviceId);
    if (!state) {
      return false;
    }
    state.executionCount += 1;
    return true;
  }

  endExecution(deviceId: string): boolean {
    const state = this.connectedPyDevices.get(deviceId);
    if (!state) {
      return false;
    }
    state.executionCount = Math.max(0, state.executionCount - 1);
    return true;
  }

  isExecuting(deviceId: string): boolean {
    return (this.connectedPyDevices.get(deviceId)?.executionCount ?? 0) > 0;
  }

  setRuntimeInfo(deviceId: string, runtimeInfo: PyDeviceRuntimeInfo | undefined): boolean {
    const state = this.connectedPyDevices.get(deviceId);
    if (!state) {
      return false;
    }
    state.runtimeInfo = runtimeInfo;
    return true;
  }

  reassignDeviceId(currentDeviceId: string, nextDeviceId: string): boolean {
    if (currentDeviceId === nextDeviceId) {
      return true;
    }
    const state = this.connectedPyDevices.get(currentDeviceId);
    if (!state || this.connectedPyDevices.has(nextDeviceId)) {
      return false;
    }

    this.connectedPyDevices.delete(currentDeviceId);
    state.deviceId = nextDeviceId;
    this.connectedPyDevices.set(nextDeviceId, state);
    this.deviceIdByPortPath.set(state.board.device, nextDeviceId);
    return true;
  }

  getSnapshots(): ConnectedPyDeviceSnapshot[] {
    return [...this.connectedPyDevices.values()]
      .map((state) => ({
        deviceId: state.deviceId,
        devicePath: state.board.device,
        baudRate: state.board.baudrate,
        runtimeInfo: state.runtimeInfo,
        executionCount: state.executionCount
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  private getActiveBoardState(): ConnectedPyDeviceState | undefined {
    return this.connectedPyDevices.values().next().value as ConnectedPyDeviceState | undefined;
  }
}

export type { ConnectedPyDeviceState, ConnectedPyDeviceSnapshot };

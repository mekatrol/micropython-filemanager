/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import { PyDeviceRuntimeInfo, Pydevice } from './py-device';

/**
 * Tracks all active board connections and provides query/update helpers.
 *
 * The registry is intentionally isolated from VS Code UI concerns so it can be
 * unit-tested in isolation and reused from command handlers.
 */
export interface ConnectedBoardState {
  deviceId: string;
  board: Pydevice;
  runtimeInfo: PyDeviceRuntimeInfo | undefined;
  executionCount: number;
}

/**
 * Public immutable projection of active board state used by UI and commands.
 */
export interface ConnectedBoardSnapshot {
  deviceId: string;
  devicePath: string;
  baudRate: number;
  runtimeInfo: PyDeviceRuntimeInfo | undefined;
  executionCount: number;
}

/**
 * In-memory registry for active board connections and port-to-device mappings.
 */
export class ConnectedBoardRegistry {
  private readonly connectedBoards = new Map<string, ConnectedBoardState>();
  private readonly deviceIdByPortPath = new Map<string, string>();

  isConnected(): boolean {
    return this.connectedBoards.size > 0;
  }

  getByDeviceId(deviceId?: string): ConnectedBoardState | undefined {
    if (!deviceId) {
      return this.getActiveBoardState();
    }
    return this.connectedBoards.get(deviceId);
  }

  getByPortPath(devicePath: string): ConnectedBoardState | undefined {
    const existingDeviceId = this.deviceIdByPortPath.get(devicePath);
    if (!existingDeviceId) {
      return undefined;
    }
    return this.connectedBoards.get(existingDeviceId);
  }

  add(state: ConnectedBoardState): void {
    this.connectedBoards.set(state.deviceId, state);
    this.deviceIdByPortPath.set(state.board.device, state.deviceId);
  }

  remove(deviceId: string): ConnectedBoardState | undefined {
    const state = this.connectedBoards.get(deviceId);
    if (!state) {
      return undefined;
    }
    this.connectedBoards.delete(deviceId);
    this.deviceIdByPortPath.delete(state.board.device);
    return state;
  }

  hasDeviceId(deviceId: string): boolean {
    return this.connectedBoards.has(deviceId);
  }

  getDeviceIdForPortPath(devicePath: string): string | undefined {
    return this.getByPortPath(devicePath)?.deviceId;
  }

  getConnectedDeviceIds(): string[] {
    return this.getSnapshots().map((item) => item.deviceId);
  }

  beginExecution(deviceId: string): boolean {
    const state = this.connectedBoards.get(deviceId);
    if (!state) {
      return false;
    }
    state.executionCount += 1;
    return true;
  }

  endExecution(deviceId: string): boolean {
    const state = this.connectedBoards.get(deviceId);
    if (!state) {
      return false;
    }
    state.executionCount = Math.max(0, state.executionCount - 1);
    return true;
  }

  isExecuting(deviceId: string): boolean {
    return (this.connectedBoards.get(deviceId)?.executionCount ?? 0) > 0;
  }

  setRuntimeInfo(deviceId: string, runtimeInfo: PyDeviceRuntimeInfo | undefined): boolean {
    const state = this.connectedBoards.get(deviceId);
    if (!state) {
      return false;
    }
    state.runtimeInfo = runtimeInfo;
    return true;
  }

  getSnapshots(): ConnectedBoardSnapshot[] {
    return [...this.connectedBoards.values()]
      .map((state) => ({
        deviceId: state.deviceId,
        devicePath: state.board.device,
        baudRate: state.board.baudrate,
        runtimeInfo: state.runtimeInfo,
        executionCount: state.executionCount
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  private getActiveBoardState(): ConnectedBoardState | undefined {
    return this.connectedBoards.values().next().value as ConnectedBoardState | undefined;
  }
}

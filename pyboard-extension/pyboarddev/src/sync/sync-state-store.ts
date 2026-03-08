/**
 * Module overview:
 * Global sync-state store independent of UI views so other extension
 * components can consume host/device sync data.
 */
import * as vscode from 'vscode';
import { FileEntry, SyncState } from '../utils/device-filesystem';

export interface DeviceSyncStateSnapshot {
  deviceId: string;
  syncRootPath?: string;
  computerEntries: FileEntry[];
  deviceEntries: FileEntry[];
  syncStates: Map<string, SyncState>;
}

export interface SyncStateStoreChangeEvent {
  deviceIds: string[];
}

class SyncStateStore {
  private readonly didChangeEmitter = new vscode.EventEmitter<SyncStateStoreChangeEvent>();
  readonly onDidChange = this.didChangeEmitter.event;

  private readonly syncRootPathByDeviceId = new Map<string, string | undefined>();
  private readonly computerEntriesByDeviceId = new Map<string, FileEntry[]>();
  private readonly deviceEntriesByDeviceId = new Map<string, FileEntry[]>();
  private readonly syncStatesByDeviceId = new Map<string, Map<string, SyncState>>();

  setDeviceSnapshot(snapshot: DeviceSyncStateSnapshot): void {
    this.syncRootPathByDeviceId.set(snapshot.deviceId, snapshot.syncRootPath);
    this.computerEntriesByDeviceId.set(snapshot.deviceId, [...snapshot.computerEntries]);
    this.deviceEntriesByDeviceId.set(snapshot.deviceId, [...snapshot.deviceEntries]);
    this.syncStatesByDeviceId.set(snapshot.deviceId, new Map(snapshot.syncStates));
    this.didChangeEmitter.fire({ deviceIds: [snapshot.deviceId] });
  }

  getDeviceSnapshot(deviceId: string): DeviceSyncStateSnapshot | undefined {
    const computerEntries = this.computerEntriesByDeviceId.get(deviceId);
    const deviceEntries = this.deviceEntriesByDeviceId.get(deviceId);
    const syncStates = this.syncStatesByDeviceId.get(deviceId);
    if (!computerEntries || !deviceEntries || !syncStates) {
      return undefined;
    }

    return {
      deviceId,
      syncRootPath: this.syncRootPathByDeviceId.get(deviceId),
      computerEntries: [...computerEntries],
      deviceEntries: [...deviceEntries],
      syncStates: new Map(syncStates)
    };
  }

  getSyncState(deviceId: string, relativePath: string): SyncState | undefined {
    return this.syncStatesByDeviceId.get(deviceId)?.get(relativePath);
  }

  getKnownDeviceIds(): string[] {
    return [...this.syncStatesByDeviceId.keys()].sort((a, b) => a.localeCompare(b));
  }
}

export const syncStateStore = new SyncStateStore();

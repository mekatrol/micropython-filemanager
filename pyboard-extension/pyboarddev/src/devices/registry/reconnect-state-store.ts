/**
 * Encapsulates persistent reconnect state read/write operations.
 *
 * The store is built around injected read/write functions to keep it
 * independent from VS Code and easy to unit test.
 */
export class ReconnectStateStore {
  constructor(
    private readonly readState: <T>(key: string) => T | undefined,
    private readonly writeState: <T>(key: string, value: T) => Promise<void>,
    private readonly reconnectDevicePathsStateKey: string
  ) {}

  readReconnectDevicePaths(): string[] {
    const stored = this.readState<unknown>(this.reconnectDevicePathsStateKey);
    if (!Array.isArray(stored)) {
      return [];
    }

    const normalised = stored
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return [...new Set(normalised)];
  }

  async writeReconnectDevicePaths(devicePaths: string[]): Promise<void> {
    const next = [...new Set(devicePaths.map((item) => item.trim()).filter((item) => item.length > 0))];
    await this.writeState(this.reconnectDevicePathsStateKey, next);
  }

  async addReconnectDevicePath(devicePath: string): Promise<void> {
    const current = this.readReconnectDevicePaths();
    if (current.includes(devicePath)) {
      return;
    }

    await this.writeReconnectDevicePaths([...current, devicePath]);
  }

  async removeReconnectDevicePath(devicePath: string): Promise<void> {
    const current = this.readReconnectDevicePaths();
    if (!current.includes(devicePath)) {
      return;
    }

    await this.writeReconnectDevicePaths(current.filter((item) => item !== devicePath));
  }
}

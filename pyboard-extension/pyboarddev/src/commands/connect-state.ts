import { PyDeviceRuntimeInfo } from '../devices/py-device';

export enum ConnectStatus {
  Resolving = 'resolving',
  Ready = 'ready',
  Connecting = 'connecting',
  Connected = 'connected',
  NotConnected = 'not_connected',
  Error = 'error'
}

export interface ConnectRow {
  id: string;
  devicePath: string;
  serialPortName: string;
  deviceId: string;
  deviceName: string;
  status: ConnectStatus;
  errorText?: string;
  deviceInfo?: string;
  details?: string;
}

export interface ConnectStatusContext {
  isConnected: boolean;
  isConnecting: boolean;
  hasError: boolean;
  hasResolvedDeviceId: boolean;
  hasClaimedConfiguredId: boolean;
}

const statusRules: ReadonlyArray<readonly [ConnectStatus, (context: ConnectStatusContext) => boolean]> = [
  [ConnectStatus.Connected, (context) => context.isConnected],
  [ConnectStatus.Connecting, (context) => context.isConnecting],
  [ConnectStatus.Error, (context) => context.hasError],
  [ConnectStatus.Ready, (context) => context.hasResolvedDeviceId],
  [ConnectStatus.Ready, (context) => context.hasClaimedConfiguredId],
  [ConnectStatus.Resolving, () => true]
] as const;

export const resolveConnectStatus = (
  context: ConnectStatusContext
): ConnectStatus => {
  const matchedRule = statusRules.find(([, predicate]) => predicate(context));
  return matchedRule ? matchedRule[0] : ConnectStatus.Resolving;
};

export const toDeviceInfoSummary = (runtimeInfo: PyDeviceRuntimeInfo | undefined): string | undefined => {
  if (!runtimeInfo) {
    return undefined;
  }

  return `${runtimeInfo.version}; ${runtimeInfo.machine}`;
};

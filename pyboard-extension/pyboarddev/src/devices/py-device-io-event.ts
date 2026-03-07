export interface PyDeviceIOEvent {
  direction: 'tx' | 'rx';
  data: Buffer;
}

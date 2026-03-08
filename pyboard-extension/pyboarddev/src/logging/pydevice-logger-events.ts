import * as vscode from 'vscode';

export type PyDeviceLoggerEventLevel = 'debug';

export interface PyDeviceLoggerEvent {
  source: string;
  level: PyDeviceLoggerEventLevel;
  action: string;
  message: string;
  details?: Record<string, unknown>;
}

const pyDeviceLoggerEventEmitter = new vscode.EventEmitter<PyDeviceLoggerEvent>();

export const onPyDeviceLoggerEvent = pyDeviceLoggerEventEmitter.event;

export const emitPyDeviceLoggerEvent = (event: PyDeviceLoggerEvent): void => {
  pyDeviceLoggerEventEmitter.fire(event);
};


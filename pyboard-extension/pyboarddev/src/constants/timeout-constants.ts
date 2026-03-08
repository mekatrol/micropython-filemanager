/**
 * Module overview:
 * Centralised extension constants. Timeout constants are grouped here so
 * defaults, minimums, and setting metadata remain in one place.
 */

export const pyDeviceConfigurationSection = 'mekatrol.pydevice';

export interface TimeoutSettingDefinition {
  /**
   * Configuration property key relative to `mekatrol.pydevice`.
   */
  readonly settingKey: string;
  /**
   * Default timeout value (milliseconds) used when a user has not set a value.
   */
  readonly defaultValueMs: number;
  /**
   * Lowest allowed timeout value (milliseconds).
   * Values below this are clamped to this minimum.
   */
  readonly minimumValueMs: number;
  /**
   * Detailed setting description shown in docs/settings generation points.
   */
  readonly description: string;
}

// Timeout settings (user-overridable)
export const pyDeviceTimeoutSettings = {
  serialPortOperation: {
    settingKey: 'serialPortOperationTimeoutMs',
    defaultValueMs: 3000,
    minimumValueMs: 500,
    description: 'Maximum time to open or close a serial port during connect/probe/disconnect operations.'
  },
  serialPortAggressiveRecoveryProbe: {
    settingKey: 'serialPortAggressiveRecoveryProbeTimeoutMs',
    defaultValueMs: 9000,
    minimumValueMs: 1000,
    description: 'Timeout used for aggressive post-failure runtime probing that may include reboot-level recovery.'
  },
  pythonProbeRuntimeInfo: {
    settingKey: 'pythonProbeRuntimeInfoTimeoutMs',
    defaultValueMs: 2500,
    minimumValueMs: 500,
    description: 'Timeout for lightweight runtime probing (banner/version/ID checks) used during detection and reconnect.'
  },
  pythonGetRuntimeInfo: {
    settingKey: 'pythonGetRuntimeInfoTimeoutMs',
    defaultValueMs: 5000,
    minimumValueMs: 1000,
    description: 'Timeout for full runtime info reads that may include additional board operations.'
  },
  pythonExecRawCapture: {
    settingKey: 'pythonExecRawCaptureTimeoutMs',
    defaultValueMs: 10000,
    minimumValueMs: 1000,
    description: 'Timeout for executing Python commands over raw REPL and waiting for command output completion.'
  },
  pythonSoftReboot: {
    settingKey: 'pythonSoftRebootTimeoutMs',
    defaultValueMs: 8000,
    minimumValueMs: 1000,
    description: 'Timeout for soft reboot sequences triggered via raw REPL control flow.'
  },
  pythonHardReboot: {
    settingKey: 'pythonHardRebootTimeoutMs',
    defaultValueMs: 1500,
    minimumValueMs: 150,
    description: 'Timeout for hard reboot waits around DTR/RTS toggles or close/reopen restart paths.'
  },
  pythonSerialWriteAck: {
    settingKey: 'pythonSerialWriteAckTimeoutMs',
    defaultValueMs: 2000,
    minimumValueMs: 250,
    description: 'Timeout for serial write acknowledgement and drain completion before command flow continues.'
  }
} as const satisfies Record<string, TimeoutSettingDefinition>;

// Internal timeout constants (not user settings)
export const pyDeviceInternalTimeouts = {
  debugExecutionTimeoutMs: 60000,
  recoveryConnectAttemptTimeoutMs: 25000,
  hardRebootOwnedPortReopenDelayMinimumMs: 150,
  hardRebootSignalToggleDelayMinimumMs: 120,
  runtimeInfoRecoveryProbeTimeoutMinimumMs: 3500,
  runtimeInfoRecoveryGetInfoTimeoutMinimumMs: 9000,
  enterRawReplFastThresholdMs: 5000,
  enterRawReplPromptTimeoutMinimumMs: 1500,
  enterRawReplIdleReadMs: 120,
  enterRawReplIdleReadMaxMs: 800,
  enterRawReplRetryReadMaxMs: 600,
  enterRawReplRetryDelayMs: 120
} as const;

/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import { BoardRuntimeInfo } from '../utils/pydevice';

/**
 * Normalises device identifiers so they are safe and stable for keys/paths.
 */
export const normaliseDeviceId = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown-device';
  }

  return trimmed.replace(/\s+/g, '-').replace(/[^\w.-]/g, '_');
};

/**
 * Derives a logical device id from runtime UID when available, otherwise from
 * the serial port path.
 */
export const toDeviceId = (devicePath: string, runtimeInfo?: BoardRuntimeInfo): string => {
  if (runtimeInfo?.uniqueId && runtimeInfo.uniqueId.trim().length > 0) {
    return normaliseDeviceId(runtimeInfo.uniqueId);
  }

  return `port_${normaliseDeviceId(devicePath)}`;
};

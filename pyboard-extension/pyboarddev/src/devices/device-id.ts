/**
 * Module overview:
 * This file is part of the PyDevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import { PyDeviceRuntimeInfo } from './py-device';

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
export const toDeviceId = (devicePath: string, runtimeInfo?: PyDeviceRuntimeInfo): string => {
  if (runtimeInfo?.uniqueId && runtimeInfo.uniqueId.trim().length > 0) {
    return normaliseDeviceId(runtimeInfo.uniqueId);
  }

  return `port_${normaliseDeviceId(devicePath)}`;
};

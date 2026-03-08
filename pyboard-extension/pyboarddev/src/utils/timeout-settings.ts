/**
 * Module overview:
 * Resolves timeout settings from VS Code configuration and enforces minimum
 * values from shared timeout constants.
 */
import * as vscode from 'vscode';
import { pyDeviceConfigurationSection, TimeoutSettingDefinition } from '../constants/timeout-constants';

const normaliseTimeoutMs = (value: number, minimumValueMs: number): number => {
  if (!Number.isFinite(value)) {
    return minimumValueMs;
  }

  return Math.max(minimumValueMs, Math.floor(value));
};

export const getTimeoutSettingMs = (definition: TimeoutSettingDefinition): number => {
  const configuredValue = vscode.workspace
    .getConfiguration(pyDeviceConfigurationSection)
    .get<number>(definition.settingKey, definition.defaultValueMs);

  return normaliseTimeoutMs(configuredValue, definition.minimumValueMs);
};

export const resolveTimeoutMs = (definition: TimeoutSettingDefinition, overrideTimeoutMs?: number): number => {
  if (typeof overrideTimeoutMs === 'number' && Number.isFinite(overrideTimeoutMs)) {
    return normaliseTimeoutMs(overrideTimeoutMs, definition.minimumValueMs);
  }

  return getTimeoutSettingMs(definition);
};

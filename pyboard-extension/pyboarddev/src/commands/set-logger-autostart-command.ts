/**
 * Module overview:
 * Command for toggling whether the PyDevice Logger auto-starts on extension activation.
 */
import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { getWorkspaceCacheValue, loggerAutoStartCacheKey, setWorkspaceCacheValue } from '../utils/workspace-cache';
import { showInformationMessage, t } from '../utils/i18n';

export const initSetLoggerAutoStartCommand = (
  context: vscode.ExtensionContext,
  onDidChange?: (enabled: boolean) => void
): void => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.setloggerautostart', async () => {
    const currentValue = getWorkspaceCacheValue<boolean>(loggerAutoStartCacheKey) ?? true;

    const selected = await vscode.window.showQuickPick(
      [
        {
          label: t('Enable'),
          description: t('Create and subscribe the PyDevice Logger on extension startup'),
          picked: currentValue
        },
        {
          label: t('Disable'),
          description: t('Do not auto-start the PyDevice Logger on extension startup'),
          picked: !currentValue
        }
      ],
      {
        placeHolder: t('Set logger auto-start behavior')
      }
    );

    if (!selected) {
      return;
    }

    const enabled = selected.label === t('Enable');
    await setWorkspaceCacheValue(loggerAutoStartCacheKey, enabled);
    onDidChange?.(enabled);

    const msg = `PyDevice Logger auto-start is now ${enabled ? 'enabled' : 'disabled'}.`;
    showInformationMessage(msg);
    logChannelOutput(msg, true);
  });

  context.subscriptions.push(command);
};

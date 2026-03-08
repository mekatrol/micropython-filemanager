/**
 * Module overview:
 * Command for toggling whether the PyDevice Logger auto-starts on extension activation.
 */
import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';
import { getWorkspaceCacheValue, loggerAutoStartCacheKey, setWorkspaceCacheValue } from '../utils/workspace-cache';

export const initSetLoggerAutoStartCommand = (
  context: vscode.ExtensionContext,
  onDidChange?: (enabled: boolean) => void
): void => {
  const command = vscode.commands.registerCommand('mekatrol.pydevice.setloggerautostart', async () => {
    const currentValue = getWorkspaceCacheValue<boolean>(loggerAutoStartCacheKey) ?? true;

    const selected = await vscode.window.showQuickPick(
      [
        {
          label: 'Enable',
          description: 'Create and subscribe the PyDevice Logger on extension startup',
          picked: currentValue
        },
        {
          label: 'Disable',
          description: 'Do not auto-start the PyDevice Logger on extension startup',
          picked: !currentValue
        }
      ],
      {
        placeHolder: 'Set logger auto-start behavior'
      }
    );

    if (!selected) {
      return;
    }

    const enabled = selected.label === 'Enable';
    await setWorkspaceCacheValue(loggerAutoStartCacheKey, enabled);
    onDidChange?.(enabled);

    const msg = `PyDevice Logger auto-start is now ${enabled ? 'enabled' : 'disabled'}.`;
    vscode.window.showInformationMessage(msg);
    logChannelOutput(msg, true);
  });

  context.subscriptions.push(command);
};

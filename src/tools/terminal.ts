import * as vscode from 'vscode';
import { SecurityGuard } from '../validation/securityGuard';

export class TerminalTool {
  private static _terminal: vscode.Terminal | undefined;

  public static async execute(command: string, workspaceRoot: string): Promise<string> {
    const isAllowed = await SecurityGuard.validateTerminalCommand(command);
    if (!isAllowed) {
      throw new Error(`Terminal execution denied for: ${command}`);
    }

    // Reuse or create a dedicated terminal
    if (!this._terminal || this._terminal.exitStatus !== undefined) {
      this._terminal = vscode.window.createTerminal({
        name: '🌶️ Gorom Moshla',
        cwd: workspaceRoot,
      });
    }

    this._terminal.show(true); // show but don't steal focus
    this._terminal.sendText(command);

    return `Running in terminal: ${command}`;
  }
}

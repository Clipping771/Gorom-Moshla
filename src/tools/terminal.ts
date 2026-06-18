import * as vscode from 'vscode';
import { SecurityGuard } from '../validation/securityGuard';
import { exec } from 'child_process';

export class TerminalTool {
  private static _terminal: vscode.Terminal | undefined;

  public static async execute(command: string, workspaceRoot: string): Promise<string> {
    const isAllowed = await SecurityGuard.validateTerminalCommand(command);
    if (!isAllowed) {
      throw new Error(`Terminal execution denied for: ${command}`);
    }

    // Show it in the VS Code terminal for the user
    if (!this._terminal || this._terminal.exitStatus !== undefined) {
      this._terminal = vscode.window.createTerminal({
        name: '🌶️ Gorom Moshla',
        cwd: workspaceRoot,
      });
    }
    this._terminal.show(true);
    this._terminal.sendText(command);

    // Run in background to capture output for the AI
    return new Promise((resolve) => {
      let output = '';
      
      const child = exec(command, { cwd: workspaceRoot });
      
      child.stdout?.on('data', (data) => {
        output += data.toString();
      });
      
      child.stderr?.on('data', (data) => {
        output += data.toString();
      });

      // If it finishes quickly, return the full output
      child.on('close', (code) => {
        resolve(`Exit code ${code}\\nOutput:\\n${output || 'No output.'}`);
      });

      child.on('error', (err) => {
        resolve(`Error starting command: ${err.message}\\nOutput:\\n${output}`);
      });

      // If it's a long-running command (like a server), resolve early so the AI doesn't hang
      setTimeout(() => {
        if (child.exitCode === null) {
          resolve(`Command is still running in background.\\nOutput so far:\\n${output || 'No output yet.'}`);
        }
      }, 5000); // 5 seconds should be enough to see if a server started
    });
  }
}

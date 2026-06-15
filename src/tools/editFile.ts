import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SecurityGuard } from '../validation/securityGuard';
import { RollbackSystem } from '../core/rollback';

export class EditFileTool {
  /**
   * Creates or overwrites a file with the given content.
   * Shows a VS Code diff so the user can see what changed, then applies immediately.
   */
  public static async execute(
    workspaceRoot: string,
    targetPath: string,
    content: string,
    rollbackSystem: RollbackSystem
  ): Promise<string> {
    const fullPath = path.resolve(workspaceRoot, targetPath);

    // Security: must stay inside workspace
    if (!fullPath.startsWith(workspaceRoot)) {
      throw new Error(`Security: cannot write outside workspace: ${targetPath}`);
    }

    const isAllowed = await SecurityGuard.validateWriteOperation(targetPath);
    if (!isAllowed) {
      throw new Error(`Write denied by SecurityGuard for: ${targetPath}`);
    }

    // Snapshot existing file for rollback
    rollbackSystem.snapshotFile(fullPath);

    // Create parent directories if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write the file
    fs.writeFileSync(fullPath, content, 'utf-8');

    // Open the file in the editor so the user sees it
    const uri = vscode.Uri.file(fullPath);
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });

    return `Written: ${targetPath}`;
  }
}

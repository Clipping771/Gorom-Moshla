import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RollbackSystem } from '../core/rollback';

export class PatchEngine {
  constructor(private rollbackSystem: RollbackSystem) {}

  /**
   * Writes the patch to a temporary file and triggers a VS Code diff viewer.
   * Returns the URI of the temp file.
   */
  public async previewPatch(workspaceRoot: string, targetPath: string, patchContent: string): Promise<vscode.Uri> {
    const fullPath = path.resolve(workspaceRoot, targetPath);
    
    // Create temp file
    const tempDir = path.join(workspaceRoot, '.gorom-moshla', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    const tempFileName = `temp_${Date.now()}_${path.basename(targetPath)}`;
    const tempFilePath = path.join(tempDir, tempFileName);
    fs.writeFileSync(tempFilePath, patchContent, 'utf-8');

    const originalUri = vscode.Uri.file(fullPath);
    const tempUri = vscode.Uri.file(tempFilePath);

    // Open native diff viewer
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      tempUri,
      `Gorom Moshla: Review changes to ${targetPath}`
    );

    return tempUri;
  }

  /**
   * Applies the patch by overwriting the target file with the temp file contents,
   * snapshotting the original state for rollback first.
   */
  public applyPatch(workspaceRoot: string, targetPath: string, tempUri: vscode.Uri) {
    const fullPath = path.resolve(workspaceRoot, targetPath);
    
    // Snapshot for rollback
    this.rollbackSystem.snapshotFile(fullPath);

    // Read from temp and write to original
    const newContent = fs.readFileSync(tempUri.fsPath, 'utf-8');
    fs.writeFileSync(fullPath, newContent, 'utf-8');

    // Cleanup temp
    fs.unlinkSync(tempUri.fsPath);
  }

  public rejectPatch(tempUri: vscode.Uri) {
    // Just cleanup the temp file
    if (fs.existsSync(tempUri.fsPath)) {
      fs.unlinkSync(tempUri.fsPath);
    }
  }
}

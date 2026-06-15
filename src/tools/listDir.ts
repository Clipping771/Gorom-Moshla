import * as vscode from 'vscode';
import * as path from 'path';

export class ListDirTool {
  public static async execute(targetPath: string, workspaceRoot: string): Promise<string> {
    const fullPath = path.resolve(workspaceRoot, targetPath);
    
    // Security check: ensure path is within workspace
    if (!fullPath.startsWith(workspaceRoot)) {
      throw new Error(`Security Violation: Cannot list directory outside workspace root (${targetPath})`);
    }

    try {
      const uri = vscode.Uri.file(fullPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      
      let result = `Contents of ${targetPath}:\n`;
      for (const [name, type] of entries) {
        const typeStr = type === vscode.FileType.Directory ? '[DIR]' : '[FILE]';
        result += `- ${typeStr} ${name}\n`;
      }
      return result;
    } catch (e: any) {
      return `Failed to list directory: ${e.message}`;
    }
  }
}

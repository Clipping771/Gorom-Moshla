import * as fs from 'fs';
import * as path from 'path';

export class ReadFileTool {
  public static async execute(workspaceRoot: string, targetPath: string, startLine?: number, endLine?: number): Promise<string> {
    const fullPath = path.resolve(workspaceRoot, targetPath);
    if (!fullPath.startsWith(workspaceRoot)) {
      throw new Error(`Security Exception: Cannot read outside workspace: ${targetPath}`);
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${targetPath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    if (startLine === undefined && endLine === undefined) {
      return content;
    }

    const lines = content.split('\n');
    const start = startLine ? Math.max(1, startLine) - 1 : 0;
    const end = endLine ? Math.min(lines.length, endLine) : lines.length;
    
    return lines.slice(start, end).join('\n');
  }
}

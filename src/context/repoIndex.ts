import * as vscode from 'vscode';

export class RepoIndexContext {
  public static async getFileTreeContext(): Promise<string> {
    if (!vscode.workspace.workspaceFolders) {
      return '';
    }
    
    // Find all files, excluding common noisy directories
    const files = await vscode.workspace.findFiles(
      '**/*', 
      '**/{node_modules,.git,.vscode,dist,out,build,coverage}/**'
    );

    // Limit to top 1000 files to avoid massive string payload
    const filePaths = files.slice(0, 1000).map(f => vscode.workspace.asRelativePath(f));
    
    return `Repository File Tree:\n${filePaths.join('\n')}`;
  }

  public static getImportsGraph(): string {
    // Stub for future dependency graph
    return '';
  }
}

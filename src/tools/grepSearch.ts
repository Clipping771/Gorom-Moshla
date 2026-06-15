import * as vscode from 'vscode';

export class GrepSearchTool {
  public static async execute(query: string, workspaceRoot: string): Promise<string> {
    try {
      const results: string[] = [];
      let matchCount = 0;
      const MAX_MATCHES = 50;

      const uris = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,out,build}/**'
      );

      const regex = new RegExp(query, 'i');
      const decoder = new TextDecoder();

      for (const uri of uris) {
        if (matchCount >= MAX_MATCHES) break;

        try {
          const uint8Array = await vscode.workspace.fs.readFile(uri);
          const text = decoder.decode(uint8Array);
          const lines = text.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (matchCount >= MAX_MATCHES) break;
            if (regex.test(lines[i])) {
              const filePath = vscode.workspace.asRelativePath(uri, false);
              results.push(`[${filePath}:${i + 1}] ${lines[i].trim()}`);
              matchCount++;
            }
          }
        } catch (e) {
          // Ignore files that can't be read
        }
      }

      if (results.length === 0) return `No matches found for "${query}".`;
      let output = results.join('\n');
      if (matchCount >= MAX_MATCHES) {
        output += `\n... (Result limit reached. Showing first ${MAX_MATCHES} matches.)`;
      }
      return output;
    } catch (e: any) {
      return `Failed to search codebase: ${e.message}`;
    }
  }
}

import * as vscode from 'vscode';
import { LSPCache } from './lspCache';

export class LSPHooks {
  /**
   * Fetches definitions using VS Code's native LSP command, with caching.
   */
  public static async getDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const cached = LSPCache.getDefinition(uri, position);
    if (cached) return cached;

    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position
      );
      
      const result = locations || [];
      LSPCache.setDefinition(uri, position, result);
      return result;
    } catch (e) {
      console.error('LSP getDefinitions failed', e);
      return [];
    }
  }

  /**
   * Fetches references using VS Code's native LSP command, with caching.
   */
  public static async getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const cached = LSPCache.getReferences(uri, position);
    if (cached) return cached;

    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        position
      );
      
      const result = locations || [];
      LSPCache.setReferences(uri, position, result);
      return result;
    } catch (e) {
      console.error('LSP getReferences failed', e);
      return [];
    }
  }
}

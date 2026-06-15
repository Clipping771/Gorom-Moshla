import * as vscode from 'vscode';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class LSPCache {
  private static definitionCache = new Map<string, CacheEntry<vscode.Location[]>>();
  private static referenceCache = new Map<string, CacheEntry<vscode.Location[]>>();
  private static readonly TTL_MS = 60000; // 1 minute TTL

  private static generateKey(uri: vscode.Uri, position: vscode.Position): string {
    return `${uri.toString()}:${position.line}:${position.character}`;
  }

  public static getDefinition(uri: vscode.Uri, position: vscode.Position): vscode.Location[] | null {
    const key = this.generateKey(uri, position);
    const entry = this.definitionCache.get(key);
    if (entry && (Date.now() - entry.timestamp < this.TTL_MS)) {
      return entry.data;
    }
    return null;
  }

  public static setDefinition(uri: vscode.Uri, position: vscode.Position, data: vscode.Location[]) {
    const key = this.generateKey(uri, position);
    this.definitionCache.set(key, { data, timestamp: Date.now() });
  }

  // Same logic for references
  public static getReferences(uri: vscode.Uri, position: vscode.Position): vscode.Location[] | null {
    const key = this.generateKey(uri, position);
    const entry = this.referenceCache.get(key);
    if (entry && (Date.now() - entry.timestamp < this.TTL_MS)) {
      return entry.data;
    }
    return null;
  }

  public static setReferences(uri: vscode.Uri, position: vscode.Position, data: vscode.Location[]) {
    const key = this.generateKey(uri, position);
    this.referenceCache.set(key, { data, timestamp: Date.now() });
  }
}

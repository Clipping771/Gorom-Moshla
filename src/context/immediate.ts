import * as vscode from 'vscode';

export class ImmediateContextExtractor {
  public static getActiveFileContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }

    const document = editor.document;
    const selection = editor.selection;
    const activeLine = selection.active.line;

    const startLine = Math.max(0, activeLine - 100);
    const endLine = Math.min(document.lineCount - 1, activeLine + 100);

    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    const text = document.getText(range);

    return `Active File: ${document.fileName}\nSelection Context:\n${text}`;
  }
}

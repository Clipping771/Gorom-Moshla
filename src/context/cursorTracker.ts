import * as vscode from 'vscode';

export interface CursorContext {
  activeFile: string;
  activeLine: number;
  selectedText: string;
  currentWord: string;
}

export class CursorTracker {
  public static getCursorContext(): CursorContext | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const selection = editor.selection;
    
    const wordRange = document.getWordRangeAtPosition(selection.active);
    const currentWord = wordRange ? document.getText(wordRange) : '';

    return {
      activeFile: document.fileName,
      activeLine: selection.active.line,
      selectedText: document.getText(selection),
      currentWord
    };
  }
}

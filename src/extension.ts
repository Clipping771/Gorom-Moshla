import * as vscode from 'vscode';
import { SidebarProvider } from './ui/panel';
import { FloatingPanel } from './ui/floatingPanel';
import { socketClient } from './core/socketClient';

export function activate(context: vscode.ExtensionContext) {
  console.log('Gorom Moshla is active - Connecting to Runtime...');

  // Initialize Socket Connection
  socketClient.connect();

  const sidebarProvider = new SidebarProvider(context.extensionUri);

  // ── Sidebar (activity bar) ──────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ── Command: focus sidebar ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('gorom-moshla.start', () => {
      vscode.commands.executeCommand('goromMoshla.chatView.focus');
    })
  );

  // ── Command: open/toggle floating panel ─────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('gorom-moshla.openFloat', () => {
      FloatingPanel.open(context.extensionUri, vscode.ViewColumn.Beside);
    })
  );

  // ── Command: open floating panel on the right (column 2) ────────
  context.subscriptions.push(
    vscode.commands.registerCommand('gorom-moshla.openFloatRight', () => {
      FloatingPanel.open(context.extensionUri, vscode.ViewColumn.Two);
    })
  );

  // ── Command: fix terminal error ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('gorom-moshla.fixTerminalError', async () => {
      const initialClipboard = await vscode.env.clipboard.readText();
      
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      await new Promise(r => setTimeout(r, 100)); // wait for clipboard
      let text = await vscode.env.clipboard.readText();
      
      if (text === initialClipboard) {
        await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        await new Promise(r => setTimeout(r, 100));
        text = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
      }
      
      if (!text || text === initialClipboard) {
        vscode.window.showInformationMessage("Gorom Moshla: Could not capture terminal text.");
        return;
      }
      
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
      
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath || 'None';
      const prompt = `Analyze and fix this terminal output/error:\n\n\`\`\`\n${text.substring(0, 4000)}\n\`\`\`\n\nActive File: ${activeFile}\nUse tools like listDir, grepSearch to find the root cause and editFile to fix it.`;
      
      vscode.commands.executeCommand('goromMoshla.chatView.focus');
      socketClient.sendTask(prompt, workspaceRoot);
    })
  );
}

export function deactivate() { }


import * as vscode from 'vscode';
import { SidebarProvider } from './panel';
import { socketClient } from '../core/socketClient';

/**
 * Floating / detachable chat panel.
 * Uses vscode.window.createWebviewPanel so it lives in the editor area
 * and can be dragged to any column, split, or kept beside the code.
 */
export class FloatingPanel {
    private static _instance: FloatingPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static readonly viewType = 'goromMoshla.floatingChat';

    private constructor(
        private readonly _extensionUri: vscode.Uri,
        column: vscode.ViewColumn
    ) {
        this._panel = vscode.window.createWebviewPanel(
            FloatingPanel.viewType,
            '🌶️ Gorom Moshla',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,   // keep JS state when tab is not focused
                localResourceRoots: [_extensionUri]
            }
        );

        this._panel.webview.html = SidebarProvider.buildHtml(
            vscode.workspace.getConfiguration('goromMoshla')
        );

        this._registerListeners();

        // Clean up when user closes the panel
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /** Open or reveal the floating panel */
    public static open(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Beside
    ): FloatingPanel {
        if (FloatingPanel._instance) {
            FloatingPanel._instance._panel.reveal(column);
            return FloatingPanel._instance;
        }
        FloatingPanel._instance = new FloatingPanel(extensionUri, column);
        return FloatingPanel._instance;
    }

    public static isOpen(): boolean {
        return !!FloatingPanel._instance;
    }

    private _post(data: object) {
        this._panel.webview.postMessage(data);
    }

    private _registerListeners() {
        // Socket -> Webview UI
        socketClient.onMessage((msg) => {
            if (msg.type === 'plan') {
                this._post({ type: 'thinkingPhase', phase: 'Planning', detail: msg.data });
            } else if (msg.type === 'tool') {
                this._post({ type: 'thinkingPhase', phase: 'Executing', detail: msg.data });
            } else if (msg.type === 'edit') {
                this._post({ type: 'thinkingPhase', phase: 'Executing', detail: `Edited ${msg.data.file}` });
            } else if (msg.type === 'error') {
                this._post({ type: 'error', value: msg.data });
            } else if (msg.type === 'done') {
                this._post({ type: 'response', value: msg.data });
                this._post({ type: 'cleared' });
            } else if (msg.type === 'fix') {
                this._post({ type: 'thinkingPhase', phase: 'Self-Healing', detail: msg.data });
            }
        });

        // Webview → Socket
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {

                case 'submit':
                    this._post({ type: 'userMessage', text: msg.text });
                    this._post({ type: 'thinking' });
                    try {
                        await this._orchestrator.run(msg.text, msg.attachments, msg.mode);
                    } catch (err: any) {
                        this._post({ type: 'error', value: String(err?.message || err) });
                    }
                    break;

                case 'approvePlan':
                case 'rejectPlan':
                    break;

                case 'setProvider':
                    await vscode.workspace.getConfiguration('goromMoshla').update('aiProvider', msg.provider, vscode.ConfigurationTarget.Global);
                    await vscode.workspace.getConfiguration('goromMoshla').update('model', '', vscode.ConfigurationTarget.Global);
                    break;

                case 'setApiKey': {
                    await vscode.workspace.getConfiguration('goromMoshla').update('apiKey', msg.key, vscode.ConfigurationTarget.Global);
                    break;
                }

                case 'fetchModels': {
                    this._post({ type: 'modelsLoaded', models: [{id: 'gpt-4o', label: 'OpenAI GPT-4o'}], fetchError: null });
                    break;
                }

                case 'setModel':
                    await vscode.workspace.getConfiguration('goromMoshla').update('model', msg.model, vscode.ConfigurationTarget.Global);
                    break;

                case 'clearChat':
                    this._post({ type: 'cleared' });
                    break;

                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'goromMoshla');
                    break;

                case 'openFile':
                    if (msg.path) {
                        const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
                        // eslint-disable-next-line @typescript-eslint/no-var-requires
                        const nodePath = require('path') as typeof import('path');
                        const full = nodePath.resolve(root, msg.path);
                        vscode.window.showTextDocument(vscode.Uri.file(full));
                    }
                    break;
            }
        }, null, this._disposables);
    }

    public dispose() {
        FloatingPanel._instance = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}

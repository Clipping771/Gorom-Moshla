import * as vscode from 'vscode';
import { globalEventBus } from '../core/eventBus';
import { Orchestrator } from '../core/orchestrator';
import { fetchModelsForProvider } from '../ai/providerFactory';
import { SidebarProvider } from './panel';

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
        private readonly _orchestrator: Orchestrator,
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
        orchestrator: Orchestrator,
        column: vscode.ViewColumn = vscode.ViewColumn.Beside
    ): FloatingPanel {
        if (FloatingPanel._instance) {
            FloatingPanel._instance._panel.reveal(column);
            return FloatingPanel._instance;
        }
        FloatingPanel._instance = new FloatingPanel(extensionUri, orchestrator, column);
        return FloatingPanel._instance;
    }

    public static isOpen(): boolean {
        return !!FloatingPanel._instance;
    }

    private _post(data: object) {
        this._panel.webview.postMessage(data);
    }

    private _registerListeners() {
        // Extension → Webview
        const eb = globalEventBus;
        eb.on('onStatePhaseChange', (p) => this._post({ type: 'phase', value: p.newPhase }));
        eb.on('onAIResponse', (p) => this._post({ type: 'response', value: p.rawOutput }));
        eb.on('onAIStreamChunk', (p) => this._post({ type: 'chunk', value: p.chunk }));
        eb.on('onPlanReady', (p) => this._post({ type: 'planReady', title: p.title, steps: p.steps }));
        eb.on('onStepUpdate', (p) => this._post({ type: 'stepUpdate', index: p.index, status: p.status, message: p.message }));
        eb.on('onWaitingForApproval', () => this._post({ type: 'waitingForApproval' }));
        eb.on('onPlanRejected', () => this._post({ type: 'planRejected' }));

        // Webview → Extension
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {

                case 'submit':
                    this._post({ type: 'userMessage', text: msg.text });
                    this._post({ type: 'thinking' });
                    try {
                        await this._orchestrator.run(msg.text);
                    } catch (err: any) {
                        this._post({ type: 'error', value: String(err?.message || err) });
                    }
                    break;

                case 'approvePlan':
                    this._orchestrator.approvePlan();
                    break;

                case 'rejectPlan':
                    this._orchestrator.rejectPlan();
                    break;

                case 'setProvider':
                    await vscode.workspace.getConfiguration('goromMoshla').update('aiProvider', msg.provider, vscode.ConfigurationTarget.Global);
                    await vscode.workspace.getConfiguration('goromMoshla').update('model', '', vscode.ConfigurationTarget.Global);
                    break;

                case 'setApiKey': {
                    await vscode.workspace.getConfiguration('goromMoshla').update('apiKey', msg.key, vscode.ConfigurationTarget.Global);
                    const prov = vscode.workspace.getConfiguration('goromMoshla').get<string>('aiProvider') || 'groq';
                    this._post({ type: 'modelsLoading' });
                    const r = await fetchModelsForProvider(prov, msg.key);
                    this._post({ type: 'modelsLoaded', models: r.models, fetchError: r.error });
                    break;
                }

                case 'fetchModels': {
                    const key = vscode.workspace.getConfiguration('goromMoshla').get<string>('apiKey') || '';
                    if (!key) { this._post({ type: 'modelsLoaded', models: [], fetchError: 'No API key' }); return; }
                    this._post({ type: 'modelsLoading' });
                    const r = await fetchModelsForProvider(msg.provider, key);
                    this._post({ type: 'modelsLoaded', models: r.models, fetchError: r.error });
                    break;
                }

                case 'setModel':
                    await vscode.workspace.getConfiguration('goromMoshla').update('model', msg.model, vscode.ConfigurationTarget.Global);
                    break;

                case 'clearChat':
                    this._orchestrator.clearHistory();
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

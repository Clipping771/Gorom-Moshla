import * as vscode from 'vscode';
import { globalEventBus } from '../core/eventBus';
import { Orchestrator } from '../core/orchestrator';
import { fetchModelsForProvider } from '../ai/providerFactory';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'goromMoshla.chatView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _orchestrator: Orchestrator
  ) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    // Extension → Webview events
    globalEventBus.on('onStatePhaseChange', (p) => this._post({ type: 'phase', value: p.newPhase }));
    globalEventBus.on('onAIResponse', (p) => this._post({ type: 'response', value: p.rawOutput }));
    globalEventBus.on('onAIStreamChunk', (p) => this._post({ type: 'chunk', value: p.chunk }));
    globalEventBus.on('onPlanReady', (p) => this._post({ type: 'planReady', title: p.title, steps: p.steps }));
    globalEventBus.on('onStepUpdate', (p) => this._post({ type: 'stepUpdate', index: p.index, status: p.status, message: p.message, result: p.result, elapsed: p.elapsed }));
    globalEventBus.on('onWaitingForApproval', () => this._post({ type: 'waitingForApproval' }));
    globalEventBus.on('onPlanRejected', () => this._post({ type: 'planRejected' }));
    // New Cursor-style events
    globalEventBus.on('onThinkingPhase', (p) => this._post({ type: 'thinkingPhase', phase: p.phase, detail: p.detail }));
    globalEventBus.on('onContextExploring', (p) => this._post({ type: 'contextExploring', files: p.files, folders: p.folders, entries: p.entries }));
    globalEventBus.on('onFilesChanged', (p) => this._post({ type: 'filesChanged', files: p.files }));
    globalEventBus.on('onThoughts', (p) => this._post({ type: 'thoughts', value: p.thoughts }));

    // Webview → Extension messages
    webviewView.webview.onDidReceiveMessage(async (msg) => {
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
          // Use the provider sent from the webview directly (not from config which may lag)
          const prov = msg.provider || vscode.workspace.getConfiguration('goromMoshla').get<string>('aiProvider') || 'groq';
          this._post({ type: 'modelsLoading' });
          const r1 = await fetchModelsForProvider(prov, msg.key);
          this._post({ type: 'modelsLoaded', models: r1.models, fetchError: r1.error });
          break;
        }

        case 'fetchModels': {
          const apiKey = vscode.workspace.getConfiguration('goromMoshla').get<string>('apiKey') || '';
          if (!apiKey) { this._post({ type: 'modelsLoaded', models: [], fetchError: 'No API key set' }); return; }
          this._post({ type: 'modelsLoading' });
          const r2 = await fetchModelsForProvider(msg.provider, apiKey);
          this._post({ type: 'modelsLoaded', models: r2.models, fetchError: r2.error });
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
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const nodePath = require('path') as typeof import('path');
            const fullPath = nodePath.resolve(workspaceRoot, msg.path);
            vscode.window.showTextDocument(vscode.Uri.file(fullPath));
          }
          break;
      }
    });
  }

  private _post(data: object) {
    this._view?.webview.postMessage(data);
  }

  /** Returns the markdown renderer JS as a string to be injected into the webview HTML. */
  private static _markdownRendererJs(): string {
    const tick = '\x60';
    const t3 = tick + tick + tick;
    return [
      'function renderMarkdown(text){',
      '  var t3=' + JSON.stringify(t3) + ',t1=' + JSON.stringify(tick) + ';',
      '  var html = text',
      '    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")',
      '    .replace(new RegExp(t3+"(\\\\w*)\\\\n?([\\\\s\\\\S]*?)"+t3,"g"),function(_,l,c){return "<pre><code>"+c.trim()+"</code></pre>";})',
      '    .replace(new RegExp(t1+"([^"+t1+"\\\\n]+)"+t1,"g"),"<code>$1</code>")',
      '    .replace(/[*][*]([^*]+)[*][*]/g,"<strong>$1</strong>")',
      '    .replace(/^### (.+)$/gm,"<h3>$1</h3>")',
      '    .replace(/^## (.+)$/gm,"<h2>$1</h2>")',
      '    .replace(/^# (.+)$/gm,"<h1>$1</h1>")',
      '    .replace(/^---$/gm,"<hr>")',
      '    .replace(/^[ \\t]*[-*] (.+)$/gm,"<li>$1</li>")',
      '    .replace(/(<li>[\\s\\S]*?<\\/li>)+/g,function(m){return "<ul>"+m+"</ul>";})',
      '    .replace(/\\n\\n/g,"</p><p>")',
      '    .replace(/\\n/g,"<br>");',
      '  return "<p>"+html+"</p>";',
      '}'
    ].join('\n');
  }

  /** Public static so FloatingPanel can reuse the same HTML */
  public static buildHtml(config: vscode.WorkspaceConfiguration): string {
    const provider = config.get<string>('aiProvider') || 'groq';
    const hasKey = !!(config.get<string>('apiKey'));
    const savedModel = config.get<string>('model') || '';
    const providers = ['groq', 'gemini', 'openrouter', 'huggingface'];

    return SidebarProvider._buildHtmlBody(provider, hasKey, savedModel, providers);
  }

  private _getHtml(): string {
    const config = vscode.workspace.getConfiguration('goromMoshla');
    return SidebarProvider.buildHtml(config);
  }

  private static _buildHtmlBody(provider: string, hasKey: boolean, savedModel: string, providers: string[]): string {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _unused = provider; // kept for future per-provider UI tweaks

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #09090b;
  --bg-panel: #111114;
  --bg-input: #18181c;
  --border: #222226;
  --border-focus: #ea580c;
  --text: #f4f4f5;
  --text-muted: #d4d4d8;
  --text-subtle: #71717a;
  --accent: #ea580c;
  --accent-glow: rgba(234, 88, 12, 0.15);
  --accent-blue: #f97316;
  --green: #10b981;
  --red: #ef4444;
  --orange: #f97316;
  --mono: 'JetBrains Mono', monospace;
}

html, body {
  height: 100%;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* ── HEADER ─────────────────────────────────── */
#header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  z-index: 10;
}
.logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; color: var(--orange); }
.logo-icon {
  font-size: 15px;
  opacity: 1;
  animation: pulse-glow 2s ease-in-out infinite;
}
@keyframes pulse-glow {
  0%, 100% { opacity: 0.8; filter: drop-shadow(0 0 2px rgba(249, 115, 22, 0.4)); }
  50% { opacity: 1; filter: drop-shadow(0 0 8px rgba(249, 115, 22, 0.8)); }
}
.hdr-actions { display: flex; gap: 4px; }
.icon-btn {
  background: transparent; border: 1px solid transparent; color: var(--text-subtle);
  width: 24px; height: 24px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; font-size: 14px;
  cursor: pointer; transition: all .15s ease;
}
.icon-btn:hover { background: var(--bg-input); color: var(--text); border-color: var(--border); }

/* ── CONFIG PANEL ────────────────────────────── */
#config-panel {
  background: var(--bg-panel); border-bottom: 1px solid var(--border);
  flex-shrink: 0; overflow: hidden; transition: max-height .2s ease-out; max-height: 220px;
}
#config-panel.collapsed { max-height: 0; border-bottom-color: transparent; }
#config-inner { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.cfg-row { display: flex; align-items: center; gap: 8px; }
.cfg-lbl { font-size: 10px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.5px; width: 60px; flex-shrink: 0; font-weight: 500; }
select, input[type=password], input[type=search] {
  flex: 1; min-width: 0; background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 6px 8px; font-size: 12px; font-family: inherit; outline: none;
  transition: border-color .15s;
}
select:focus, input:focus { border-color: var(--border-focus); box-shadow: 0 0 6px var(--accent-glow); }
select:disabled, input:disabled { opacity: .5; cursor: not-allowed; }
.save-btn {
  background: var(--accent); color: white; border: none; border-radius: 4px;
  padding: 6px 12px; font-size: 11px; font-weight: 600; cursor: pointer;
  transition: opacity .15s; flex-shrink: 0;
}
.save-btn:hover:not(:disabled) { opacity: 0.9; }
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; font-weight: 500; }
.badge.ok { background: rgba(16, 185, 129, 0.1); color: var(--green); }
.badge.miss { background: rgba(239, 68, 68, 0.1); color: var(--red); }
#model-search-row { display: none; }
#model-search-row.show { display: flex; }
#model-count { font-size: 10px; color: var(--text-subtle); font-variant-numeric: tabular-nums; }

/* ── STATUS BAR ──────────────────────────────── */
#statusbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; background: var(--bg-panel); border-bottom: 1px solid var(--border);
  font-size: 11px; flex-shrink: 0; color: var(--text-muted);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-subtle); flex-shrink: 0; transition: background .3s; }
.dot.busy { background: var(--accent); box-shadow: 0 0 6px var(--accent); animation: pulse 2s ease-in-out infinite; }
.dot.error { background: var(--red); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
#status-text { font-weight: 600; color: var(--text-muted); }
#model-chip { margin-left: auto; font-size: 10px; color: var(--orange); font-family: var(--mono); }

/* ── MAIN AREA ───────────────────────────────── */
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* ── THOUGHT BUBBLE ──────────────────────────── */
.thought-bubble {
  margin: 12px 0;
  padding: 12px;
  background: rgba(234, 88, 12, 0.03);
  border: 1px solid rgba(234, 88, 12, 0.15);
  border-radius: 8px;
  font-family: 'Inter', sans-serif;
  color: var(--text-muted);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transition: all 0.3s ease;
  width: 100%;
}
.thought-bubble-hdr {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 600;
  color: var(--orange);
  user-select: none;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.thought-bubble-hdr .chevron {
  transition: transform 0.2s;
  font-size: 9px;
  color: var(--text-subtle);
}
.thought-bubble-body {
  display: none;
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  border-left: 2px solid rgba(234, 88, 12, 0.25);
  padding-left: 10px;
  color: var(--text-muted);
  white-space: pre-wrap;
}
.thought-bubble.open .thought-bubble-body {
  display: block;
}
.thought-bubble-icon {
  animation: float-pepper 3s ease-in-out infinite;
}
@keyframes float-pepper {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

/* ── INLINE AGENT BLOCKS (TERMINAL STYLE) ────── */
.inline-plan-block {
  margin: 16px 0; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-panel); overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
}
.inline-plan-hdr {
  padding: 10px 14px; background: var(--bg-input); border-bottom: 1px solid var(--border);
  font-size: 11px; font-family: var(--mono); color: var(--orange); display: flex; align-items: center; gap: 8px;
  font-weight: 600;
}
.inline-plan-steps { padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.inline-step {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  font-size: 11.5px; font-family: var(--mono); color: var(--text-muted);
  border-left: 2px solid transparent; border-radius: 4px; transition: all .2s;
}
.inline-step.running { color: var(--orange); border-left-color: var(--orange); background: rgba(234, 88, 12, 0.05); }
.inline-step.done { color: var(--text); background: rgba(255,255,255,0.01); }
.inline-step.error { color: var(--red); border-left-color: var(--red); background: rgba(239, 68, 68, 0.03); }
.step-icon { font-size: 12px; display: flex; align-items: center; justify-content: center; width: 14px; opacity: 0.9; }
.inline-step.running .step-icon { animation: spin 1.2s linear infinite; }
@keyframes spin { 100% { transform: rotate(360deg); } }
.step-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── PERMISSION CARD ────────────────────────── */
.permission-card {
  padding: 14px; background: var(--bg-input); border-top: 1px solid var(--border);
  display: none; flex-direction: column; gap: 12px;
}
.permission-card.show { display: flex; }
.perm-hdr { font-size: 12px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
.perm-icon { color: var(--orange); }
.perm-text { font-family: var(--mono); font-size: 11px; color: var(--text-subtle); }
.perm-actions { display: flex; gap: 8px; }
.btn-allow { background: var(--accent); color: white; border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; flex: 1; font-size: 11.5px; font-weight: 600; transition: opacity .15s; }
.btn-allow:hover { opacity: 0.95; }
.btn-deny { background: transparent; color: var(--text); border: 1px solid var(--border); padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 11.5px; transition: background .15s; }
.btn-deny:hover { background: var(--bg-panel); }

/* ── MESSAGES ────────────────────────────────── */
#messages {
  flex: 1; overflow-y: auto; padding: 20px 16px;
  display: flex; flex-direction: column; gap: 20px;
  scroll-behavior: smooth;
}

.msg-wrap { display: flex; flex-direction: column; }
.msg { line-height: 1.6; font-size: 13px; color: var(--text); word-wrap: break-word; }

/* User message: Flat, elegant card style */
.msg-wrap.user-wrap { align-items: flex-end; }
.msg.user {
  background: var(--bg-panel); color: var(--text);
  padding: 10px 14px; border-radius: 8px;
  max-width: 85%; font-weight: 400; border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

/* AI message: Flat, full width, document style */
.msg-wrap.ai-wrap { align-items: flex-start; width: 100%; }
.msg.ai { width: 100%; }
.msg.ai p { margin-bottom: 12px; }
.msg.ai p:last-child { margin-bottom: 0; }
.msg.ai h1, .msg.ai h2, .msg.ai h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; color: var(--orange); }
.msg.ai code { background: var(--bg-panel); color: var(--orange); padding: 2px 5px; border-radius: 4px; font-family: var(--mono); font-size: 11px; border: 1px solid var(--border); }
.msg.ai pre {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px; margin: 12px 0; overflow-x: auto; font-family: var(--mono); font-size: 11px; line-height: 1.5;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
}
.msg.ai pre code { background: transparent; border: none; padding: 0; color: var(--text-muted); }
.msg.ai ul, .msg.ai ol { padding-left: 20px; margin-bottom: 12px; }
.msg.ai li { margin-bottom: 4px; }
.msg.ai a { color: var(--orange); text-decoration: none; font-weight: 500; }
.msg.ai a:hover { text-decoration: underline; }
.msg.ai hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }

.msg.error { color: var(--red); font-size: 12px; font-family: var(--mono); background: rgba(239,68,68,0.05); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(239,68,68,0.15); width: 100%; }
.msg.system { color: var(--text-subtle); font-size: 11px; text-align: center; align-self: center; margin-bottom: 8px; font-family: var(--mono); }

/* Thinking Indicator */
.msg.thinking { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 11px; color: var(--orange); }
.loader { display: flex; gap: 4px; }
.loader span { width: 5px; height: 5px; background: var(--orange); border-radius: 50%; animation: blink 1.4s infinite both; }
.loader span:nth-child(2) { animation-delay: 0.2s; }
.loader span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }

/* ── THINKING TIMER BLOCK (Cursor-style "Thought for Xs") ── */
.think-timer-block {
  margin: 8px 0; padding: 8px 12px; border-radius: 8px;
  background: var(--bg-panel); border: 1px solid var(--border);
  font-size: 11px; font-family: var(--mono); color: var(--text-muted);
  cursor: pointer; user-select: none; transition: background .15s;
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
  width: 100%;
}
.think-timer-block:hover { background: var(--bg-input); }
.think-timer-hdr { display: flex; align-items: center; gap: 6px; }
.think-timer-hdr .chevron { font-size: 9px; transition: transform .2s; color: var(--text-subtle); }
.think-timer-block.open .think-timer-hdr .chevron { transform: rotate(90deg); }
.think-timer-phase { color: var(--text-muted); font-weight: 500; }
.think-timer-dur { margin-left: auto; color: var(--orange); font-variant-numeric: tabular-nums; font-weight: 600; }
.think-timer-body { display: none; padding: 8px 0 2px 18px; font-size: 10.5px; color: var(--text-subtle); line-height: 1.6; }
.think-timer-block.open .think-timer-body { display: block; }
.think-phase-entry { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.02); }
.think-phase-entry .ph-icon { width: 14px; text-align: center; font-size: 10px; }
.think-phase-entry .ph-text { flex: 1; }

/* ── CONTEXT EXPLORER ── */
.ctx-explorer {
  margin: 4px 0 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--bg-panel); border: 1px solid var(--border);
  font-size: 11px; font-family: var(--mono); color: var(--text-muted);
  cursor: pointer; user-select: none;
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
  width: 100%;
}
.ctx-explorer:hover { background: var(--bg-input); }
.ctx-hdr { display: flex; align-items: center; gap: 6px; }
.ctx-hdr .chevron { font-size: 9px; transition: transform .2s; color: var(--text-subtle); }
.ctx-explorer.open .ctx-hdr .chevron { transform: rotate(90deg); }
.ctx-body { display: none; padding: 8px 0 2px 18px; }
.ctx-explorer.open .ctx-body { display: block; }
.ctx-entry { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 10.5px; color: var(--text-muted); border-bottom: 1px solid rgba(255,255,255,0.01); }
.ctx-entry .ctx-icon { width: 14px; text-align: center; font-size: 11px; }
.ctx-entry .ctx-type { color: var(--orange); font-size: 8.5px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; min-width: 20px; }
.ctx-entry .ctx-name { flex: 1; color: var(--text); }
.ctx-entry .ctx-detail { color: var(--text-subtle); font-size: 10px; }

/* ── STEP RESULT + ELAPSED ── */
.step-elapsed { font-size: 9px; color: var(--text-subtle); margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.step-result {
  font-size: 10px; color: var(--text-subtle); padding: 6px 10px; margin: 4px 0 4px 24px;
  background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 4px;
  font-family: var(--mono); white-space: pre-wrap; overflow-x: auto; max-height: 120px;
}

/* ── FILES CHANGED SUMMARY BAR ── */
.files-changed-bar {
  margin: 12px 0 4px; padding: 10px 14px; border-radius: 8px;
  background: var(--bg-panel); border: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; font-family: var(--mono); color: var(--text-muted);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  width: 100%;
}
.files-changed-bar .fc-icon { font-size: 13px; }
.files-changed-bar .fc-count { color: var(--text); font-weight: 600; }
.files-changed-bar .fc-btn {
  margin-left: auto; background: var(--bg-input); border: 1px solid var(--border);
  color: var(--text-muted); padding: 5px 12px; border-radius: 4px; font-size: 10px;
  cursor: pointer; font-family: var(--mono); transition: all .15s; font-weight: 500;
}
.files-changed-bar .fc-btn:hover { background: var(--border); color: var(--text); border-color: var(--text-subtle); }

/* ── INPUT ───────────────────────────────────── */
#input-area {
  padding: 14px 16px 20px; background: var(--bg-panel);
  border-top: 1px solid var(--border); flex-shrink: 0; z-index: 10;
}
#input-box {
  display: flex; gap: 8px; align-items: flex-end;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 8px 8px 12px; transition: all .2s;
}
#input-box:focus-within { border-color: var(--border-focus); box-shadow: 0 0 8px var(--accent-glow); }
#inp {
  flex: 1; background: transparent; color: var(--text); border: none;
  padding: 4px 0; font-size: 13px; font-family: inherit;
  outline: none; resize: none; min-height: 20px; max-height: 200px; line-height: 1.5;
}
#inp::placeholder { color: var(--text-subtle); }
#send-btn {
  background: transparent; color: var(--text-subtle); border: none;
  width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 14px; border-radius: 4px; transition: all .15s;
}
#send-btn:hover:not(:disabled) { background: var(--bg-panel); color: var(--orange); }
#send-btn:disabled { color: var(--border); cursor: not-allowed; }
#hint { font-size: 10px; color: var(--text-subtle); margin-top: 8px; text-align: center; font-family: var(--mono); }

/* ── SCROLLBAR ───────────────────────────────── */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; border: 2px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background: var(--border-focus); }
</style>
</head>
<body>
<div id="app">

  <!-- HEADER -->
  <div id="header">
    <div class="logo">
      <span class="logo-icon">✦</span>
      <span class="logo-text">Gorom Moshla</span>
    </div>
    <div class="hdr-actions">
      <button class="icon-btn" id="cfg-toggle-btn" title="Toggle settings">⚙</button>
      <button class="icon-btn" id="clear-btn" title="New chat">🗑</button>
    </div>
  </div>

  <!-- CONFIG PANEL -->
  <div id="config-panel">
    <div id="config-inner">
      <div class="cfg-row">
        <span class="cfg-lbl">Provider</span>
        <select id="prov-sel">
          ${providers.map(p => `<option value="${p}"${p === provider ? ' selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="cfg-row">
        <span class="cfg-lbl">API Key</span>
        <input type="password" id="key-inp" placeholder="${hasKey ? '•••••••• (key saved)' : 'Paste API key here…'}" />
        <button class="save-btn" id="key-save">Save</button>
        <span class="badge ${hasKey ? 'ok' : 'miss'}" id="key-badge">${hasKey ? '✓ Set' : '✗'}</span>
      </div>
      <div class="cfg-row" id="model-search-row">
        <span class="cfg-lbl">Search</span>
        <input type="search" id="model-search" placeholder="Filter models…" />
        <span id="model-count"></span>
      </div>
      <div class="cfg-row">
        <span class="cfg-lbl">Model</span>
        <select id="model-sel" ${hasKey ? '' : 'disabled'}>
          <option value="">${hasKey ? '⟳ Loading…' : '— save key first —'}</option>
        </select>
      </div>
    </div>
  </div>

  <!-- STATUS BAR -->
  <div id="statusbar">
    <div class="dot" id="dot"></div>
    <span id="status-text">Ready</span>
    <span id="model-chip">—</span>
  </div>

  <!-- MAIN AREA -->
  <div id="main">

    <!-- MESSAGES -->
    <div id="messages">
      <div class="msg system">Gorom Moshla Workspace Active</div>
      ${!hasKey ? '<div class="msg error">⚠ API Key not set. Click ⚙ to configure.</div>' : ''}
    </div>

  </div>

  <!-- INPUT -->
  <div id="input-area">
    <div id="input-box">
      <textarea id="inp" rows="1" placeholder="Ask me to build, edit, debug, or explain anything…"></textarea>
      <button id="send-btn" title="Send (Enter)">↑</button>
    </div>
    <div id="hint">Enter to send · Shift+Enter for new line</div>
  </div>

</div>
<script>
(function(){
  var vsc = acquireVsCodeApi();

  // DOM refs
  var dot        = document.getElementById('dot');
  var statusText = document.getElementById('status-text');
  var modelChip  = document.getElementById('model-chip');
  var messages   = document.getElementById('messages');
  var inp        = document.getElementById('inp');
  var sendBtn    = document.getElementById('send-btn');
  var provSel    = document.getElementById('prov-sel');
  var keyInp     = document.getElementById('key-inp');
  var keySave    = document.getElementById('key-save');
  var keyBadge   = document.getElementById('key-badge');
  var modelSel   = document.getElementById('model-sel');
  var modelSearch= document.getElementById('model-search');
  var modelSearchRow = document.getElementById('model-search-row');
  var modelCount = document.getElementById('model-count');
  var cfgPanel   = document.getElementById('config-panel');
  var cfgBtn     = document.getElementById('cfg-toggle-btn');

  var busy = false;
  var aiDiv = null;
  var thinkDiv = null;
  var allModels = [];
  var hasKey = ${hasKey};
  var savedModel = ${JSON.stringify(savedModel)};

  // ── Config toggle ─────────────────────────────────────────────────
  cfgBtn.addEventListener('click', function(){
    cfgPanel.classList.toggle('collapsed');
  });
  // Start collapsed if key is already set
  if (hasKey) cfgPanel.classList.add('collapsed');

  // ── Provider ──────────────────────────────────────────────────────
  provSel.addEventListener('change', function(){
    vsc.postMessage({ type:'setProvider', provider:this.value });
    allModels = [];
    modelSel.innerHTML = '<option value="">⟳ Loading…</option>';
    modelSearchRow.classList.remove('show');
    if (hasKey) vsc.postMessage({ type:'fetchModels', provider:this.value });
  });

  // ── API Key ───────────────────────────────────────────────────────
  keySave.addEventListener('click', doSaveKey);
  keyInp.addEventListener('keydown', function(e){ if(e.key==='Enter') doSaveKey(); });
  function doSaveKey(){
    var k = keyInp.value.trim();
    if (!k) return;
    keyInp.value = '';
    keyInp.placeholder = '•••••••• (key saved)';
    keyInp.disabled = true;
    keySave.disabled = true;
    modelSel.disabled = true;
    modelSel.innerHTML = '<option value="">⟳ Fetching models…</option>';
    vsc.postMessage({ type:'setApiKey', key:k, provider:provSel.value });
  }

  // ── Models ────────────────────────────────────────────────────────
  function renderModels(q){
    var filtered = q
      ? allModels.filter(function(m){ return (m.id+m.label).toLowerCase().includes(q.toLowerCase()); })
      : allModels;
    modelSel.innerHTML = '';
    if (!filtered.length){ modelSel.innerHTML='<option>No results</option>'; return; }
    filtered.forEach(function(m){
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label !== m.id ? m.label + '  (' + m.id + ')' : m.id;
      if (m.id === savedModel) o.selected = true;
      modelSel.appendChild(o);
    });
    if (!modelSel.value) modelSel.value = filtered[0].id;
    modelCount.textContent = filtered.length + '/' + allModels.length;
    updateChip(modelSel.value);
  }
  function updateChip(id){
    if (!id){ modelChip.textContent='—'; return; }
    var m = allModels.find(function(x){ return x.id===id; });
    var label = m ? (m.label !== m.id ? m.label : m.id) : id;
    modelChip.textContent = label;
    modelChip.title = id;
  }
  modelSearch.addEventListener('input', function(){ renderModels(this.value); });
  modelSel.addEventListener('change', function(){
    savedModel = this.value;
    vsc.postMessage({ type:'setModel', model:this.value });
    updateChip(this.value);
  });
  if (hasKey) {
    vsc.postMessage({ type:'fetchModels', provider:provSel.value });
    modelSel.innerHTML = '<option>⟳ Loading…</option>';
  }

  // ── Chat helpers ──────────────────────────────────────────────────
  function addMsg(html, cls, raw){
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap ' + (cls==='user'?'user-wrap':'ai-wrap');
    var d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (raw) {
      d.innerHTML = html; // already sanitized or trusted markdown
    } else {
      d.textContent = html;
    }
    wrap.appendChild(d);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return d;
  }

  ${SidebarProvider._markdownRendererJs()}

  // ── Thinking timer state ──
  var thinkStart = 0;
  var thinkTimerEl = null;
  var thinkTimerInterval = null;
  var thinkPhases = [];

  function startThinkTimer() {
    thinkStart = Date.now();
    thinkPhases = [];
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap ai-wrap';
    var block = document.createElement('div');
    block.className = 'think-timer-block';
    block.innerHTML =
      '<div class="think-timer-hdr">' +
        '<span class="chevron">›</span>' +
        '<span class="think-timer-phase">Thinking…</span>' +
        '<span class="think-timer-dur">0s</span>' +
      '</div>' +
      '<div class="think-timer-body"></div>';
    block.addEventListener('click', function(){ block.classList.toggle('open'); });
    wrap.appendChild(block);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    thinkTimerEl = block;
    thinkTimerInterval = setInterval(function(){
      if (!thinkTimerEl) return;
      var elapsed = ((Date.now() - thinkStart) / 1000).toFixed(0);
      thinkTimerEl.querySelector('.think-timer-dur').textContent = elapsed + 's';
    }, 500);
  }

  function updateThinkPhase(phase, detail) {
    if (!thinkTimerEl) startThinkTimer();
    thinkTimerEl.querySelector('.think-timer-phase').textContent = phase;
    var body = thinkTimerEl.querySelector('.think-timer-body');
    var entry = document.createElement('div');
    entry.className = 'think-phase-entry';
    var icons = { 'Collecting context': '🔍', 'Planning approach': '🧠', 'Executing': '⚡', 'Generating': '✨' };
    var icon = '⚙';
    for (var k in icons) { if (phase.indexOf(k) >= 0) { icon = icons[k]; break; } }
    entry.innerHTML = '<span class="ph-icon">' + icon + '</span><span class="ph-text">' + escHtml(phase) + (detail ? ' — ' + escHtml(detail) : '') + '</span>';
    body.appendChild(entry);
    thinkPhases.push({ phase: phase, detail: detail });
  }

  function stopThinkTimer() {
    if (thinkTimerInterval) { clearInterval(thinkTimerInterval); thinkTimerInterval = null; }
    if (thinkTimerEl) {
      var elapsed = ((Date.now() - thinkStart) / 1000).toFixed(0);
      thinkTimerEl.querySelector('.think-timer-dur').textContent = elapsed + 's';
      thinkTimerEl.querySelector('.think-timer-phase').textContent = 'Thought for ' + elapsed + 's';
    }
  }

  function renderContextExplorer(files, folders, entries) {
    var block = document.createElement('div');
    block.className = 'ctx-explorer';
    var summary = 'Exploring ' + files + ' file' + (files !== 1 ? 's' : '') + ', ' + folders + ' folder' + (folders !== 1 ? 's' : '');
    var hdr = '<div class="ctx-hdr"><span class="chevron">›</span><span>' + summary + '</span></div>';
    var body = '<div class="ctx-body">';
    (entries || []).forEach(function(e) {
      var typeLabel = (e.type === 'file' ? 'TS' : e.type === 'definition' ? 'DEF' : e.type === 'workspace' ? 'DIR' : e.type.toUpperCase());
      body += '<div class="ctx-entry">' +
        '<span class="ctx-type">' + typeLabel + '</span>' +
        '<span class="ctx-name">' + escHtml(e.name) + '</span>' +
        (e.detail ? '<span class="ctx-detail">' + escHtml(e.detail) + '</span>' : '') +
        '</div>';
    });
    body += '</div>';
    block.innerHTML = hdr + body;
    block.addEventListener('click', function(){ block.classList.toggle('open'); });
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap ai-wrap';
    wrap.appendChild(block);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  function renderFilesChanged(files) {
    var bar = document.createElement('div');
    bar.className = 'files-changed-bar';
    var created = files.filter(function(f){ return f.action === 'created'; }).length;
    var modified = files.filter(function(f){ return f.action === 'modified'; }).length;
    var label = '';
    if (created > 0) label += created + ' created';
    if (modified > 0) label += (label ? ', ' : '') + modified + ' modified';
    bar.innerHTML =
      '<span class="fc-icon">📄</span>' +
      '<span class="fc-count">' + files.length + ' Files With Changes</span>' +
      '<span style="color:var(--text-subtle);font-size:10px">' + label + '</span>' +
      '<button class="fc-btn">Review Changes</button>';
    bar.querySelector('.fc-btn').addEventListener('click', function(){
      files.forEach(function(f){ vsc.postMessage({ type: 'openFile', path: f.path }); });
    });
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap ai-wrap';
    wrap.appendChild(bar);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  function rmThinking(){
    if (thinkDiv && thinkDiv.parentNode) thinkDiv.parentNode.remove();
    thinkDiv = null;
  }
  function setBusy(b){
    busy = b;
    sendBtn.disabled = b;
    dot.className = 'dot' + (b?' busy':'');
    statusText.textContent = b ? 'Working…' : 'Ready';
  }
  function send(){
    var v = inp.value.trim();
    if (!v || busy) return;
    inp.value=''; inp.style.height='auto';
    vsc.postMessage({ type:'submit', text:v });
    setBusy(true);
    aiDiv = null;
  }

  // ── Task panel helpers ────────────────────────────────────────────
  var stepEls = [];
  var currentPermCard = null;
  function renderInlinePlan(title, steps){
    stepEls = [];
    var block = document.createElement('div');
    block.className = 'inline-plan-block';
    
    var hdr = document.createElement('div');
    hdr.className = 'inline-plan-hdr';
    hdr.textContent = '⚙ ' + title;
    
    var stepsWrap = document.createElement('div');
    stepsWrap.className = 'inline-plan-steps';
    
    steps.forEach(function(s){
      var el = document.createElement('div');
      el.className = 'inline-step';
      var icon = toolIcon(s.tool);
      el.innerHTML =
        '<span class="step-icon">'+icon+'</span>' +
        '<span class="step-label">'+escHtml(s.description)+'</span>';
      stepsWrap.appendChild(el);
      stepEls.push(el);
    });
    
    currentPermCard = document.createElement('div');
    currentPermCard.className = 'permission-card';
    currentPermCard.innerHTML = 
      '<div class="perm-hdr"><span class="perm-icon">▶</span> Allow running this plan?</div>' +
      '<div class="perm-text">' + steps.length + ' tool calls proposed</div>' +
      '<div class="perm-actions">' +
        '<button class="btn-allow">Yes, allow</button>' +
        '<button class="btn-deny">Reject</button>' +
      '</div>';
      
    currentPermCard.querySelector('.btn-allow').addEventListener('click', function(){
      vsc.postMessage({ type: 'approvePlan' });
      currentPermCard.classList.remove('show');
      statusText.textContent = 'Executing…';
    });
    currentPermCard.querySelector('.btn-deny').addEventListener('click', function(){
      vsc.postMessage({ type: 'rejectPlan' });
      currentPermCard.classList.remove('show');
    });

    block.appendChild(hdr);
    block.appendChild(stepsWrap);
    block.appendChild(currentPermCard);
    
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap ai-wrap';
    wrap.appendChild(block);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }
  
  function updateStep(index, status, msg, result, elapsed){
    var el = stepEls[index];
    if (!el) return;
    el.className = 'inline-step ' + status;
    var icon = status==='running'?'⟳':status==='done'?'✓':'✗';
    el.querySelector('.step-icon').textContent = icon;
    if (msg) el.querySelector('.step-label').textContent += ' — ' + msg;
    // Add elapsed time
    if (elapsed !== undefined && elapsed !== null) {
      var existingTime = el.querySelector('.step-elapsed');
      if (!existingTime) {
        var timeEl = document.createElement('span');
        timeEl.className = 'step-elapsed';
        timeEl.textContent = (elapsed / 1000).toFixed(1) + 's';
        el.appendChild(timeEl);
      }
    }
    // Add result snippet below the step
    if (result && status === 'done') {
      var resEl = document.createElement('div');
      resEl.className = 'step-result';
      resEl.textContent = result;
      el.parentNode.insertBefore(resEl, el.nextSibling);
    }
  }
  
  function hideTaskPanel(){
    if (currentPermCard) currentPermCard.classList.remove('show');
    stepEls = [];
  }
  function toolIcon(tool){
    return {createFile:'📄',editFile:'✏',runTerminal:'$',readFile:'👁'}[tool] || '⚙';
  }
  function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderThoughtsBubble(thoughts) {
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap ai-wrap';
    var bubble = document.createElement('div');
    bubble.className = 'thought-bubble open';
    bubble.innerHTML =
      '<div class="thought-bubble-hdr">' +
        '<span class="thought-bubble-icon">🌶️</span>' +
        '<span>Thought Process</span>' +
        '<span class="chevron" style="margin-left:auto">›</span>' +
      '</div>' +
      '<div class="thought-bubble-body">' + escHtml(thoughts) + '</div>';
    bubble.querySelector('.thought-bubble-hdr').addEventListener('click', function(){
      bubble.classList.toggle('open');
      var chevron = bubble.querySelector('.chevron');
      chevron.style.transform = bubble.classList.contains('open') ? 'rotate(90deg)' : 'none';
    });
    wrap.appendChild(bubble);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Input resize ──────────────────────────────────────────────────
  inp.addEventListener('input', function(){ this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,140)+'px'; });
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
  sendBtn.addEventListener('click', send);
  document.getElementById('clear-btn').addEventListener('click', function(){
    messages.innerHTML = '<div class="msg system">Gorom Moshla initialized</div>';
    hideTaskPanel();
    setBusy(false);
    aiDiv = null;
    vsc.postMessage({ type:'clearChat' });
  });
  // Approval buttons are now handled inside renderInlinePlan

  // ── Messages from extension ───────────────────────────────────────
  window.addEventListener('message', function(e){
    var m = e.data;

    if (m.type === 'userMessage') {
      addMsg(m.text, 'user', false);
      // Start thinking timer on user message
      startThinkTimer();

    } else if (m.type === 'thoughts') {
      rmThinking();
      if (m.value) {
        renderThoughtsBubble(m.value);
      }

    } else if (m.type === 'thinking') {
      rmThinking();
      if (!thinkTimerEl) startThinkTimer();

    } else if (m.type === 'thinkingPhase') {
      updateThinkPhase(m.phase, m.detail);

    } else if (m.type === 'contextExploring') {
      renderContextExplorer(m.files, m.folders, m.entries);

    } else if (m.type === 'planReady') {
      rmThinking();
      renderInlinePlan(m.title, m.steps);

    } else if (m.type === 'stepUpdate') {
      updateStep(m.index, m.status, m.message, m.result, m.elapsed);

    } else if (m.type === 'phase') {
      if (m.value === 'PLANNING') {
        statusText.textContent = 'Planning…';
      } else if (m.value === 'EXECUTING') {
        statusText.textContent = 'Executing…';
      } else if (m.value === 'DONE' || m.value === 'ERROR') {
        stopThinkTimer();
        thinkTimerEl = null;
        setBusy(false);
        aiDiv = null;
        if (m.value === 'ERROR') dot.className = 'dot error';
        setTimeout(hideTaskPanel, 1500);
      }

    } else if (m.type === 'waitingForApproval') {
      rmThinking();
      stopThinkTimer();
      statusText.textContent = 'Waiting for Approval';
      dot.className = 'dot busy';
      if (currentPermCard) currentPermCard.classList.add('show');
      messages.scrollTop = messages.scrollHeight;

    } else if (m.type === 'planRejected') {
      statusText.textContent = 'Ready';
      dot.className = 'dot';
      if (currentPermCard) currentPermCard.classList.remove('show');
      setBusy(false);
      hideTaskPanel();
      addMsg('❌ Plan rejected by user', 'error', false);

    } else if (m.type === 'chunk') {
      rmThinking();
      if (!aiDiv) aiDiv = addMsg('', 'ai', true);
      aiDiv.textContent += m.value;
      messages.scrollTop = messages.scrollHeight;

    } else if (m.type === 'response') {
      rmThinking();
      stopThinkTimer();
      setBusy(false);
      var rendered = renderMarkdown(m.value || '');
      if (aiDiv) {
        aiDiv.innerHTML = rendered;
      } else if (m.value && m.value.trim()) {
        addMsg(rendered, 'ai', true);
      }
      aiDiv = null;
      messages.scrollTop = messages.scrollHeight;
      setTimeout(hideTaskPanel, 800);

    } else if (m.type === 'filesChanged') {
      renderFilesChanged(m.files);

    } else if (m.type === 'error') {
      rmThinking();
      stopThinkTimer();
      setBusy(false);
      dot.className = 'dot error';
      addMsg('❌ ' + m.value, 'error', false);
      setTimeout(function(){ dot.className='dot'; }, 3000);

    } else if (m.type === 'cleared') {
      stopThinkTimer();
      thinkTimerEl = null;
      setBusy(false); dot.className='dot';
      aiDiv = null; thinkDiv = null;
      hideTaskPanel();

    } else if (m.type === 'modelsLoading') {
      modelSel.innerHTML = '<option>⟳ Fetching…</option>';
      modelSel.disabled = true;
      modelSearchRow.classList.remove('show');

    } else if (m.type === 'modelsLoaded') {
      keyInp.disabled = false;
      keySave.disabled = false;
      modelSel.disabled = false;
      hasKey = true;
      keyBadge.textContent = '✓ Set';
      keyBadge.className = 'badge ok';
      if (m.fetchError) {
        modelSel.innerHTML = '<option>⚠ ' + m.fetchError + '</option>';
        return;
      }
      allModels = m.models || [];
      if (!allModels.length){ modelSel.innerHTML='<option>No models found</option>'; return; }
      modelSearchRow.classList.add('show');
      modelSearch.value = '';
      renderModels('');
      vsc.postMessage({ type:'setModel', model:modelSel.value });
      // Collapse config after models load
      setTimeout(function(){ cfgPanel.classList.add('collapsed'); }, 600);
    }
  });

})();
</script>
</body>
</html>`;
  }
}

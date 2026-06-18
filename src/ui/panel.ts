import * as vscode from 'vscode';
import { socketClient } from '../core/socketClient';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'goromMoshla.chatView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri
  ) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    // Socket -> Webview UI
    socketClient.onMessage((msg) => {
      // Map server socket events to webview UI events
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
        this._post({ type: 'cleared' }); // stop loading indicators
      } else if (msg.type === 'fix') {
        this._post({ type: 'thinkingPhase', phase: 'Self-Healing', detail: msg.data });
      }
    });

    // Webview -> Socket
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {

        case 'stop':
          this._orchestrator.stop();
          break;

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
          // Optional: send approval commands to socket if implemented in backend
          break;



        case 'setMaxTokens':
          await vscode.workspace.getConfiguration('goromMoshla').update('maxTokens', msg.value, vscode.ConfigurationTarget.Global);
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
          // Hardcoded or mocked for UI since the brain runs externally
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
    const apiKey = config.get<string>('apiKey') || '';
    const hasKey = !!apiKey;
    const savedModel = config.get<string>('model') || '';
    const maxTokens = config.get<number>('maxTokens') || 4096;
    const providers = ['groq', 'gemini', 'openrouter', 'huggingface'];

    return SidebarProvider._buildHtmlBody(provider, apiKey, hasKey, savedModel, maxTokens, providers);
  }

  private _getHtml(): string {
    const config = vscode.workspace.getConfiguration('goromMoshla');
    return SidebarProvider.buildHtml(config);
  }

  private static _buildHtmlBody(provider: string, apiKey: string, hasKey: boolean, savedModel: string, maxTokens: number, providers: string[]): string {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _unused = provider; // kept for future per-provider UI tweaks

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg-base: #0f111a;
  --bg-surface: #151724;
  --bg-input: #1a1d2e;
  --bg-hover: #1f2233;
  --border-light: #282c3f;
  --border-focus: #3d4466;
  --text-main: #e2e8f0;
  --text-muted: #94a3b8;
  --text-subtle: #64748b;
  --accent-primary: #3b82f6;
  --accent-secondary: #60a5fa;
  --mono: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

html, body {
  height: 100%;
  font-family: var(--font-sans);
  font-size: 13px;
  background: var(--bg-base);
  color: var(--text-main);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* ── HEADER ──────────────────── */
#header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
  z-index: 20;
}
.logo { 
  display: flex; align-items: center; gap: 8px; 
  font-weight: 600; font-size: 13px; 
  color: var(--text-main);
}
.logo-icon {
  font-size: 14px;
  color: var(--text-muted);
}
.hdr-actions { display: flex; gap: 6px; }
.icon-btn {
  background: transparent; border: 1px solid transparent; color: var(--text-muted);
  width: 26px; height: 26px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; font-size: 14px;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text-main); }

/* ── CONFIG PANEL ────────────────────────────── */
#config-panel {
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0; overflow: hidden; transition: max-height .2s ease-out; max-height: 250px;
}
#config-panel.collapsed { max-height: 0; border-bottom-color: transparent; }
#config-inner { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.cfg-row { display: flex; align-items: center; gap: 8px; }
.cfg-lbl { font-size: 11px; color: var(--text-muted); width: 60px; flex-shrink: 0; font-weight: 500; }
select, input[type=password], input[type=search] {
  flex: 1; min-width: 0; background: var(--bg-input); color: var(--text-main);
  border: 1px solid var(--border-light); border-radius: 4px;
  padding: 6px 8px; font-size: 12px; font-family: inherit; outline: none;
  transition: border-color 0.15s;
}
select:focus, input:focus { border-color: var(--border-focus); }
select:disabled, input:disabled { opacity: .5; cursor: not-allowed; }
.save-btn {
  background: var(--bg-hover); color: var(--text-main); border: 1px solid var(--border-light); border-radius: 4px;
  padding: 6px 12px; font-size: 12px; cursor: pointer;
  transition: background 0.15s; flex-shrink: 0;
}
.save-btn:hover:not(:disabled) { background: var(--border-focus); }
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
.badge.ok { color: #10b981; background: rgba(16, 185, 129, 0.1); }
.badge.miss { color: #ef4444; background: rgba(239, 68, 68, 0.1); }
#model-search-row { display: none; }
#model-search-row.show { display: flex; }
#model-count { font-size: 11px; color: var(--text-subtle); font-variant-numeric: tabular-nums; }

/* ── STATUS BAR ──────────────────────────────── */
#statusbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; background: var(--bg-base); border-bottom: 1px solid var(--border-light);
  font-size: 11px; flex-shrink: 0; color: var(--text-muted);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-subtle); flex-shrink: 0; }
.dot.busy { background: var(--accent-primary); animation: pulse-dot 2s ease-in-out infinite; }
.dot.error { background: #ef4444; }
@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
#status-text { font-weight: 500; color: var(--text-muted); }
#model-chip { margin-left: auto; font-size: 10px; color: var(--text-muted); font-family: var(--mono); }

/* ── MAIN AREA ───────────────────────────────── */
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }

/* ── MESSAGES ────────────────────────────────── */
#messages {
  flex: 1; overflow-y: auto; padding: 16px 14px;
  display: flex; flex-direction: column; gap: 16px;
}

.msg-wrap { display: flex; flex-direction: column; }
.msg { line-height: 1.6; font-size: 13px; color: var(--text-main); word-wrap: break-word; }

/* User message: simple border */
.msg-wrap.user-wrap { align-items: flex-end; }
.msg.user {
  background: var(--bg-surface); color: var(--text-main);
  padding: 8px 12px; border-radius: 6px;
  max-width: 85%; font-weight: 400; border: 1px solid var(--border-light);
}

/* AI message */
.msg-wrap.ai-wrap { align-items: flex-start; width: 100%; }
.msg.ai { width: 100%; }
.msg.ai p { margin-bottom: 12px; }
.msg.ai p:last-child { margin-bottom: 0; }
.msg.ai h1, .msg.ai h2, .msg.ai h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; color: var(--text-main); }
.msg.ai code { background: rgba(255,255,255,0.05); color: #e2e8f0; padding: 2px 4px; border-radius: 4px; font-family: var(--mono); font-size: 12px; border: 1px solid var(--border-light); }
.msg.ai pre {
  background: #0d0e15; border: 1px solid var(--border-light); border-radius: 6px;
  padding: 12px; margin: 12px 0; overflow-x: auto; font-family: var(--mono); font-size: 12px; line-height: 1.5;
}
.msg.ai pre code { background: transparent; border: none; padding: 0; color: #e2e8f0; }
.msg.ai ul, .msg.ai ol { padding-left: 20px; margin-bottom: 12px; }
.msg.ai li { margin-bottom: 4px; }
.msg.ai a { color: var(--accent-primary); text-decoration: none; }
.msg.ai a:hover { text-decoration: underline; }
.msg.ai hr { border: none; border-top: 1px solid var(--border-light); margin: 16px 0; }

.msg.error { color: #ef4444; font-size: 12px; font-family: var(--mono); background: rgba(239, 68, 68, 0.1); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.2); width: 100%; }
.msg.system { color: var(--text-subtle); font-size: 11px; text-align: center; align-self: center; margin-bottom: 8px; font-family: var(--mono); }

/* Thinking Indicator */
.msg.thinking { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
.loader { display: flex; gap: 4px; }
.loader span { width: 4px; height: 4px; background: var(--text-muted); border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
.loader span:nth-child(2) { animation-delay: 0.2s; }
.loader span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce { 0%, 80%, 100% { transform: scale(0); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }

/* ── THOUGHT BUBBLE / THINK TIMER ── */
.think-timer-block, .ctx-explorer, .files-changed-bar, .thought-bubble, .inline-plan-block {
  margin: 8px 0; padding: 8px 12px; border-radius: 6px;
  background: transparent; border: 1px solid var(--border-light);
  font-size: 11px; font-family: var(--mono); color: var(--text-muted);
  width: 100%; transition: background .15s;
}
.think-timer-block:hover, .ctx-explorer:hover, .thought-bubble-hdr:hover { background: var(--bg-surface); cursor: pointer; }
.think-timer-hdr, .ctx-hdr, .thought-bubble-hdr { display: flex; align-items: center; gap: 6px; user-select: none; }
.think-timer-hdr .chevron, .ctx-hdr .chevron, .thought-bubble-hdr .chevron { font-size: 9px; transition: transform .2s; color: var(--text-subtle); }
.open .chevron { transform: rotate(90deg); }
.think-timer-phase { color: var(--text-muted); font-weight: 500; font-family: var(--font-sans); }
.think-timer-dur { margin-left: auto; color: var(--text-subtle); font-variant-numeric: tabular-nums; }
.think-timer-body, .ctx-body, .thought-bubble-body { display: none; padding: 8px 0 2px 16px; font-size: 11px; color: var(--text-subtle); line-height: 1.6; }
.open > .think-timer-body, .open > .ctx-body, .open .thought-bubble-body { display: block; }

/* Context Explorer specific */
.ctx-entry { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.02); }
.ctx-type { color: var(--text-muted); font-size: 9px; text-transform: uppercase; font-weight: 600; min-width: 24px; }
.ctx-name { flex: 1; color: var(--text-main); font-family: var(--font-sans); font-size: 12px; }
.ctx-detail { color: var(--text-subtle); font-size: 10px; }

/* ── INLINE PLAN BLOCK ── */
.inline-plan-hdr {
  display: none; /* Hide old boxed title */
}
.inline-plan-steps { padding: 4px 0; display: flex; flex-direction: column; gap: 8px; }
.inline-step {
  display: flex; align-items: center; gap: 8px; padding: 2px 0;
  font-size: 13px; font-family: var(--font-sans); color: var(--text-muted);
  border: none; background: transparent; transition: color 0.2s;
}
.inline-step .step-icon { font-size: 14px; display: flex; align-items: center; justify-content: center; width: 16px; }
.inline-step.running { color: var(--text-main); }
.inline-step.done { color: var(--text-main); }
.inline-step.error { color: #ef4444; }

/* ── FILES CHANGED ── */
.files-changed-bar { display: flex; align-items: center; gap: 8px; font-family: var(--font-sans); padding: 10px 12px; }
.fc-icon { font-size: 14px; }
.fc-count { color: var(--text-main); font-weight: 500; font-size: 12px; }
.fc-btn {
  margin-left: auto; background: var(--bg-hover); border: 1px solid var(--border-light);
  color: var(--text-main); padding: 4px 10px; border-radius: 4px; font-size: 11px;
  cursor: pointer; font-family: var(--font-sans); transition: background .15s;
}
.fc-btn:hover { background: var(--border-light); }

/* ── PERMISSION CARD ── */
.permission-card {
  display: flex; flex-direction: column; gap: 10px;
  margin-top: 12px; padding: 14px 16px;
  background: var(--bg-base);
  border: 1px solid var(--border-light);
  border-left: 3px solid var(--accent-primary);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  animation: slideIn 0.2s ease-out forwards;
}
.perm-hdr { font-family: var(--font-sans); font-size: 13px; font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 8px; }
.perm-icon { color: var(--accent-primary); display: flex; align-items: center; justify-content: center; }
.perm-text { font-family: var(--mono); font-size: 11px; color: var(--text-subtle); margin-left: 22px; margin-top: -6px; }
.perm-actions { display: flex; gap: 8px; margin-top: 4px; }
.btn-allow, .btn-deny, .btn-revise {
  flex: 1; padding: 8px 12px; font-size: 12px; font-family: var(--font-sans); font-weight: 600;
  border-radius: 6px; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 6px;
}
.btn-allow { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
.btn-allow:hover { background: #10b981; color: #fff; box-shadow: 0 0 10px rgba(16, 185, 129, 0.4); border-color: #10b981; }
.btn-revise { background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); }
.btn-revise:hover { background: rgba(59, 130, 246, 0.2); border-color: rgba(59, 130, 246, 0.5); }
.btn-deny { background: rgba(239, 68, 68, 0.05); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); }
.btn-deny:hover { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); }
@keyframes slideIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

/* ── EMPTY STATE ─────────────────────────────── */
#empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; padding: 0 20px; text-align: center; font-family: var(--font-sans);
}
.es-logo { font-size: 32px; margin-bottom: 12px; }
.es-title { font-size: 24px; font-weight: 700; color: var(--text-main); margin: 0 0 8px; }
.es-subtitle { font-size: 13px; color: var(--text-muted); margin: 0 0 32px; }
.es-cards { display: flex; gap: 16px; width: 100%; max-width: 500px; justify-content: center; }
.es-card {
  flex: 1; text-align: left; background: var(--bg-surface);
  border: 1px solid var(--border-light); border-radius: 8px;
  padding: 16px; cursor: pointer; transition: all 0.2s ease;
  display: flex; flex-direction: column; gap: 8px;
}
.es-card:hover { border-color: var(--border-focus); background: var(--bg-hover); }
.es-card.active { border-color: var(--accent-primary); box-shadow: 0 0 0 1px var(--accent-primary); background: rgba(59, 130, 246, 0.05); }
.es-card-hdr { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--text-main); }
.es-card-desc { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
.es-card-ul { padding-left: 16px; margin: 0; font-size: 11px; color: var(--text-subtle); line-height: 1.5; }
.es-card-ul li { margin-bottom: 4px; }

/* ── INPUT ───────────────────────────────────── */
#input-area {
  padding: 12px 14px;
  background: var(--bg-base);
  border-top: 1px solid var(--border-light);
  flex-shrink: 0; z-index: 20; position: relative;
}
#input-box {
  display: flex; gap: 8px; align-items: flex-end;
  background: var(--bg-input);
  border: 1px solid var(--border-light);
  border-radius: 6px; padding: 8px 8px 8px 12px; transition: border-color 0.15s;
}
#input-box:focus-within { border-color: var(--border-focus); }
#inp {
  flex: 1; background: transparent; color: var(--text-main); border: none;
  padding: 4px 0; font-size: 13px; font-family: inherit;
  outline: none; resize: none; min-height: 20px; max-height: 200px; line-height: 1.5;
}
#inp::placeholder { color: var(--text-subtle); }
#attach-btn {
  background: transparent; color: var(--text-subtle); border: none;
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 14px; border-radius: 4px; transition: color 0.15s, background 0.15s; flex-shrink: 0;
}
#attach-btn:hover { background: var(--bg-hover); color: var(--text-main); }
#attachments-preview {
  display: flex; gap: 8px; padding: 4px 8px; flex-wrap: wrap;
  max-height: 100px; overflow-y: auto;
}
.att-prev {
  position: relative; width: 44px; height: 44px; border-radius: 4px; overflow: hidden;
  border: 1px solid var(--border-light); background: var(--bg-surface);
  display: flex; align-items: center; justify-content: center; flex-direction: column;
}
.att-prev img { width: 100%; height: 100%; object-fit: cover; }
.att-rm {
  position: absolute; top: 0; right: 0; background: rgba(0,0,0,0.6); color: #fff;
  width: 14px; height: 14px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; border-radius: 0 0 0 4px; font-size: 10px; font-weight: bold;
}
.att-rm:hover { background: #ef4444; }

#send-btn {
  background: var(--bg-hover); color: var(--text-muted); border: 1px solid var(--border-light);
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 14px; border-radius: 4px; transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
}
#send-btn:hover:not(:disabled) { background: var(--border-focus); color: var(--text-main); }
#send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
#stop-btn {
  background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);
  width: 28px; height: 28px; align-items: center; justify-content: center;
  cursor: pointer; font-size: 14px; border-radius: 4px; transition: all 0.15s;
  flex-shrink: 0; display: none;
}
#stop-btn:hover { background: #ef4444; color: #ffffff; }
#hint { font-size: 10px; color: var(--text-subtle); margin-top: 8px; text-align: center; }

/* ── SCROLLBAR ───────────────────────────────── */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-light); border: 3px solid var(--bg-base); border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-focus); }
</style>
</head>
<body>
<div id="app">

  <!-- HEADER -->
  <div id="header">
    <div class="logo">
      <span class="logo-icon">✨</span>
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
        <div style="position: relative; flex: 1; display: flex;">
          <input type="password" id="key-inp" value="${apiKey}" placeholder="${hasKey ? '•••••••• (key saved)' : 'Paste API key here…'}" style="flex: 1; padding-right: 28px;" />
          <button id="toggle-key-btn" title="Toggle visibility" style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-subtle); cursor: pointer; padding: 4px; font-size: 14px; display: flex; align-items: center; justify-content: center;">👁</button>
        </div>
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
      <div class="cfg-row">
        <span class="cfg-lbl" title="Max Tokens">Max T.</span>
        <input type="number" id="max-tokens-inp" value="${maxTokens}" style="flex: 1;" />
        <button class="save-btn" id="max-tokens-save">Save</button>
        <span class="badge" id="max-tokens-badge" style="display:none; color:#10b981;">✓</span>
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
    <!-- EMPTY STATE -->
    <div id="empty-state">
      <div class="es-logo">✨</div>
      <h1 class="es-title">Let's build</h1>
      <p class="es-subtitle">Plan, search, or build anything</p>
      
      <div class="es-cards">
        <div class="es-card active" id="card-vibe" data-mode="vibe">
          <div class="es-card-hdr">💬 Vibe</div>
          <div class="es-card-desc">Chat first, then build. Explore ideas and iterate as you discover needs.</div>
          <div class="es-card-desc" style="margin-top:8px;">Great for:</div>
          <ul class="es-card-ul">
            <li>Rapid exploration and testing</li>
            <li>Building when requirements are unclear</li>
            <li>Implementing a simple task</li>
          </ul>
        </div>
        <div class="es-card" id="card-spec" data-mode="spec">
          <div class="es-card-hdr">📄 Spec</div>
          <div class="es-card-desc">Plan first, then build. Create requirements and design before coding starts.</div>
          <div class="es-card-desc" style="margin-top:8px;">Great for:</div>
          <ul class="es-card-ul">
            <li>Complex architectural changes</li>
            <li>Building when you know what you want</li>
            <li>Reducing AI mistakes</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- MESSAGES -->
    <div id="messages" style="display:none;">
      ${!hasKey ? '<div class="msg error">⚠ API Key not set. Click ⚙ to configure.</div>' : ''}
    </div>

  </div>

  <!-- INPUT -->
  <div id="input-area">
    <div id="attachments-preview"></div>
    <div id="input-box">
      <button id="attach-btn" title="Attach file">📎</button>
      <input type="file" id="file-upload" multiple style="display:none">
      <textarea id="inp" rows="1" placeholder="Ask me to build, edit, debug, or explain anything…"></textarea>
      <button id="send-btn" title="Send (Enter)">↑</button>
      <button id="stop-btn" title="Stop generation" style="display:none">⏹</button>
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
  var stopBtn    = document.getElementById('stop-btn');
  var provSel    = document.getElementById('prov-sel');
  var keyInp     = document.getElementById('key-inp');
  var toggleKeyBtn = document.getElementById('toggle-key-btn');
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

  // ── Toggle API Key ────────────────────────────────────────────────
  if (toggleKeyBtn) {
    toggleKeyBtn.addEventListener('click', function(){
      if (keyInp.type === 'password') {
        keyInp.type = 'text';
        toggleKeyBtn.textContent = '🙈';
      } else {
        keyInp.type = 'password';
        toggleKeyBtn.textContent = '👁';
      }
    });
  }

  // ── Max Tokens ────────────────────────────────────────────────────
  var maxTokensInp = document.getElementById('max-tokens-inp');
  var maxTokensSave = document.getElementById('max-tokens-save');
  var maxTokensBadge = document.getElementById('max-tokens-badge');
  if (maxTokensSave && maxTokensInp && maxTokensBadge) {
    maxTokensSave.addEventListener('click', function() {
      vsc.postMessage({ type: 'setMaxTokens', value: parseInt(maxTokensInp.value, 10) || 4096 });
      maxTokensBadge.style.display = 'inline-block';
      setTimeout(function(){ maxTokensBadge.style.display = 'none'; }, 2000);
    });
  }

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
    sendBtn.style.display = b ? 'none' : 'flex';
    stopBtn.style.display = b ? 'flex' : 'none';
    dot.className = 'dot' + (b?' busy':'');
    statusText.textContent = b ? 'Working…' : 'Ready';
  }

  // ── Task panel helpers ────────────────────────────────────────────
  var stepEls = [];
  var currentPermCard = null;
  function formatStepLabel(tool, desc) {
    if (tool === 'editFile' || tool === 'createFile' || tool === 'multiReplace') {
       var match = desc.match(/[\\w.-]+\\.\\w+/);
       var name = match ? match[0] : desc;
       var ext = name.split('.').pop().toUpperCase();
       if(ext.length > 4) ext = ext.substring(0,2);
       return 'Edited <span style="color:var(--accent-primary);font-size:11px;font-weight:bold">' + ext + '</span> <b>' + name + '</b>';
    }
    if (tool === 'readFile' || tool === 'viewFile') {
       var match = desc.match(/[\\w.-]+\\.\\w+/);
       var name = match ? match[0] : desc;
       return 'Explored file <b>' + name + '</b>';
    }
    if (tool === 'grepSearch' || tool === 'searchFiles') return 'Searched for <b>' + desc + '</b>';
    if (tool === 'listDir') return 'Explored folder <b>' + desc + '</b>';
    if (tool === 'runTerminal' || tool === 'runCommand') return 'Ran <code>' + desc + '</code>';
    return desc;
  }

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
      var labelHtml = formatStepLabel(s.tool, s.description || s.tool);
      el.innerHTML =
        '<span class="step-icon"></span>' +
        '<span class="step-label">'+labelHtml+'</span>';
      stepsWrap.appendChild(el);
      stepEls.push(el);
    });
    
    currentPermCard = document.createElement('div');
    currentPermCard.className = 'permission-card';
    currentPermCard.innerHTML = 
      '<div class="perm-hdr"><span class="perm-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg></span> Allow running this plan?</div>' +
      '<div class="perm-text">' + steps.length + ' tool calls proposed</div>' +
      '<div class="perm-actions">' +
        '<button class="btn-allow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Approve</button>' +
        '<button class="btn-revise"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg> Feedback</button>' +
        '<button class="btn-deny"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Reject</button>' +
      '</div>';
      
    currentPermCard.querySelector('.btn-allow').addEventListener('click', function(){
      vsc.postMessage({ type: 'approvePlan' });
      currentPermCard.style.display = 'none';
      statusText.textContent = 'Executing…';
    });
    currentPermCard.querySelector('.btn-revise').addEventListener('click', function(){
      vsc.postMessage({ type: 'rejectPlan' });
      currentPermCard.style.display = 'none';
      var chatInp = document.getElementById('inp');
      if(chatInp) {
        chatInp.focus();
        chatInp.value = "Please revise the plan: ";
      }
    });
    currentPermCard.querySelector('.btn-deny').addEventListener('click', function(){
      vsc.postMessage({ type: 'rejectPlan' });
      currentPermCard.style.display = 'none';
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
    
    var iconHtml = '';
    if (status === 'running') {
      iconHtml = '<span class="loader" style="margin-right:4px"><span></span><span></span><span></span></span>';
    } else if (status === 'done') {
      iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (status === 'error') {
      iconHtml = '<span style="color:#ef4444">✗</span>';
    }
    el.querySelector('.step-icon').innerHTML = iconHtml;
    
    // We don't append full msg/result to keep it clean, unless it's an error
    if (msg && status === 'error') el.querySelector('.step-label').textContent += ' — ' + msg;
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
  
  var keySave    = document.getElementById('key-save');
  var keyBadge   = document.getElementById('key-badge');
  var emptyState = document.getElementById('empty-state');
  
  // Chat Mode
  var currentChatMode = 'vibe';
  var cardVibe = document.getElementById('card-vibe');
  var cardSpec = document.getElementById('card-spec');
  cardVibe.addEventListener('click', function() {
    currentChatMode = 'vibe';
    cardVibe.classList.add('active');
    cardSpec.classList.remove('active');
  });
  cardSpec.addEventListener('click', function() {
    currentChatMode = 'spec';
    cardSpec.classList.add('active');
    cardVibe.classList.remove('active');
  });
  
  // Attachments
  var attachBtn = document.getElementById('attach-btn');
  var fileUpload = document.getElementById('file-upload');
  var attPreview = document.getElementById('attachments-preview');
  var pendingAttachments = [];

  attachBtn.addEventListener('click', function(){ fileUpload.click(); });
  
  fileUpload.addEventListener('change', function(){
    for(var i=0; i<this.files.length; i++) {
      var f = this.files[i];
      var isImg = f.type.startsWith('image/');
      var reader = new FileReader();
      reader.onload = (function(file, img){
        return function(e){
          var data = e.target.result;
          pendingAttachments.push({ type: img ? 'image' : 'text', data: data, name: file.name });
          renderAttachments();
        };
      })(f, isImg);
      if(isImg) reader.readAsDataURL(f);
      else reader.readAsText(f);
    }
    this.value = '';
  });

  function renderAttachments(){
    attPreview.innerHTML = '';
    pendingAttachments.forEach(function(a, i){
      var el = document.createElement('div');
      el.className = 'att-prev';
      if(a.type === 'image') {
        el.innerHTML = '<img src="'+a.data+'">';
      } else {
        el.innerHTML = '<div style="font-size:16px">📄</div><div style="font-size:8px;text-align:center;position:absolute;bottom:0;background:rgba(0,0,0,0.5);color:#fff;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 2px;">'+escHtml(a.name)+'</div>';
      }
      var rm = document.createElement('div');
      rm.className = 'att-rm';
      rm.textContent = '×';
      rm.onclick = function(){ pendingAttachments.splice(i, 1); renderAttachments(); };
      el.appendChild(rm);
      attPreview.appendChild(el);
    });
  }

  // Set height for textarea to auto-grow
  inp.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
  });

  // Handle send message
  function sendMessage() {
    if(busy) return;
    var val = inp.value.trim();
    if (!val && pendingAttachments.length === 0) return;
    
    // Hide empty state on first message
    if (emptyState.style.display !== 'none') {
      emptyState.style.display = 'none';
      messages.style.display = 'flex';
    }

    // Add user msg to UI
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap user-wrap';
    var el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = val;
    
    if (pendingAttachments.length > 0) {
      var attDiv = document.createElement('div');
      attDiv.style.display = 'flex';
      attDiv.style.gap = '8px';
      attDiv.style.marginBottom = '4px';
      attDiv.style.flexWrap = 'wrap';
      pendingAttachments.forEach(function(a) {
        if(a.type === 'image') {
          attDiv.innerHTML += '<img src="'+a.data+'" style="width:40px;height:40px;object-fit:cover;border-radius:4px">';
        } else {
          attDiv.innerHTML += '<div style="width:40px;height:40px;border-radius:4px;background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;font-size:10px;text-align:center;overflow:hidden;text-overflow:ellipsis;flex-direction:column"><span style="font-size:14px">📄</span><span>'+escHtml(a.name.substring(0,6))+'</span></div>';
        }
      });
      el.insertBefore(attDiv, el.firstChild);
    }
    
    wrap.appendChild(el);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;

    var att = pendingAttachments.slice();
    pendingAttachments = [];
    renderAttachments();

    // Reset input
    inp.value = '';
    inp.style.height = 'auto';

    vsc.postMessage({ type: 'submit', text: val, attachments: att, mode: currentChatMode });
    setBusy(true);
    aiDiv = null;
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
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} });
  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', function() { vsc.postMessage({ type: 'stop' }); });
  document.getElementById('clear-btn').addEventListener('click', function(){
    messages.innerHTML = '';
    var hasKey = keyInp.value.trim() !== '';
    if(!hasKey) messages.innerHTML = '<div class="msg error">⚠ API Key not set. Click ⚙ to configure.</div>';
    
    emptyState.style.display = 'flex';
    messages.style.display = 'none';
    currentChatMode = 'vibe';
    cardVibe.classList.add('active');
    cardSpec.classList.remove('active');

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

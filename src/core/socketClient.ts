import * as vscode from 'vscode';
import WebSocket from 'ws';

export class SocketClient {
  private ws: WebSocket | null = null;
  private url = 'ws://localhost:7777';
  private outputChannel: vscode.OutputChannel;
  private onMessageCallback: ((message: any) => void) | null = null;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Gorom Moshla AI');
  }

  public connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.outputChannel.appendLine(`Connecting to runtime at ${this.url}...`);
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.outputChannel.appendLine('✅ Connected to Gorom Moshla Runtime.');
      vscode.window.showInformationMessage('Gorom Moshla Runtime Connected!');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.outputChannel.appendLine(`[${msg.type.toUpperCase()}] ${JSON.stringify(msg.data)}`);
        
        if (this.onMessageCallback) {
          this.onMessageCallback(msg);
        }
      } catch (e) {
        this.outputChannel.appendLine(`Raw Message: ${data}`);
      }
    });

    this.ws.on('error', (err) => {
      this.outputChannel.appendLine(`❌ Socket Error: ${err.message}`);
    });

    this.ws.on('close', () => {
      this.outputChannel.appendLine('Socket disconnected. Retrying in 5 seconds...');
      setTimeout(() => this.connect(), 5000);
    });
  }

  public onMessage(callback: (msg: any) => void) {
    this.onMessageCallback = callback;
  }

  public sendTask(task: string, workspaceRoot: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'start_task', task, workspaceRoot }));
      this.outputChannel.appendLine(`>>> Sent Task: ${task}`);
    } else {
      vscode.window.showErrorMessage('Agent Runtime is not connected.');
    }
  }
}

export const socketClient = new SocketClient();


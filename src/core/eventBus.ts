import * as vscode from 'vscode';

// Define the payload types for different events
export interface EventPayloads {
  onUserInput: { input: string };
  onContextBuilt: { budgetUsed: number; layers: string[] };
  onAIResponse: { rawOutput: string };
  onAIStreamChunk: { chunk: string };
  onValidationFail: { reason: string; step?: any };
  onToolExecuted: { tool: string; result: any };
  onFileChanged: { path: string };
  onStatePhaseChange: { oldPhase: string; newPhase: string };
  onUserConfirmation: { accepted: boolean };
  onPlanReady: { title: string; steps: Array<{ index: number; tool: string; description: string; status: string }> };
  onStepUpdate: { index: number; status: 'running' | 'done' | 'error'; message?: string; result?: string; elapsed?: number };
  onWaitingForApproval: Record<string, never>;
  onPlanRejected: Record<string, never>;
  // ── New Cursor-style events ──
  onThinkingPhase: { phase: string; detail?: string };
  onContextExploring: { files: number; folders: number; entries: Array<{ type: string; name: string; detail?: string }> };
  onFilesChanged: { files: Array<{ path: string; action: 'created' | 'modified' }> };
  onThoughts: { thoughts: string };
}

type EventCallback<T> = (payload: T) => void;

/**
 * EventBus is strictly for logging and notification ONLY.
 * It DOES NOT control flow.
 */
export class EventBus {
  private listeners: { [K in keyof EventPayloads]?: EventCallback<EventPayloads[K]>[] } = {};

  on<K extends keyof EventPayloads>(event: K, callback: EventCallback<EventPayloads[K]>): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(callback);
  }

  emit<K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]): void {
    const eventListeners = this.listeners[event];
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          callback(payload);
        } catch (err) {
          console.error(`[EventBus] Error in listener for ${event}:`, err);
        }
      });
    }
  }
}

export const globalEventBus = new EventBus();

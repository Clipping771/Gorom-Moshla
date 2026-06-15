import * as vscode from 'vscode';
import { globalEventBus } from '../core/eventBus';

export class ConfirmationBridge {
  /**
   * Prompts the user with a modal to accept or reject the changes currently shown in the diff viewer.
   * Returns true if accepted, false if rejected.
   */
  public static async waitForUserConfirmation(message: string): Promise<boolean> {
    const selection = await vscode.window.showInformationMessage(
      message,
      { modal: true },
      'Accept Changes',
      'Reject'
    );
    
    const accepted = selection === 'Accept Changes';
    
    // Log the user's decision
    globalEventBus.emit('onUserConfirmation', { accepted });

    return accepted;
  }
}

import * as fs from 'fs';
import { RollbackAction } from './state';
import { Tracer } from './tracer';

export class RollbackSystem {
  constructor(private tracer: Tracer) {}

  /**
   * Captures the state of a file before a write operation.
   */
  public snapshotFile(filePath: string): RollbackAction | null {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.tracer.logStep({ type: 'ROLLBACK_SNAPSHOT', filePath });
      return { filePath, previousContent: content };
    }
    return null;
  }

  /**
   * Restores a single file to its previous state.
   */
  public restoreFile(action: RollbackAction) {
    fs.writeFileSync(action.filePath, action.previousContent, 'utf-8');
    this.tracer.logStep({ type: 'ROLLBACK_RESTORE', filePath: action.filePath });
  }

  /**
   * Restores an entire stack of rollback actions.
   */
  public restoreStack(stack: RollbackAction[]) {
    // Reverse the stack to undo the most recent actions first
    const reversedStack = [...stack].reverse();
    for (const action of reversedStack) {
      this.restoreFile(action);
    }
  }
}

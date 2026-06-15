export type Phase =
  | 'IDLE'
  | 'COLLECTING_CONTEXT'
  | 'PLANNING'
  | 'WAITING_FOR_APPROVAL'
  | 'VALIDATING'
  | 'EXECUTING'
  | 'APPLYING'
  | 'DONE'
  | 'ERROR';

export interface AIPlanStep {
  tool: string;
  args: Record<string, any>;
}

export interface AIPlan {
  intent: 'edit' | 'create' | 'explain' | 'debug' | 'refactor' | 'plan';
  title?: string;
  steps: AIPlanStep[];
  final_response: string;
  plan_details?: string;
}

export interface ExecutionQueueItem {
  step: AIPlanStep;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
}

export interface RollbackAction {
  filePath: string;
  previousContent: string;
}

export interface GlobalState {
  phase: Phase;
  mergedContext: string;
  plan: AIPlan | null;
  executionQueue: ExecutionQueueItem[];
  rollbackStack: RollbackAction[];
  lastError: string | null;
}

export function createInitialState(): GlobalState {
  return {
    phase: 'IDLE',
    mergedContext: '',
    plan: null,
    executionQueue: [],
    rollbackStack: [],
    lastError: null
  };
}

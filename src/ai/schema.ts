import { z } from 'zod';

export const CreateFileArgsSchema = z.object({
  path: z.string(),
  content: z.string()
});

export const EditFileArgsSchema = z.object({
  path: z.string(),
  content: z.string()
});

export const RunTerminalArgsSchema = z.object({
  command: z.string()
});

export const ReadFileArgsSchema = z.object({
  path: z.string()
});

export const ListDirArgsSchema = z.object({
  path: z.string()
});

export const GrepSearchArgsSchema = z.object({
  query: z.string()
});

export const ToolStepSchema = z.union([
  z.object({ tool: z.literal('createFile'), description: z.string().optional(), args: CreateFileArgsSchema }),
  z.object({ tool: z.literal('editFile'), description: z.string().optional(), args: EditFileArgsSchema }),
  z.object({ tool: z.literal('runTerminal'), description: z.string().optional(), args: RunTerminalArgsSchema }),
  z.object({ tool: z.literal('readFile'), description: z.string().optional(), args: ReadFileArgsSchema }),
  z.object({ tool: z.literal('listDir'), description: z.string().optional(), args: ListDirArgsSchema }),
  z.object({ tool: z.literal('grepSearch'), description: z.string().optional(), args: GrepSearchArgsSchema }),
]);

export const AIResponseSchema = z.object({
  intent: z.enum(['edit', 'create', 'explain', 'debug', 'refactor', 'plan']),
  title: z.string().optional(),
  thoughts: z.string().optional(),
  steps: z.array(ToolStepSchema).max(20),
  final_response: z.string(),
  plan_details: z.string().optional()
});

export type ValidatedAIResponse = z.infer<typeof AIResponseSchema>;
export type ToolStep = z.infer<typeof ToolStepSchema>;

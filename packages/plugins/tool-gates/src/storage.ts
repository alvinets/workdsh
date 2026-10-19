import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

export const toolGatesSettingsSchema = z.object({
  computerUse: z.boolean(),
  browserTools: z.boolean(),
  updatedAt: z.string().min(1),
});

export type ToolGatesSettings = z.infer<typeof toolGatesSettingsSchema>;

export const toolGatesDomainSpec = defineDomain({
  name: 'workdsh_tool_gates', version: 1, layout: 'per-record',
  global: { schema: z.object({}), initial: {} },
  tables: { settings: domainTable<string, ToolGatesSettings>(toolGatesSettingsSchema) },
});

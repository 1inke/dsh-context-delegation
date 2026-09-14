import type { Context } from '@deepseek-ai/cordis';
import type { DelegationExecution } from '../types.ts';
import type { DelegationExecutor, ExecutorRequest, ExecutorResult } from './types.ts';
export type { DelegationExecutor, ExecutorRequest, ExecutorResult } from './types.ts';
export declare class SubagentExecutor implements DelegationExecutor {
    private readonly ctx;
    private readonly provider;
    private readonly model?;
    constructor(ctx: Context, provider: string, model?: string | undefined);
    get id(): string;
    available(): boolean;
    execute(request: ExecutorRequest, execution: DelegationExecution): Promise<ExecutorResult>;
}
//# sourceMappingURL=subagent.d.ts.map
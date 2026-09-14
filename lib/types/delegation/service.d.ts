import { Context, Service } from '@deepseek-ai/cordis';
import { DelegationSessionRegistry } from './session.ts';
import type { DelegationInput, DelegationResult, ContextDelegationConfig, ContextDelegationServiceDescription, ContextLoadResult, ContextPreview, DelegationExecution, ResolvedContextDelegationConfig } from '../types.ts';
export declare class ContextDelegationService extends Service {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<ContextDelegationConfig>;
    readonly config: ResolvedContextDelegationConfig;
    private readonly transport;
    private readonly sessionRegistry;
    constructor(ctx: Context, config?: ContextDelegationConfig);
    getSessionRegistry(): DelegationSessionRegistry;
    /** Report only deployment metadata safe for a model-visible loading probe. */
    describe(): ContextDelegationServiceDescription;
    /**
     * Prepare context bundle and validate relevant_files for a delegation request.
     * S2-5 Host service integration method; reserved for Block 3 handoff pipeline.
     */
    prepareContext(input: DelegationInput, execution: DelegationExecution): Promise<ContextLoadResult>;
    /** Read-only preview shares the exact preparation path used by delegate(). */
    preview(input: DelegationInput, execution: DelegationExecution): Promise<ContextPreview>;
    /** Execute one foreground delegation and return only after the child is quiescent. */
    delegate(input: DelegationInput, execution: DelegationExecution): Promise<DelegationResult>;
    /** Run the reviewer as a FRESH one-shot child on the routed reviewer executor. */
    private startReviewer;
    /** One unreviewed fresh delegation attempt through the routed executor. */
    private runFreshAttempt;
    private delegateContinuation;
}
//# sourceMappingURL=service.d.ts.map
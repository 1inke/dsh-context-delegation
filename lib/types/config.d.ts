import type Schema from '@deepseek-ai/schemastery';
import type { ContextDelegationConfig, ResolvedContextDelegationConfig } from './types.ts';
/** Operational ceiling that keeps caller-controlled configuration memory-safe. */
export declare const MAX_CONTEXT_CHARS_HARD_LIMIT = 1000000;
export declare const DEFAULT_CONTEXT_DELEGATION_CONFIG: ResolvedContextDelegationConfig;
export declare const Config: Schema<ContextDelegationConfig>;
/** Apply defaults and reject ambiguous or unsafe deployment configuration. */
export declare function resolveConfig(config?: ContextDelegationConfig): ResolvedContextDelegationConfig;
//# sourceMappingURL=config.d.ts.map
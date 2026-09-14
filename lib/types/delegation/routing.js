/**
 * Deterministic, operator-owned executor routing (roadmap 5.5). V0.5 has no
 * automatic inference: the routing document is configuration, and model
 * input can neither read nor override it.
 */
const DEFAULT_IMPLEMENTATION_PROVIDER = 'codex';
export function resolveExecutorRouting(config) {
    const raw = config.executorRouting ?? {};
    const rawImplementation = raw.implementation ?? {};
    const rawReviewer = raw.reviewer ?? {};
    const implementationProvider = rawImplementation.provider
        ?? config.providerName
        ?? DEFAULT_IMPLEMENTATION_PROVIDER;
    const reviewerProvider = rawReviewer.provider
        ?? config.reviewProviderName
        ?? implementationProvider;
    return {
        implementation: {
            provider: implementationProvider,
            ...(rawImplementation.model === undefined ? {} : { model: rawImplementation.model }),
        },
        reviewer: {
            provider: reviewerProvider,
            ...(rawReviewer.model === undefined ? {} : { model: rawReviewer.model }),
        },
    };
}
//# sourceMappingURL=routing.js.map
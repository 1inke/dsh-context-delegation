import type { DelegationResult } from '../types.ts';
export declare const CODEX_EXPERT_RESULT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly success: {
            readonly type: "boolean";
            readonly const: true;
            readonly required: true;
        };
        readonly provider: {
            readonly type: "string";
            readonly required: true;
        };
        readonly workspaceRoot: {
            readonly type: "string";
            readonly required: true;
        };
        readonly contextFilesLoaded: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly required: true;
        };
        readonly contextFilesMissing: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly required: true;
        };
        readonly contextFilesTruncated: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly required: true;
        };
        readonly contextChars: {
            readonly type: "number";
            readonly required: true;
        };
        readonly runId: {
            readonly type: "string";
            readonly required: true;
        };
        readonly codexFinal: {
            readonly type: "string";
            readonly required: true;
        };
        readonly parentVerificationRequired: {
            readonly type: "boolean";
            readonly const: true;
            readonly required: true;
        };
        readonly contextWarning: {
            readonly type: "string";
        };
        readonly diagnostic: {
            readonly type: "string";
        };
        readonly continuation: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly reused: {
                    readonly type: "boolean";
                    readonly required: true;
                };
                readonly delegationKey: {
                    readonly type: "string";
                    readonly required: true;
                };
                readonly contextMode: {
                    readonly type: "string";
                    readonly enum: readonly ["full", "delta", "full-refresh"];
                    readonly required: true;
                };
                readonly revision: {
                    readonly type: "string";
                    readonly required: true;
                };
                readonly baseRevision: {
                    readonly type: "string";
                };
                readonly refreshReason: {
                    readonly type: "string";
                };
                readonly handoffBytes: {
                    readonly type: "number";
                    readonly required: true;
                };
            };
        };
        readonly review: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly outcome: {
                    readonly type: "string";
                    readonly enum: readonly ["completed", "rework", "blocked"];
                    readonly required: true;
                };
                readonly rounds: {
                    readonly type: "number";
                    readonly required: true;
                };
                readonly executorAttempts: {
                    readonly type: "number";
                    readonly required: true;
                };
                readonly finalExecutorReport: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly status: {
                            readonly type: "string";
                            readonly enum: readonly ["completed", "blocked", "failed"];
                            readonly required: true;
                        };
                        readonly summary: {
                            readonly type: "string";
                            readonly required: true;
                        };
                        readonly filesChanged: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                            readonly required: true;
                        };
                        readonly verification: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "object";
                                readonly additionalProperties: false;
                                readonly properties: {
                                    readonly command: {
                                        readonly type: "string";
                                        readonly required: true;
                                    };
                                    readonly outcome: {
                                        readonly type: "string";
                                        readonly enum: readonly ["passed", "failed", "not-run"];
                                        readonly required: true;
                                    };
                                    readonly evidence: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly required: true;
                        };
                        readonly risks: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                            readonly required: true;
                        };
                        readonly trustNotes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                    };
                    readonly required: true;
                };
                readonly workspaceEvidence: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly available: {
                            readonly type: "boolean";
                            readonly required: true;
                        };
                        readonly reason: {
                            readonly type: "string";
                        };
                        readonly filesChanged: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                            readonly required: true;
                        };
                        readonly diffSummary: {
                            readonly type: "string";
                        };
                    };
                    readonly required: true;
                };
                readonly verification: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly command: {
                                readonly type: "string";
                                readonly required: true;
                            };
                            readonly outcome: {
                                readonly type: "string";
                                readonly enum: readonly ["passed", "failed", "not-run"];
                                readonly required: true;
                            };
                            readonly exitCode: {
                                readonly type: "number";
                            };
                            readonly timedOut: {
                                readonly type: "boolean";
                                readonly required: true;
                            };
                            readonly evidence: {
                                readonly type: "string";
                                readonly required: true;
                            };
                        };
                    };
                    readonly required: true;
                };
                readonly reviews: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "object";
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly verdict: {
                                readonly type: "string";
                                readonly enum: readonly ["pass", "rework", "blocked"];
                                readonly required: true;
                            };
                            readonly reasons: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                                readonly required: true;
                            };
                            readonly unmetCriteria: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                                readonly required: true;
                            };
                            readonly suspiciousClaims: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                                readonly required: true;
                            };
                            readonly recommendedNextAction: {
                                readonly type: "string";
                            };
                            readonly trustNotes: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                    readonly required: true;
                };
                readonly reworkLimitReached: {
                    readonly type: "boolean";
                };
            };
        };
    };
};
/** Concise model-facing rendering of a canonical successful delegation. */
export declare function renderCodexExpertResult(value: DelegationResult): string;
//# sourceMappingURL=result.d.ts.map
# Synthetic Decisions

## AV2 Sampling

The task-relevant AV2 sampling behavior is implemented in `src/av2/sampling.ts`. Sampling should preserve the requested non-uniform distribution while keeping its output deterministic for a fixed seed.

## Non-uniform Sampling

Non-uniform Sampling is the AV2 behavior under active investigation. Prefer the weighted bucket path and verify that sparse buckets remain represented. This section is synthetic fixture content.

## Packaging

The synthetic package is assembled as an ESM bundle with a generated type declaration. The release artifact includes declarations and source maps.

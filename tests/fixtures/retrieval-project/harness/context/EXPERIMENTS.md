# Synthetic Experiment Evidence

## AV2 Sampling Evidence

The synthetic AV2 experiment exercises `src/av2/sampling.ts` with a fixed seed and compares uniform sampling against Non-uniform Sampling. The expected fixture outcome is stable weighted-bucket coverage.

## SDD Static Obstacles Experiment

The synthetic obstacle experiment measures collision checks on a static grid. The expected fixture outcome is no intersecting tiles.

## Packaging Experiment

The synthetic packaging experiment compares bundle sizes after declaration emission. The expected fixture outcome is a smaller bundle.

## Cache Eviction Experiment

The synthetic cache experiment removes least-recently-used entries after a memory threshold. The expected fixture outcome is bounded cache occupancy.

## Font Rendering Experiment

The synthetic font experiment checks glyph alignment at two display densities.

## Audio Compression Experiment

The synthetic audio experiment compares frame sizes for two codecs.

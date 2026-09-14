# Synthetic Project Architecture

This fixture models a small harness with a TypeScript source tree. The architecture has a context loader, a retrieval index, and an `src/av2/sampling.ts` module for synthetic AV2 sampling behavior.

## SDD Static Obstacles

The synthetic SDD renderer uses fixed obstacle tiles and a deterministic collision map. The map uses square tiles in integer coordinates.

## Web Typography

The synthetic web shell uses a sans-serif fallback stack, a 16px body size, and a compact navigation line height.

## Authentication

The synthetic login flow accepts a test-only user name and returns a short-lived in-memory session. No real credentials are present here.

## Image Compression

The synthetic image utility stores thumbnails in a compact raster format.

## Localization

The synthetic interface translates menu labels using a static dictionary.

## Database Migration

The synthetic database migration adds an index for archived document dates.

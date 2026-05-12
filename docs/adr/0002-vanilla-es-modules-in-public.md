# ADR 0002 — Ship the PWA as vanilla ES modules from `public/`

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** Full-stack thread
**Phase:** 0 (Bootstrap)

## Context

The GLM frontend covers ~10 views (Dashboard, Sekkei Browser, Change Management, Variant Resolution, Where-Used, Effectivity, Drift, Reuse, Provenance, Vibe Mode) plus a small library of shared UI primitives (status pill, stratum tag, hash, section, kv, diff block, yaml block). The existing `mockup/` directory implements all of these as a single-file React-via-CDN+Babel prototype. The functional/technical spec calls for a "production form (vanilla ES modules, no Babel-in-browser, no CDN React)" port at `public/`.

The frontend is also a PWA: it must install, register a service worker, and serve a read-only surface offline. Build complexity directly conflicts with the offline-installable requirement, because every layer between source and browser is another thing the service worker has to cache and the user has to wait on.

## Decision

The PWA in `public/` is **vanilla ES2022 modules**: every file is browser-ready, no bundler, no transpilation, no JSX.

- Files in `public/js/` are loaded directly by the browser via `<script type="module">`.
- Components export `render(props) → HTMLElement` (or small classes with the same contract). No virtual DOM library.
- Styling uses hand-written CSS with design tokens, as proven in the mockup.
- The service worker (`public/sw.js`) caches the shell + static API responses; cache invalidation is by URL path, no asset-hash gymnastics needed.

## Alternatives considered

- **React + Vite (or similar bundler).** Mature ecosystem and the mockup already speaks React-ish. Rejected because the spec explicitly excludes "Babel-in-browser, CDN React" and a bundler reintroduces the same build cost the mockup proves we don't need at this scale.
- **lit-html / Preact / Solid.** Smaller than React, but each still adds a runtime and a build/CDN choice. The mockup's component contract is small enough (render → HTMLElement) that a templating library is not load-bearing.
- **Server-rendered HTML + HTMX.** Tempting for the read surfaces, but Vibe Mode and the drift/variant resolvers need rich client-side state and live WebSocket fan-out. Mixing server-render with WS islands is more complex than the vanilla-module path.

## Consequences

- **Positive:** Zero-step deploy of the PWA — copy `public/` to disk, the server serves it as static files. The service worker only deals with real URLs, not hashed bundles.
- **Positive:** Components written this way are trivially unit-testable (no renderer, no JSDOM gymnastics required for primitives).
- **Positive:** Onboarding cost is "read MDN," not "read framework docs."
- **Negative:** No type checking on the frontend. We accept this for v1 and rely on integration / e2e tests; if it bites, ADR-amend to JSDoc + `tsc --checkJs`.
- **Negative:** No ergonomic templating; complex views may grow verbose DOM-construction code. Risk-rated medium in the implementation plan (§7).
- **Constraint:** Any third-party UI dependency must ship as an ES module loadable without a bundler. CDN imports via `import { ... } from 'https://...'` are allowed but discouraged for offline reasons; preferred path is to vendor the file into `public/js/vendor/`.

## Follow-ups

- Phase 6 ports the mockup's components into `public/js/components/` one at a time. Each port replaces a React component with a `render(props) → HTMLElement` function.
- If component sprawl past 10 views proves unmaintainable, this ADR is superseded by a follow-up that introduces lit-html (no JSX, still no bundler).

# Puffin GLM — interactive mockup

A clickable prototype of the Puffin GLM workbench: dashboard, sekkei browser,
change management, variants, where-used, effectivity, drift, reuse, and
provenance views. No build step — pure ES modules + React via CDN, transpiled
in the browser by `@babel/standalone`.

## Run it

**Locally:**

```sh
# any static server will do; the simplest:
cd mockup
python -m http.server 8000
# then open http://localhost:8000
```

(Plain `file://` will not work — modern browsers refuse to fetch `.jsx`
sibling files from disk. A static server is required.)

**Online:** every push to `main` deploys this folder to GitHub Pages via
`.github/workflows/pages.yml`. The live URL is shown on the Actions run
under the "Deploy to GitHub Pages" step.

## Files

```
mockup/
├── index.html        Page shell + CDN script tags for React + Babel
├── styles.css        Geist font + UI styling
├── data.jsx          Mock data
├── components.jsx    Shared UI primitives
├── app.jsx           Top-level router + layout
└── views/
    ├── dashboard.jsx
    ├── sekkei.jsx
    ├── changes.jsx
    ├── variants.jsx
    ├── whereused.jsx
    ├── effectivity.jsx
    ├── drift.jsx
    ├── reuse.jsx
    └── provenance.jsx
```

This is a UX exploration, not a working sekkei runtime — see
`/specification` and `/todo-mvc` in the parent directory for the real spec
and a regenerated reference implementation.

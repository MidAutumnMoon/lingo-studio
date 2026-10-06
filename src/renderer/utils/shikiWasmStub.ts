// Bundler-alias target for `shiki/wasm` (see electron.vite.config.ts, renderer.resolve.alias).
// The app runs shiki on the JavaScript regex engine, so the oniguruma WASM binary is
// deliberately absent from the bundle — otherwise a dead 622KB wasm-inlined chunk still
// ships even when every createHighlighter call passes an explicit engine.
//
// Reaching this module means some highlighter fell back to shiki's wasm default: find the
// createHighlighter call and pass `engine: createJavaScriptRegexEngine({ forgiving: true })`.

throw new Error('shiki/wasm is not bundled: this app uses the JavaScript regex engine')

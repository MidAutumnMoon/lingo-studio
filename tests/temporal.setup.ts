// Tests run on system Node 24 (per .node-version) which lacks Temporal, while src/ always
// runs on Electron 44 with native Temporal: install the polyfill only when missing, and
// never import this package from src/.
if (typeof Temporal === 'undefined') {
  await import('temporal-polyfill/global')
}

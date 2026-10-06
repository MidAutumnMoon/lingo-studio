import './temporal.setup'

// Shared DOM-environment compensation for every happy-dom project.
// happy-dom rejects Animation.finished on cancel() per spec; Motion's WAAPI path
// never awaits it, so mark the rejection handled to keep exit codes clean.
// Drop this when happy-dom ships PR #2340.
if (typeof window !== 'undefined' && window.Animation?.prototype?.cancel) {
  const cancelAnimation = window.Animation.prototype.cancel
  window.Animation.prototype.cancel = function (this: Animation) {
    cancelAnimation.call(this)
    this.finished?.catch(() => {})
  }
}

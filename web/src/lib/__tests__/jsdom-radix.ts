/**
 * jsdom is missing a few DOM APIs that Radix's layers (Popper, DismissableLayer, FocusScope) call.
 * Test files that render a Radix tree under the jsdom environment install them first; the SSR tests
 * for portal-free components do not need this.
 */
export function installRadixPolyfills() {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
  const proto = Element.prototype as Element & {
    hasPointerCapture?: (pointerId: number) => boolean
    setPointerCapture?: (pointerId: number) => void
    releasePointerCapture?: (pointerId: number) => void
    scrollIntoView?: (arg?: boolean | ScrollIntoViewOptions) => void
  }
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
}

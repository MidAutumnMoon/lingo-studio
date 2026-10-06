import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaintingData } from '../../model/types/paintingData'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const mockPaintingSkeletonSurface = vi.hoisted(() => vi.fn())
vi.mock('../PaintingSkeletonSurface', () => ({
  default: (props: { imageUrl?: string; onRevealReady?: () => void }) => {
    mockPaintingSkeletonSurface(props)
    return <div data-testid="painting-skeleton-surface" />
  }
}))

const mockUseImageGenerationSupport = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useImageGenerationSupport', () => ({
  useImageGenerationSupport: mockUseImageGenerationSupport
}))

// Imported after mocks are registered. The size resolvers are unit-tested in
// form/__tests__/paintingSize.test.ts; here they arrive via the mocked hook.
const { default: PaintingImageSkeleton } = await import('../PaintingImageSkeleton')

/** Minimal registry support declaring a single size-bearing field. */
const supportWith = (key: string, options: string[], def: string) => ({
  modes: { generate: { supports: { [key]: { type: 'enum', options, default: def } } } }
})

const makePainting = (overrides: Partial<PaintingData> = {}): PaintingData => ({
  id: 'p1',
  providerId: 'openai',
  model: 'gpt-image-1',
  mode: 'generate',
  prompt: '',
  files: [],
  ...overrides
})

describe('PaintingImageSkeleton', () => {
  beforeEach(() => {
    mockUseImageGenerationSupport.mockReset()
    mockPaintingSkeletonSurface.mockClear()
  })

  it('renders the skeleton surface with the status role', () => {
    mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1024x1024'], '1024x1024'))

    const { getByRole } = render(<PaintingImageSkeleton painting={makePainting()} />)

    expect(getByRole('status')).toBeInTheDocument()
    expect(getByRole('status').firstElementChild).not.toBeNull()
  })

  it('passes the image url and reveal handoff through to the skeleton surface', () => {
    mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1024x1024'], '1024x1024'))
    const onRevealReady = vi.fn()

    render(
      <PaintingImageSkeleton
        imageUrl="file:///tmp/image-1.png"
        onRevealReady={onRevealReady}
        painting={makePainting()}
      />
    )

    expect(mockPaintingSkeletonSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({
        imageUrl: 'file:///tmp/image-1.png',
        onRevealReady
      })
    )
  })

  it('fills the area when the model declares no size field', () => {
    mockUseImageGenerationSupport.mockReturnValue(undefined)

    const { getByRole } = render(<PaintingImageSkeleton painting={makePainting()} />)

    // firstElementChild is the [topBar, box] column wrapper; the box itself is its
    // last child (works whether or not a topBar is present).
    const wrapper = getByRole('status').firstElementChild as HTMLElement
    expect(wrapper).toHaveClass('h-full', 'w-full')
    expect(wrapper.lastElementChild).toHaveClass('flex-1', 'min-h-0')
  })

  it('falls back to the percentage-sized box when reveal natural size is unavailable', () => {
    mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1024x1024'], '1024x1024'))

    const { getByRole } = render(<PaintingImageSkeleton painting={makePainting()} />)

    const box = getByRole('status').firstElementChild!.lastElementChild as HTMLElement
    // Unmeasured + no natural size: the box fills the available width instead
    // of locking to pixels; the ratio itself rides on `aspect-ratio`.
    expect(box.style.width).toBe('100%')
    expect(box.style.height).toBe('auto')
  })

  describe('reveal geometry relock', () => {
    let clientWidth: ReturnType<typeof vi.spyOn>
    let clientHeight: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
      clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    })

    afterEach(() => {
      clientWidth.mockRestore()
      clientHeight.mockRestore()
    })

    it('locks the box to min(natural size, contain fit) once natural dimensions are known', () => {
      mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1024x1024'], '1024x1024'))

      const { getByRole } = render(
        <PaintingImageSkeleton naturalHeight={500} naturalWidth={1000} painting={makePainting()} />
      )

      // Contain-fit against a 400x300 container: scale = min(1, 400/1000, 300/500) = 0.4.
      const box = getByRole('status').firstElementChild!.lastElementChild as HTMLElement
      expect(box.style.width).toBe('400px')
      expect(box.style.height).toBe('200px')
    })

    it('never upscales past the natural size even when the container is larger', () => {
      mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1024x1024'], '1024x1024'))

      const { getByRole } = render(
        <PaintingImageSkeleton naturalHeight={100} naturalWidth={100} painting={makePainting()} />
      )

      const box = getByRole('status').firstElementChild!.lastElementChild as HTMLElement
      expect(box.style.width).toBe('100px')
      expect(box.style.height).toBe('100px')
    })

    it('reserves the top bar height instead of using the full container', () => {
      mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1024x1024'], '1024x1024'))
      clientHeight.mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'painting-skeleton-top-bar-measure' ? 60 : 300
      })

      const { getByRole } = render(
        <PaintingImageSkeleton
          naturalHeight={600}
          naturalWidth={200}
          painting={makePainting()}
          topBar={<div>prompt</div>}
        />
      )

      // Reserving the bar's 60px, contain-fit runs against 400x240:
      // scale = min(1, 400/200, 240/600) = 0.4, so 200x600 → 80x240.
      const box = getByRole('status').firstElementChild!.lastElementChild as HTMLElement
      expect(box.style.width).toBe('80px')
      expect(box.style.height).toBe('240px')
    })
  })

  describe('prompt bar alignment', () => {
    let clientWidth: ReturnType<typeof vi.spyOn>
    let clientHeight: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
      clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        return this.dataset.testid === 'painting-skeleton-top-bar-measure' ? 40 : 300
      })
    })

    afterEach(() => {
      clientWidth.mockRestore()
      clientHeight.mockRestore()
    })

    it('pins the [topBar, box] column to the box width so a long prompt cannot stretch it past a narrow image', () => {
      // Portrait 768×1024 in a 400×(300−40 bar) container is height-constrained:
      // box width = 260 × 0.75 = 195, and the column must match that image width.
      mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['768x1024'], '768x1024'))

      const { getByRole } = render(
        <PaintingImageSkeleton painting={makePainting()} topBar={<div>{'a very long prompt '.repeat(50)}</div>} />
      )

      const column = getByRole('status').firstElementChild as HTMLElement
      expect(column.style.width).toBe('195px')
      // The box carries the same width, so the bar (stretched to the column) aligns with it.
      expect((column.lastElementChild as HTMLElement).style.width).toBe('195px')
      // The bar wrapper keeps `min-w-0` so its content truncates instead of
      // forcing the column wider (no real layout here, so pin the guard).
      expect(column.firstElementChild).toHaveClass('min-w-0')
    })

    it('tracks the full canvas width for an image wider than the container (width-constrained)', () => {
      // Wide 1600×800 (ratio 2.0) exceeds the container's 400/260≈1.54 aspect, so
      // it's width-constrained: box = 400 × 200, column spans the full 400px canvas.
      mockUseImageGenerationSupport.mockReturnValue(supportWith('size', ['1600x800'], '1600x800'))

      const { getByRole } = render(<PaintingImageSkeleton painting={makePainting()} topBar={<div>prompt</div>} />)

      const column = getByRole('status').firstElementChild as HTMLElement
      expect(column.style.width).toBe('400px')
      const box = column.lastElementChild as HTMLElement
      expect(box.style.width).toBe('400px')
      expect(box.style.height).toBe('200px')
    })
  })
})

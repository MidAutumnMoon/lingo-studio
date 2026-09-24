import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FILE_PROCESSOR_IDS } from '@shared/data/preference/preferenceTypes'

import { FileProcessorIcon } from '../FileProcessorIcon'

describe('FileProcessorIcon', () => {
  // The map this reads used to be duplicated per page. When a processor was
  // added to one copy and not the other, `Logo.Avatar` on `undefined` threw and
  // an error boundary swallowed the entire RAG config panel.
  it.each(FILE_PROCESSOR_IDS)('renders a mark for %s', (processorId) => {
    const { container } = render(<FileProcessorIcon processorId={processorId} />)

    expect(container.querySelector('svg, img')).toBeInTheDocument()
  })

  it('falls back to a neutral glyph for an id it does not know', () => {
    const { container } = render(<FileProcessorIcon processorId="removed-in-a-later-release" />)

    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import EmbeddingSection from '../EmbeddingSection'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../panelPrimitives', () => ({
  RagFieldLabel: ({ label }: { label: string }) => <span>{label}</span>
}))

vi.mock('../../../components/KnowledgeModelSelect', () => ({
  isEmbeddingModel: () => true,
  isRerankModel: () => false,
  KnowledgeModelSelect: ({
    value,
    placeholder,
    noneOptionLabel,
    onChange
  }: {
    value: string | null
    placeholder: string
    noneOptionLabel?: string
    onChange: (modelId: string | null) => void
  }) => (
    <div>
      <span>{value ?? placeholder}</span>
      <button type="button" onClick={() => onChange('openai::text-embedding-3-small')}>
        model-option
      </button>
      {noneOptionLabel ? (
        <button type="button" onClick={() => onChange(null)}>
          {noneOptionLabel}
        </button>
      ) : null}
    </div>
  )
}))

describe('EmbeddingSection', () => {
  it('keeps the model and disabled entries inside the selector', () => {
    const { rerender } = render(<EmbeddingSection embeddingModelId={null} onEmbeddingModelChange={vi.fn()} />)
    const modelOption = screen.getByText('model-option')

    expect(modelOption).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'knowledge.rag.rerank_disabled' })).toBeInTheDocument()
    expect(screen.queryByText('knowledge.rag.file_processing_none')).not.toBeInTheDocument()

    rerender(<EmbeddingSection embeddingModelId="voyage::voyage-3-large" onEmbeddingModelChange={vi.fn()} />)
    expect(screen.getByText('model-option')).toBeInTheDocument()
  })

  it('reports model selection through the single change callback', () => {
    const onEmbeddingModelChange = vi.fn()
    render(<EmbeddingSection embeddingModelId={null} onEmbeddingModelChange={onEmbeddingModelChange} />)

    fireEvent.click(screen.getByText('model-option'))

    expect(onEmbeddingModelChange).toHaveBeenCalledWith('openai::text-embedding-3-small')
  })

  it('reports the disabled entry through the single change callback', () => {
    const onEmbeddingModelChange = vi.fn()
    render(
      <EmbeddingSection
        embeddingModelId="openai::text-embedding-3-small"
        onEmbeddingModelChange={onEmbeddingModelChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'knowledge.rag.rerank_disabled' }))

    expect(onEmbeddingModelChange).toHaveBeenCalledWith(null)
  })
})

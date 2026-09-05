import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

function Bomb(): React.ReactElement {
  throw new Error('boom')
}

describe('ErrorBoundary', () => {
  it('renders a friendly fallback when a child crashes', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    )

    expect(screen.getByText('Algo salió mal')).toBeTruthy()
    expect(screen.getByText(/no pudo cargar/i)).toBeTruthy()
    expect(screen.getByText('Reintentar')).toBeTruthy()
  })
})

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { motion } from 'motion/react'
import { EASE_OUT } from '@shared/lib/motionTokens'

interface ErrorBoundaryProps {
  children?: ReactNode
  message?: string
  onRetry?: () => void
  resetKey?: string
}

interface ErrorBoundaryState {
  hasError: boolean
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error', error, errorInfo)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Cuando este boundary tiene un `resetKey` (la ruta actual, típicamente),
    // un error atrapado en una página no debe seguir "pegado" al navegar a
    // otra — sin esto, entrar a una página rota y volver mostraba "Algo
    // salió mal" heredado en vez de la página nueva, aunque esa sí cargara bien.
    // setState acá es a propósito y acotado: solo cuando cambió resetKey Y
    // hay un error activo (una sola pasada, no un loop de renders).
    if (this.state.hasError && this.props.resetKey !== undefined && this.props.resetKey !== prevProps.resetKey) {
      // oxlint-disable-next-line react/no-did-update-set-state
      this.setState({ hasError: false })
    }
  }

  handleRetry = () => {
    if (this.props.onRetry) {
      this.props.onRetry()
      this.setState({ hasError: false })
    } else {
      window.location.reload()
    }
  }

  render() {
    if (this.state.hasError) {
      const reduceMotion =
        typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      return (
        <motion.div
          style={{ padding: '3rem 1.5rem', color: '#fff', textAlign: 'center' }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: EASE_OUT }}
        >
          <h2 style={{ marginBottom: '0.5rem' }}>Algo salió mal</h2>
          <p style={{ opacity: 0.75, marginBottom: '1.25rem' }}>
            {this.props.message || 'Esta página no pudo cargar. Puede ser un problema momentáneo de red.'}
          </p>
          <motion.button
            type="button"
            onClick={this.handleRetry}
            style={{
              padding: '0.65rem 1.4rem',
              borderRadius: '999px',
              border: 'none',
              background: '#fff',
              color: '#000',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.94 }}
          >
            Reintentar
          </motion.button>
        </motion.div>
      )
    }

    return this.props.children
  }
}

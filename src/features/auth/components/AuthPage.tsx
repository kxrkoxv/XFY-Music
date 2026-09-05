import { useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import { Eye, EyeOff, Fingerprint, Check } from 'lucide-react'
import { useAuthStore } from '@features/auth/store/useAuthStore'
import './AuthPage.css'

// Password generation rules matching Apple/Safari password requirements.
// https://developer.apple.com/password-rules/
const PASSWORD_RULES = 'minlength: 8; required: lower; required: upper; required: digit;'

export default function AuthPage() {
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const reduceMotion = useReducedMotion()

  return (
    <div className="auth-page">
      <div className="auth-page-grain" aria-hidden="true" />
      <motion.div
        className="auth-card"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
      >
        <motion.div
          className="auth-brand"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="auth-brand-icon">
            <img src="/icons/xfy-mark.png" alt="XFY" />
          </div>
          <p className="auth-brand-tagline">Tu música, sin fronteras.</p>
        </motion.div>

        <SocialAuthButtons />

        <motion.div
          className="auth-divider"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.3 }}
        >
          <span>o con tu correo</span>
        </motion.div>

        <motion.div
          className="auth-tabs"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.35, ease: [0.23, 1, 0.32, 1] }}
        >
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            <motion.span whileTap={{ scale: 0.94 }} style={{ display: 'inline-block' }}>
              Iniciar sesión
            </motion.span>
          </button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            <motion.span whileTap={{ scale: 0.94 }} style={{ display: 'inline-block' }}>
              Crear cuenta
            </motion.span>
          </button>
          <motion.div
            className="auth-tabs-indicator"
            animate={{ transform: mode === 'login' ? 'translateX(0%)' : 'translateX(100%)' }}
            // Reduced-motion: el indicador cambia de lado con un salto directo.
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', bounce: 0.15, duration: 0.45 }}
          />
        </motion.div>

        <AnimatePresence mode="wait">
          {mode === 'login' ? (
            <motion.div
              key="login"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            >
              <LoginForm />
            </motion.div>
          ) : (
            <motion.div
              key="register"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            >
              <RegisterForm onSuccess={() => setMode('login')} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

// --- Social Auth / Passkey Stubs ---
// Displays upcoming authentication methods to inform users of future features.

const socialContainerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.12 } },
}

const socialItemVariants = {
  hidden: { opacity: 0, y: 10, scale: 0.94 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.32, ease: [0.23, 1, 0.32, 1] } },
}

// Reduced-motion: solo fade escalonado, sin subida ni scale.
const socialItemVariantsRM = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.32 } },
}

function SocialAuthButtons() {
  const comingSoon = (label: string) => () => toast.info(`Inicio de sesión con ${label} llega pronto.`)
  const loginWithPasskey = useAuthStore((s) => s.loginWithPasskey)
  const reduceMotion = useReducedMotion()
  const [passkeyBusy, setPasskeyBusy] = useState(false)

  const handlePasskey = async () => {
    setPasskeyBusy(true)
    let result
    try {
      result = await loginWithPasskey(true)
    } catch {
      toast.error('No se pudo conectar. Revisá tu conexión e intentá de nuevo.')
      setPasskeyBusy(false)
      return
    }
    setPasskeyBusy(false)
    if (!result.ok) return // cancelado por el usuario o sin passkeys — no hace falta un toast alarmante
    toast.success(`¡Bienvenido de vuelta, ${result.user?.nickname}!`)
  }

  const items: [string, string, ReactNode, (() => void) | undefined][] = [
    ['Google', 'Google', <GoogleIcon key="g" />, undefined],
    ['Apple', 'Apple', <AppleIcon key="a" />, undefined],
    ['una passkey', 'Passkey', <Fingerprint key="p" size={18} strokeWidth={2} />, handlePasskey],
  ]

  return (
    <motion.div
      className="auth-social"
      variants={socialContainerVariants}
      initial="hidden"
      animate="visible"
    >
      {items.map(([label, text, icon, action]) => {
        const isPasskey = label === 'una passkey'
        return (
          <motion.button
            key={label}
            type="button"
            className="auth-social-btn"
            aria-label={isPasskey ? text : `${text} — próximamente`}
            variants={reduceMotion ? socialItemVariantsRM : socialItemVariants}
            whileHover={reduceMotion ? undefined : { y: -2 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            disabled={isPasskey && passkeyBusy}
            onClick={action ?? comingSoon(label)}
          >
            {icon}
            <span>{isPasskey && passkeyBusy ? 'Esperando…' : text}</span>
            {!isPasskey && <em aria-hidden="true">Próximamente</em>}
          </motion.button>
        )
      })}
    </motion.div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.9v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.9A9 9 0 0 0 0 9c0 1.45.35 2.83.9 4.03z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .9 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z"
      />
    </svg>
  )
}

function AppleIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true" fill="currentColor">
      <path d="M13.1 9.53c-.02-2.02 1.65-2.99 1.72-3.03-.94-1.37-2.4-1.56-2.92-1.58-1.24-.13-2.43.73-3.06.73-.63 0-1.6-.71-2.63-.7-1.35.02-2.6.79-3.3 1.99-1.4 2.44-.36 6.05 1.02 8.03.66.96 1.46 2.05 2.5 2.01 1-.04 1.38-.65 2.6-.65 1.21 0 1.56.65 2.62.63 1.09-.02 1.77-.98 2.44-1.95.75-1.11 1.06-2.19 1.08-2.24-.02-.01-2.06-.8-2.08-3.24z" />
      <path d="M11.1 3.44c.55-.68.93-1.62.83-2.56-.8.03-1.78.54-2.36 1.2-.51.6-.96 1.57-.84 2.48.9.07 1.82-.45 2.37-1.12z" />
    </svg>
  )
}

// --- Password Strength ---

function getPasswordChecks(password: string) {
  return {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    digit: /\d/.test(password),
  }
}

function getPasswordScore(password: string) {
  if (!password) return 0
  const checks = getPasswordChecks(password)
  let score = Object.values(checks).filter(Boolean).length
  if (password.length >= 12) score += 1
  return Math.min(score, 5)
}

const STRENGTH_LABELS = ['', 'Muy débil', 'Débil', 'Aceptable', 'Fuerte', 'Muy fuerte']

function PasswordStrengthMeter({ password }: { password: string }) {
  const score = getPasswordScore(password)
  const checks = getPasswordChecks(password)

  return (
    <motion.div
      className="auth-strength"
      initial={{ opacity: 0, height: 0, marginTop: -16 }}
      animate={{ opacity: 1, height: 'auto', marginTop: -6 }}
      exit={{ opacity: 0, height: 0, marginTop: -16 }}
      transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
    >
      <div className="auth-strength-bar">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="auth-strength-segment">
            <motion.i
              className={i < score ? `s${score}` : ''}
              animate={{ scaleX: i < score ? 1 : 0 }}
              transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1], delay: i * 0.03 }}
            />
          </span>
        ))}
      </div>
      <AnimatePresence mode="wait">
        {password && (
          <motion.span
            key={STRENGTH_LABELS[score]}
            className="auth-strength-label"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 4 }}
            transition={{ duration: 0.15 }}
          >
            {STRENGTH_LABELS[score]}
          </motion.span>
        )}
      </AnimatePresence>
      <ul className="auth-checklist">
        <ChecklistItem ok={checks.length} label="Mínimo 8 caracteres" />
        <ChecklistItem ok={checks.upper && checks.lower} label="Mayúsculas y minúsculas" />
        <ChecklistItem ok={checks.digit} label="Al menos un número" />
      </ul>
    </motion.div>
  )
}

function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={ok ? 'ok' : ''}>
      <motion.span
        className="auth-checklist-dot"
        animate={ok ? { scale: [0.7, 1.15, 1] } : { scale: 1 }}
        transition={{ duration: 0.32, ease: [0.23, 1, 0.32, 1] }}
      >
        <Check size={12} strokeWidth={3} />
      </motion.span>
      {label}
    </li>
  )
}

// --- Password Field with Visibility Toggle & Caps Lock Warning ---

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  autoComplete?: string
  passwordRules?: string
  placeholder?: string
}

function PasswordField({ id, label, value, onChange, autoComplete, passwordRules, placeholder }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLock(e.getModifierState('CapsLock'))
    }
  }

  return (
    <label className="auth-field" htmlFor={id}>
      <span>{label}</span>
      <div className="auth-password-wrap">
        <input
          id={id}
          name={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          onKeyUp={handleKey}
          onKeyDown={handleKey}
          autoComplete={autoComplete}
          {...{ passwordrules: passwordRules }}
          placeholder={placeholder}
        />
        <motion.button
          type="button"
          className="auth-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          tabIndex={-1}
          whileTap={{ scale: 0.85 }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {visible ? (
              <motion.span
                key="off"
                initial={{ opacity: 0, rotate: -20, scale: 0.7 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 20, scale: 0.7 }}
                transition={{ duration: 0.16 }}
              >
                <EyeOff size={17} />
              </motion.span>
            ) : (
              <motion.span
                key="on"
                initial={{ opacity: 0, rotate: -20, scale: 0.7 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 20, scale: 0.7 }}
                transition={{ duration: 0.16 }}
              >
                <Eye size={17} />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>
      <AnimatePresence>
        {capsLock && (
          <motion.span
            className="auth-caps-warning"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          >
            ⇪ Bloq Mayús está activado
          </motion.span>
        )}
      </AnimatePresence>
    </label>
  )
}

// --- Forms ---

function LoginForm() {
  const login = useAuthStore((s) => s.login)
  const verifyTwoFactor = useAuthStore((s) => s.verifyTwoFactor)
  const cancelTwoFactor = useAuthStore((s) => s.cancelTwoFactor)
  const pendingTwoFactor = useAuthStore((s) => s.pendingTwoFactor)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [keepLoggedIn, setKeepLoggedIn] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!email || !password) {
      toast.error('Todos los campos son obligatorios.')
      return
    }
    setSubmitting(true)
    let result
    try {
      result = await login(email, password, keepLoggedIn)
    } catch {
      toast.error('No se pudo conectar. Revisá tu conexión e intentá de nuevo.')
      return
    } finally {
      setSubmitting(false)
    }
    if (!result.ok) {
      toast.error('Credenciales incorrectas.')
      return
    }
    if (result.requires2fa) return // pasa a TwoFactorForm (ver render abajo)
    toast.success(`¡Bienvenido de vuelta, ${result.user?.nickname}!`)
  }

  if (pendingTwoFactor) {
    return <TwoFactorForm onVerify={verifyTwoFactor} onCancel={cancelTwoFactor} />
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-field" htmlFor="login-email">
        <span>Correo electrónico</span>
        <input
          id="login-email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username webauthn"
          placeholder="tucorreo@ejemplo.com"
        />
      </label>
      <PasswordField
        id="login-password"
        label="Contraseña"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        placeholder="••••••••"
      />
      <label className="auth-checkbox">
        <input type="checkbox" checked={keepLoggedIn} onChange={(e) => setKeepLoggedIn(e.target.checked)} />
        <span>Mantener sesión iniciada</span>
      </label>
      <motion.button
        className="auth-submit"
        type="submit"
        disabled={submitting}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={submitting ? 'loading' : 'idle'}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {submitting ? 'Entrando…' : 'Iniciar sesión'}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </form>
  )
}

/** Segundo paso del login cuando la cuenta tiene 2FA activado — pide el
 *  código de 6 dígitos de la app autenticadora, o un código de respaldo
 *  XXXX-XXXX si el usuario perdió el acceso a esa app. */
function TwoFactorForm({
  onVerify,
  onCancel,
}: {
  onVerify: (code: string) => Promise<{ ok: boolean; user?: { nickname: string } | null }>
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!code.trim()) {
      toast.error('Ingresá el código de tu app autenticadora.')
      return
    }
    setSubmitting(true)
    let result
    try {
      result = await onVerify(code.trim())
    } catch {
      toast.error('No se pudo conectar. Revisá tu conexión e intentá de nuevo.')
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    if (!result.ok) {
      toast.error('Código incorrecto.')
      setCode('')
      return
    }
    toast.success(`¡Bienvenido de vuelta, ${result.user?.nickname}!`)
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <p className="auth-2fa-hint">
        Esta cuenta tiene verificación en dos pasos. Ingresá el código de tu app autenticadora, o un código de
        respaldo si no tenés acceso a ella.
      </p>
      <label className="auth-field" htmlFor="login-2fa-code">
        <span>Código de verificación</span>
        <input
          id="login-2fa-code"
          name="code"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456 o XXXX-XXXX"
          autoFocus
        />
      </label>
      <motion.button
        className="auth-submit"
        type="submit"
        disabled={submitting}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      >
        {submitting ? 'Verificando…' : 'Verificar'}
      </motion.button>
      <button type="button" className="auth-form-link" onClick={onCancel}>
        <span>Volver</span>
      </button>
    </form>
  )
}

function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const register = useAuthStore((s) => s.register)
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const checks = useMemo(() => getPasswordChecks(password), [password])
  const passwordValid = checks.length && checks.upper && checks.lower && checks.digit

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!nickname || !email || !password || !confirmPassword) {
      toast.error('Todos los campos son obligatorios.')
      return
    }
    if (!passwordValid) {
      toast.error('La contraseña no cumple los requisitos mínimos.')
      return
    }
    if (password !== confirmPassword) {
      toast.error('Las contraseñas no coinciden.')
      return
    }
    setSubmitting(true)
    let result
    try {
      result = await register({ nickname, email, password })
    } catch {
      toast.error('No se pudo conectar. Revisá tu conexión e intentá de nuevo.')
      return
    } finally {
      setSubmitting(false)
    }
    if (!result.ok) {
      toast.error(result.reason === 'duplicate' ? 'Ese correo ya está registrado.' : 'No se pudo crear la cuenta.')
      return
    }
    toast.success('¡Cuenta creada! Ahora puedes iniciar sesión.')
    onSuccess()
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-field" htmlFor="register-nickname">
        <span>Nombre de usuario</span>
        <input
          id="register-nickname"
          name="username"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          autoComplete="username"
          placeholder="Puntico"
        />
      </label>
      <label className="auth-field" htmlFor="register-email">
        <span>Correo electrónico</span>
        <input
          id="register-email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="tucorreo@ejemplo.com"
        />
      </label>
      <PasswordField
        id="register-password"
        label="Contraseña"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        passwordRules={PASSWORD_RULES}
        placeholder="Crea una contraseña"
      />
      <AnimatePresence>{password && <PasswordStrengthMeter key="strength" password={password} />}</AnimatePresence>
      <PasswordField
        id="register-confirm-password"
        label="Confirmar contraseña"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        autoComplete="new-password"
        passwordRules={PASSWORD_RULES}
        placeholder="Repite la contraseña"
      />
      <AnimatePresence>
        {confirmPassword && confirmPassword !== password && (
          <motion.span
            className="auth-mismatch"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          >
            Las contraseñas no coinciden todavía.
          </motion.span>
        )}
      </AnimatePresence>
      <motion.button
        className="auth-submit"
        type="submit"
        disabled={submitting}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={submitting ? 'loading' : 'idle'}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {submitting ? 'Creando cuenta…' : 'Crear cuenta'}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </form>
  )
}

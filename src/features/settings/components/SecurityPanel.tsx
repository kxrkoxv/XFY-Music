import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { toast } from 'sonner'
import QRCode from 'qrcode'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  KeyRound,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Plus,
  X,
  Copy,
  Download,
  Laptop,
  MonitorSmartphone,
  RotateCcw,
} from 'lucide-react'
import { useSecurityStore } from '@features/settings/store/useSecurityStore'
import { EASE_OUT } from '@shared/lib/motionTokens'
import './SecurityPanel.css'

function timeAgo(iso: string | null): string {
  if (!iso) return 'nunca'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.floor(h / 24)
  if (d < 30) return `hace ${d} d`
  return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copiado.`)
  } catch {
    toast.error('No se pudo copiar. Copialo a mano.')
  }
}

function downloadBackupCodes(codes: string[]) {
  const blob = new Blob(
    [`Códigos de respaldo de XFY\nCada uno sirve una sola vez. Guardalos en un lugar seguro.\n\n${codes.join('\n')}\n`],
    { type: 'text/plain' },
  )
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'xfy-codigos-de-respaldo.txt'
  a.click()
  URL.revokeObjectURL(url)
}

/** Colapsable genérico para los formularios inline (agregar passkey, 2FA,
 *  regenerar/desactivar): anima alto+opacidad al abrir/cerrar en vez de
 *  aparecer/desaparecer de golpe. */
function InlineReveal({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      style={{ overflow: 'hidden' }}
    >
      {children}
    </motion.div>
  )
}

export default function SecurityPanel() {
  const loadedOnce = useSecurityStore((s) => s.loadedOnce)
  const fetchStatus = useSecurityStore((s) => s.fetchStatus)

  useEffect(() => {
    if (!loadedOnce) void fetchStatus()
  }, [loadedOnce, fetchStatus])

  return (
    <>
      <PasskeysSection />
      <TwoFactorSection />
      <SessionsSection />
    </>
  )
}

// --- Passkeys ----------------------------------------------------------

function PasskeysSection() {
  const passkeys = useSecurityStore((s) => s.passkeys)
  const addPasskey = useSecurityStore((s) => s.addPasskey)
  const removePasskey = useSecurityStore((s) => s.removePasskey)
  const [adding, setAdding] = useState(false)
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)

  const handleAdd = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    let result
    try {
      result = await addPasskey(deviceName || 'Passkey')
    } catch {
      toast.error('No se pudo conectar. Revisá tu conexión e intentá de nuevo.')
      setBusy(false)
      return
    }
    setBusy(false)
    if (!result.ok) {
      if (result.reason !== 'cancelled') toast.error('No se pudo agregar la passkey. Probá de nuevo.')
      return
    }
    toast.success('Passkey agregada.')
    setAdding(false)
    setDeviceName('')
  }

  return (
    <section className="settings-group security-group">
      <div className="settings-row-item">
        <div className="settings-row-icon">
          <KeyRound size={16} />
        </div>
        <div className="settings-row-text">
          <span className="settings-row-title">Llaves de seguridad</span>
          <span className="settings-row-desc">
            Iniciá sesión sin contraseña con Face ID, huella, Windows Hello o una llave física (passkeys).
          </span>
        </div>
      </div>

      {passkeys.length > 0 && (
        <ul className="security-list">
          <AnimatePresence initial={false}>
            {passkeys.map((p, index) => (
              <motion.li
                key={p.id}
                className="security-list-item"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: EASE_OUT, delay: Math.min(index * 0.03, 0.2) }}
              >
                <div className="security-list-icon">
                  <Laptop size={15} />
                </div>
                <div className="security-list-text">
                  <span className="security-list-title">{p.deviceName}</span>
                  <span className="security-list-meta">
                    Agregada {timeAgo(p.createdAt)} · Usada {timeAgo(p.lastUsedAt)}
                  </span>
                </div>
                <motion.button
                  type="button"
                  className="security-list-action"
                  aria-label={`Eliminar ${p.deviceName}`}
                  whileTap={{ scale: 0.85 }}
                  onClick={async () => {
                    const ok = await removePasskey(p.id)
                    if (ok) toast.success('Passkey eliminada.')
                    else toast.error('No se pudo eliminar.')
                  }}
                >
                  <Trash2 size={14} />
                </motion.button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <div className="settings-divider" />

      {adding ? (
        <InlineReveal>
          <form className="security-inline-form" onSubmit={handleAdd}>
            <input
              className="security-inline-input"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Nombre para esta llave (ej. Mi laptop)"
              maxLength={60}
              autoFocus
            />
            <div className="security-inline-actions">
              <button type="button" className="security-btn-ghost" onClick={() => setAdding(false)} disabled={busy}>
                Cancelar
              </button>
              <button type="submit" className="security-btn-primary" disabled={busy}>
                {busy ? 'Esperando…' : 'Continuar'}
              </button>
            </div>
          </form>
        </InlineReveal>
      ) : (
        <div className="settings-row-item settings-row-item--action">
          <button type="button" className="settings-theme-creator-toggle" onClick={() => setAdding(true)}>
            <Plus size={14} />
            Agregar passkey
          </button>
        </div>
      )}
    </section>
  )
}

// --- Verificación en dos pasos (TOTP) -----------------------------------

function TwoFactorSection() {
  const totpEnabled = useSecurityStore((s) => s.totpEnabled)
  const totpSetupStart = useSecurityStore((s) => s.totpSetupStart)
  const totpSetupVerify = useSecurityStore((s) => s.totpSetupVerify)
  const totpDisable = useSecurityStore((s) => s.totpDisable)
  const regenerateBackupCodes = useSecurityStore((s) => s.regenerateBackupCodes)

  const [setupOpen, setSetupOpen] = useState(false)
  const [secret, setSecret] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const [disableOpen, setDisableOpen] = useState(false)
  const [regenOpen, setRegenOpen] = useState(false)
  const [password, setPassword] = useState('')

  const startSetup = async () => {
    setBusy(true)
    const result = await totpSetupStart()
    setBusy(false)
    if (!result.ok || !result.secret || !result.otpauthUrl) {
      toast.error('No se pudo iniciar la configuración.')
      return
    }
    setSecret(result.secret)
    try {
      setQrDataUrl(await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 }))
    } catch {
      setQrDataUrl('')
    }
    setSetupOpen(true)
  }

  const confirmSetup = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    const result = await totpSetupVerify(code)
    setBusy(false)
    if (!result.ok) {
      toast.error('Código incorrecto. Revisá la hora de tu teléfono y probá de nuevo.')
      setCode('')
      return
    }
    setBackupCodes(result.backupCodes ?? [])
  }

  const finishSetup = () => {
    setSetupOpen(false)
    setSecret('')
    setQrDataUrl('')
    setCode('')
    setBackupCodes(null)
    toast.success('Verificación en dos pasos activada.')
  }

  const handleDisable = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    const result = await totpDisable(password)
    setBusy(false)
    setPassword('')
    if (!result.ok) {
      toast.error(result.reason === 'wrong_password' ? 'Contraseña incorrecta.' : 'No se pudo desactivar.')
      return
    }
    setDisableOpen(false)
    toast.success('Verificación en dos pasos desactivada.')
  }

  const handleRegenerate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    const result = await regenerateBackupCodes(password)
    setBusy(false)
    setPassword('')
    if (!result.ok || !result.backupCodes) {
      toast.error(result.reason === 'wrong_password' ? 'Contraseña incorrecta.' : 'No se pudo regenerar.')
      return
    }
    setRegenOpen(false)
    setBackupCodes(result.backupCodes)
  }

  // Backup codes recién generados (por setup o por regeneración) — se
  // muestran UNA vez, sin importar de qué flujo vinieron.
  if (backupCodes) {
    return (
      <section className="settings-group security-group">
        <div className="settings-row-item">
          <div className="settings-row-icon">
            <ShieldCheck size={16} />
          </div>
          <div className="settings-row-text">
            <span className="settings-row-title">Tus códigos de respaldo</span>
            <span className="settings-row-desc">
              Cada uno sirve una sola vez y te deja entrar si perdés el acceso a tu app autenticadora. Guardalos en un
              lugar seguro — no se van a volver a mostrar así.
            </span>
          </div>
        </div>
        <div className="security-backup-codes">
          {backupCodes.map((c) => (
            <span key={c} className="security-backup-code">
              {c}
            </span>
          ))}
        </div>
        <div className="security-inline-actions">
          <button type="button" className="security-btn-ghost" onClick={() => copyToClipboard(backupCodes.join('\n'), 'Códigos')}>
            <Copy size={14} />
            Copiar
          </button>
          <button type="button" className="security-btn-ghost" onClick={() => downloadBackupCodes(backupCodes)}>
            <Download size={14} />
            Descargar
          </button>
          <button type="button" className="security-btn-primary" onClick={finishSetup}>
            Ya los guardé
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-group security-group">
      <div className="settings-row-item">
        <div className="settings-row-icon">{totpEnabled ? <ShieldCheck size={16} /> : <ShieldOff size={16} />}</div>
        <div className="settings-row-text">
          <span className="settings-row-title">Verificación en dos pasos</span>
          <span className="settings-row-desc">
            {totpEnabled
              ? 'Activada — se pide un código de tu app autenticadora en cada inicio de sesión con contraseña.'
              : 'Sumá un código de una app autenticadora (Google Authenticator, Authy, etc.) al iniciar sesión con contraseña.'}
          </span>
        </div>
      </div>

      {!totpEnabled && !setupOpen && (
        <div className="settings-row-item settings-row-item--action">
          <button type="button" className="settings-theme-creator-toggle" onClick={startSetup} disabled={busy}>
            <Plus size={14} />
            Activar verificación en dos pasos
          </button>
        </div>
      )}

      {setupOpen && (
        <InlineReveal>
          <div className="security-totp-setup">
            {qrDataUrl && <img className="security-qr" src={qrDataUrl} alt="Código QR para configurar 2FA" />}
            <p className="security-setup-hint">
              Escaneá el código con tu app autenticadora, o cargá esta clave a mano:
            </p>
            <button type="button" className="security-secret" onClick={() => copyToClipboard(secret, 'Clave')}>
              <span>{secret}</span>
              <Copy size={13} />
            </button>
            <form className="security-inline-form" onSubmit={confirmSetup}>
              <input
                className="security-inline-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Código de 6 dígitos"
                inputMode="numeric"
                maxLength={6}
              />
              <div className="security-inline-actions">
                <button
                  type="button"
                  className="security-btn-ghost"
                  onClick={() => {
                    setSetupOpen(false)
                    setCode('')
                  }}
                  disabled={busy}
                >
                  Cancelar
                </button>
                <button type="submit" className="security-btn-primary" disabled={busy}>
                  {busy ? 'Verificando…' : 'Confirmar'}
                </button>
              </div>
            </form>
          </div>
        </InlineReveal>
      )}

      {totpEnabled && (
        <>
          <div className="settings-divider" />
          <div className="security-inline-actions security-inline-actions--wrap">
            <button type="button" className="security-btn-ghost" onClick={() => setRegenOpen((v) => !v)}>
              <RotateCcw size={14} />
              Regenerar códigos de respaldo
            </button>
            <button type="button" className="security-btn-danger" onClick={() => setDisableOpen((v) => !v)}>
              <ShieldOff size={14} />
              Desactivar
            </button>
          </div>
          {regenOpen && (
            <InlineReveal>
              <form className="security-inline-form" onSubmit={handleRegenerate}>
                <input
                  className="security-inline-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Confirmá tu contraseña"
                  autoComplete="current-password"
                />
                <div className="security-inline-actions">
                  <button type="button" className="security-btn-ghost" onClick={() => setRegenOpen(false)} disabled={busy}>
                    Cancelar
                  </button>
                  <button type="submit" className="security-btn-primary" disabled={busy}>
                    {busy ? 'Verificando…' : 'Regenerar'}
                  </button>
                </div>
              </form>
            </InlineReveal>
          )}
          {disableOpen && (
            <InlineReveal>
              <form className="security-inline-form" onSubmit={handleDisable}>
                <input
                  className="security-inline-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Confirmá tu contraseña"
                  autoComplete="current-password"
                />
                <div className="security-inline-actions">
                  <button type="button" className="security-btn-ghost" onClick={() => setDisableOpen(false)} disabled={busy}>
                    Cancelar
                  </button>
                  <button type="submit" className="security-btn-danger" disabled={busy}>
                    {busy ? 'Verificando…' : 'Desactivar 2FA'}
                  </button>
                </div>
              </form>
            </InlineReveal>
          )}
        </>
      )}
    </section>
  )
}

// --- Sesiones activas ----------------------------------------------------

function SessionsSection() {
  const sessions = useSecurityStore((s) => s.sessions)
  const sessionsLoading = useSecurityStore((s) => s.sessionsLoading)
  const fetchSessions = useSecurityStore((s) => s.fetchSessions)
  const revokeSession = useSecurityStore((s) => s.revokeSession)
  const revokeOtherSessions = useSecurityStore((s) => s.revokeOtherSessions)

  useEffect(() => {
    void fetchSessions()
    // Solo al montar — el usuario puede refrescar reabriendo la sección de
    // Ajustes; no hace falta poll continuo para una lista que cambia poco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const others = sessions.filter((s) => !s.isCurrent)

  return (
    <section className="settings-group security-group">
      <div className="settings-row-item">
        <div className="settings-row-icon">
          <MonitorSmartphone size={16} />
        </div>
        <div className="settings-row-text">
          <span className="settings-row-title">Sesiones activas</span>
          <span className="settings-row-desc">Dónde iniciaste sesión con tu cuenta — cerrá las que no reconozcas.</span>
        </div>
      </div>

      {sessionsLoading && sessions.length === 0 && <p className="security-setup-hint">Cargando…</p>}

      {sessions.length > 0 && (
        <ul className="security-list">
          <AnimatePresence initial={false}>
            {sessions.map((s, index) => (
              <motion.li
                key={s.id}
                className="security-list-item"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: EASE_OUT, delay: Math.min(index * 0.03, 0.2) }}
              >
                <div className="security-list-icon">
                  <Laptop size={15} />
                </div>
                <div className="security-list-text">
                  <span className="security-list-title">
                    {s.deviceName}
                    {s.isCurrent && <span className="security-badge">Esta sesión</span>}
                  </span>
                  <span className="security-list-meta">
                    {s.ip ? `${s.ip} · ` : ''}Activa {timeAgo(s.lastSeenAt)}
                  </span>
                </div>
                {!s.isCurrent && (
                  <motion.button
                    type="button"
                    className="security-list-action"
                    aria-label={`Cerrar sesión en ${s.deviceName}`}
                    whileTap={{ scale: 0.85 }}
                    onClick={async () => {
                      const ok = await revokeSession(s.id)
                      if (ok) toast.success('Sesión cerrada.')
                      else toast.error('No se pudo cerrar la sesión.')
                    }}
                  >
                    <X size={14} />
                  </motion.button>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {others.length > 0 && (
        <>
          <div className="settings-divider" />
          <div className="settings-row-item settings-row-item--action">
            <button
              type="button"
              className="security-btn-danger"
              onClick={async () => {
                const ok = await revokeOtherSessions()
                if (ok) toast.success('Se cerraron las demás sesiones.')
                else toast.error('No se pudo completar la acción.')
              }}
            >
              Cerrar todas las demás sesiones
            </button>
          </div>
        </>
      )}
    </section>
  )
}

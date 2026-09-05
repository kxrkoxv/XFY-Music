import { useEffect, useState, useMemo, useRef } from 'react'
import type { CSSProperties, Ref } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { HTMLMotionProps } from 'motion/react'
import { useCachedImageSrc } from '@shared/lib/useCachedImageSrc'
import { useInViewOnce } from '@shared/lib/useInViewOnce'
import { useBlurhashPlaceholder } from '@shared/lib/useBlurhashPlaceholder'
import { ensureBlurhash } from '@shared/lib/blurhashCache'
import { useArtworkStore } from '@features/player'
import { Music2 } from 'lucide-react'
import type { SongLike } from '@shared/lib/songIdentity'

/** Generative fallback color palette based on string hash to ensure deterministic colors per song. */
// El tipo tupla-con-resto garantiza índices definidos (string[], no
// string[] | undefined) bajo noUncheckedIndexedAccess.
const FALLBACK_COLORS: [string[], ...string[][]] = [
  ['#1a1035', '#6d28d9'],
  ['#0f2027', '#1a6b5e'],
  ['#1a0a2e', '#c026d3'],
  ['#0a1628', '#1d4ed8'],
  ['#1a1200', '#b45309'],
  ['#1a0000', '#be123c'],
  ['#0f1a0a', '#15803d'],
  ['#1a1510', '#92400e'],
]

function hashColor(str: string | undefined): string[] {
  if (!str) return FALLBACK_COLORS[0]
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffff
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0]
}

/** Generative gradient fallback with centered music icon. Fades/scales in on mount instead
 * of popping in abruptly, so it reads as a soft loading state rather than a layout glitch.
 * El tamaño NO va inline: cuando el uso tiene una clase de tamaño (p. ej.
 * .artist-song-art de 44px), esa clase manda — el 100%/100% inline anterior la
 * pisaba y el fallback se desbordaba como un rectángulo gigante dentro de la
 * card. Solo los usos SIN clase (hero envuelto en .artist-hero-art, portadas
 * de playlist, etc.) reciben el fill 100%/100% inline. */
interface ImgFallbackProps {
  title?: string
  className?: string
  style?: CSSProperties
  reduceMotion: boolean | null
  innerRef?: Ref<HTMLDivElement>
}

function ImgFallback({ title, className, style, reduceMotion, innerRef }: ImgFallbackProps) {
  const [dark, light] = useMemo(() => hashColor(title), [title])
  return (
    <motion.div
      ref={innerRef}
      className={`cached-img-fallback ${className || ''}`}
      initial={reduceMotion ? undefined : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      style={{
        background: `linear-gradient(135deg, ${dark}, ${light})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...(className ? {} : { width: '100%', height: '100%' }),
        ...style,
      }}
    >
      <Music2 size="35%" color="rgba(255,255,255,0.35)" strokeWidth={1.5} />
    </motion.div>
  )
}

// `song`: si se pasa (con id/title/artist), CachedImg pide la portada en
// Apple Music en cuanto se monta y la usa apenas resuelve, mostrando
// mientras tanto song.albumArtUrl (típicamente el thumbnail de YT Music)
// como placeholder instantáneo. `src` sigue funcionando solo, sin Apple,
// para los casos que no son canciones (avatares de artista, etc.).
type CachedImgProps = Omit<HTMLMotionProps<'img'>, 'src' | 'alt' | 'className' | 'title'> & {
  src?: string | null
  song?: SongLike
  alt?: string
  className?: string
  title?: string
}

export default function CachedImg({ src, song, alt = '', className, title, style: restStyle, ...rest }: CachedImgProps) {
  const resolve = useArtworkStore((s) => s.resolve)
  const artworkFor = useArtworkStore((s) => s.getArtwork)
  const resolvedArtwork = useArtworkStore((s) => (song ? s.artwork[String(song.id)] : undefined))
  const reduceMotion = useReducedMotion()

  // En listas largas sin virtualizar (playlists de cientos de canciones)
  // TODAS las filas montan de una — sin este gate, cada CachedImg dispara
  // su resolve() a la cola global de Apple (espaciada a 350ms/req) y su
  // propio fetch de caché apenas se monta, sin importar si la fila está
  // en pantalla o a 200 canciones de distancia. Resultado: la cola de
  // Apple tarda minutos en vaciarse y cientos de fetches simultáneos
  // pisan el límite de conexiones concurrentes del navegador — las
  // portadas "empiezan a cargar y se cortan". rootMargin generoso
  // (600px) precarga lo que está por entrar sin esperar a que se vea.
  const [containerRef, inView] = useInViewOnce<HTMLElement>()

  const songId = song?.id
  useEffect(() => {
    if (songId && inView) resolve({ id: songId, title: song?.title, artist: song?.artist, albumArtUrl: song?.albumArtUrl })
  }, [songId, inView, resolve, song?.title, song?.artist, song?.albumArtUrl])

  const artworkSrc = useMemo(() => (song ? artworkFor(song) : src), [song, src, artworkFor])
  const finalSrc = inView ? artworkSrc : null
  const resolvedSrc = useCachedImageSrc(finalSrc)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Si esta portada ya se vio antes, tenemos su blurhash cacheado (string
  // chiquito, ~20-30 chars) y lo pintamos como background-image DEL PROPIO
  // <img> — un <img> pinta su contenido real por encima de su propio CSS
  // background una vez decodifica, así que no hace falta ningún wrapper ni
  // capa aparte: se ve borroso-pero-parecido desde el frame 1 y la foto
  // nítida aparece encima apenas está lista, sin el fade genérico.
  const blurPlaceholder = useBlurhashPlaceholder(finalSrc)

  const prevFinalSrcRef = useRef(finalSrc)
  useEffect(() => {
    if (prevFinalSrcRef.current !== finalSrc) {
      setFailed(false)
      setLoaded(false)
      prevFinalSrcRef.current = finalSrc
    }
  }, [finalSrc])

  const prevResolvedArtworkRef = useRef(resolvedArtwork)
  useEffect(() => {
    if (prevResolvedArtworkRef.current !== resolvedArtwork && resolvedArtwork) {
      setFailed(false)
      prevResolvedArtworkRef.current = resolvedArtwork
    }
  }, [resolvedArtwork])

  if (!finalSrc || failed) {
    return (
      <ImgFallback
        title={title || alt}
        className={className}
        reduceMotion={reduceMotion}
        innerRef={containerRef as Ref<HTMLDivElement>}
      />
    )
  }

  return (
    <motion.img
      ref={containerRef as Ref<HTMLImageElement>}
      key={resolvedSrc || finalSrc}
      src={resolvedSrc || finalSrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        setLoaded(true)
        const target = e.currentTarget
        // Fire-and-forget: calcula el blurhash para la próxima vez que se
        // vea esta portada. No bloquea nada ni afecta el render actual.
        void ensureBlurhash(finalSrc, target)
      }}
      initial={reduceMotion || blurPlaceholder ? undefined : { opacity: 0 }}
      animate={{ opacity: reduceMotion || blurPlaceholder ? 1 : loaded ? 1 : 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      style={{
        ...(blurPlaceholder
          ? { backgroundImage: `url("${blurPlaceholder}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : {}),
        ...restStyle,
      }}
      {...rest}
    />
  )
}

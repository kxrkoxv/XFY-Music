/**
 * Conexión a Neon (Postgres serverless) vía HTTP — sin pooling manual,
 * cada query es un fetch HTTP normal, apto para funciones serverless
 * que viven milisegundos. `sql` es un tagged template: sql`select 1`.
 */
import { neon } from '@neondatabase/serverless'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('Falta la variable de entorno DATABASE_URL (conexión a Neon).')
}

export const sql = neon(connectionString)

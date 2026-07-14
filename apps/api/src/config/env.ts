import { z } from 'zod'

/**
 * Environment parsing. Runs once at boot and throws — a misconfigured API must
 * fail to start, not fail on the first request that touches the bad value.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    CORS_ORIGINS: z.string().default(''),

    // §7.2
    JWT_SECRET: z.string().default(''),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    // §7.5
    SESSION_STORE: z.enum(['postgres', 'memory']).default('postgres'),
    SESSION_IDLE_TTL_STAFF_SECONDS: z.coerce.number().int().positive().default(1800),
    SESSION_IDLE_TTL_ADMIN_SECONDS: z.coerce.number().int().positive().default(7200),
  })
  .superRefine((env, ctx) => {
    const isProd = env.NODE_ENV === 'production'

    // A weak or absent signing secret is a total auth bypass. Outside
    // production a dev default is fine; inside it, never.
    if (isProd && env.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be at least 32 characters in production',
      })
    }

    // The memory store is per-process. Behind two API instances a user would
    // appear logged out on every other request, and a restart would drop every
    // session. This is exactly how it reaches production, so refuse to boot.
    if (isProd && env.SESSION_STORE === 'memory') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_STORE'],
        message: 'SESSION_STORE=memory is not permitted in production; use postgres',
      })
    }
  })

export type Config = Readonly<
  z.infer<typeof schema> & {
    isProduction: boolean
    isTest: boolean
    corsOrigins: string[]
  }
>

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${details}`)
  }

  const env = parsed.data
  return Object.freeze({
    ...env,
    // A dev-only fallback so `npm run dev` works from a bare checkout. The
    // superRefine above guarantees this branch is unreachable in production.
    JWT_SECRET: env.JWT_SECRET || 'dev-only-insecure-secret-do-not-use-in-production',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  })
}

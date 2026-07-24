import { z } from 'zod'

/**
 * Environment parsing. Runs once at boot and throws — a misconfigured API must
 * fail to start, not fail on the first request that touches the bad value.
 */
/**
 * True when a connection string still carries the template's stand-in values.
 *
 * Matched as whole words so a real password that merely contains "password",
 * or a genuine host in a region literally named something with REGION in it,
 * is not rejected.
 */
function hasPlaceholder(url: string): boolean {
  return /\b(PROJECT_REF|PASSWORD|REGION)\b/.test(url)
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // A bare non-empty check let a typo'd or half-substituted URL through and
    // surface as an opaque Prisma connection failure at boot. Check the scheme,
    // then check for the .env.example placeholders — copying the template over
    // a working .env produces a URL that is perfectly well-formed and points at
    // a host that does not exist, so the only symptom is "can't reach database
    // server at aws-0-REGION.pooler.supabase.com". Naming the real cause here
    // saves the wild goose chase.
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((u) => /^postgres(ql)?:\/\//.test(u), {
        message: 'DATABASE_URL must be a postgresql:// connection string',
      })
      .refine((u) => !hasPlaceholder(u), {
        message:
          'DATABASE_URL still contains the .env.example placeholders ' +
          '(PROJECT_REF / PASSWORD / REGION). Fill in a real connection string — ' +
          'copying .env.example over a working .env is the usual way this happens',
      }),

    /**
     * The direct (non-pooled) connection, for Prisma Migrate.
     *
     * Optional on purpose. The running API never opens it — only the Prisma
     * CLI does, reading it straight from .env via the datasource's `directUrl`.
     * Requiring it here would make every test supply a URL that nothing
     * connects to, and would couple booting the server to a migration concern.
     * Validated when present so a typo is still caught early.
     */
    DIRECT_URL: z
      .string()
      .refine((u) => u === '' || /^postgres(ql)?:\/\//.test(u), {
        message: 'DIRECT_URL must be a postgresql:// connection string',
      })
      .optional(),

    CORS_ORIGINS: z.string().default(''),

    // §7.2
    JWT_SECRET: z.string().default(''),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    // §7.5
    SESSION_STORE: z.enum(['postgres', 'memory']).default('postgres'),
    SESSION_IDLE_TTL_STAFF_SECONDS: z.coerce.number().int().positive().default(1800),
    SESSION_IDLE_TTL_ADMIN_SECONDS: z.coerce.number().int().positive().default(7200),

    /**
     * SMTP, for password-reset code delivery. All optional: when SMTP_HOST is
     * unset the API falls back to the dev file sink (development) or refuses to
     * deliver (production), exactly as before this existed — so no environment
     * that was working stops working by omission.
     */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    // Implicit TLS from the first byte (port 465). Leave false for STARTTLS on
    // 587, which is what most providers and every test inbox use.
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    // The From: address. Required alongside a host — see superRefine.
    SMTP_FROM: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const isProd = env.NODE_ENV === 'production'
    // Only the test runner may fall back to a built-in secret. Everything else
    // must be explicit — see below.
    const isTest = env.NODE_ENV === 'test'

    /**
     * A weak or absent signing secret is a total auth bypass, so this is
     * checked everywhere except tests — not just in production.
     *
     * Gating it on NODE_ENV === 'production' was the trap: NODE_ENV defaults to
     * 'development', and forgetting to set it in a container is one of the most
     * common deployment mistakes there is. The result was an internet-facing API
     * signing sessions with a constant committed to this repository, while also
     * permitting the in-memory session store and sending refresh cookies without
     * the Secure flag. Every one of those is silent.
     *
     * Failing to boot is the correct outcome: a missing secret is a
     * configuration error, and there is no safe value to guess.
     */
    if (!isTest && env.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message:
          'JWT_SECRET must be set and at least 32 characters. Generate one with:\n' +
          "    node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
      })
    }

    // Length is not entropy: 32 identical characters passes a length check and
    // is trivially guessable. Catch the degenerate cases rather than pretend to
    // measure entropy properly.
    if (!isTest && env.JWT_SECRET.length >= 32 && new Set(env.JWT_SECRET).size < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is long but has too little variety to be a real secret',
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

    // A transport with a host but no From: address fails at send time with a
    // cryptic "no recipients"/"envelope from" error. Catch it at boot, where the
    // fix is obvious, rather than on a user's password-reset attempt.
    if (env.SMTP_HOST && !env.SMTP_FROM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_FROM'],
        message: 'SMTP_FROM is required when SMTP_HOST is set (the From: address for reset emails)',
      })
    }
  })

/** The parsed SMTP settings, present only when a host was configured. */
export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  from: string
  auth?: { user: string; pass: string }
}

export type Config = Readonly<
  z.infer<typeof schema> & {
    isProduction: boolean
    isTest: boolean
    corsOrigins: string[]
    /** Present when SMTP_HOST is configured; the signal to use email delivery. */
    smtp?: SmtpConfig
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

  // Assembled once here so the rest of the app asks `config.smtp ?` and never
  // re-derives "is email configured" from three separate raw fields. Auth is
  // included only when both a user and a password are present — an authless
  // relay (a local MailHog, some internal gateways) is legitimate.
  const smtp: SmtpConfig | undefined = env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        // superRefine guarantees SMTP_FROM when SMTP_HOST is set.
        from: env.SMTP_FROM as string,
        ...(env.SMTP_USER && env.SMTP_PASSWORD
          ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
          : {}),
      }
    : undefined

  return Object.freeze({
    ...env,
    // Test-only fallback, so unit tests need not invent a secret. Every other
    // environment is required by superRefine to supply a real one, so this
    // cannot silently sign production sessions with a published constant.
    JWT_SECRET: env.JWT_SECRET || 'test-only-secret-never-used-outside-vitest-runs',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    ...(smtp ? { smtp } : {}),
  })
}

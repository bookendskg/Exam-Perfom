import { Prisma, type PrismaClient } from '@prisma/client'
import { currentScope, handWrittenFilterReason, TenantContextError } from './tenant-context.js'

/**
 * Tenant isolation, enforced in one place (SaaS §2.4).
 *
 * Every tenant-scoped read gets `WHERE tenant_id = <current>` injected, and
 * every write is checked to be writing where it claims to. This is the whole
 * reason ~190 unmodified Prisma call sites are safe: the guard is not at any of
 * them, it is under all of them.
 *
 * ---------------------------------------------------------------------------
 * Reads are filtered; writes are only VERIFIED, not stamped.
 *
 * Prisma's generated `create` inputs make tenantId required, so a create cannot
 * omit it and still typecheck. Rather than fight that with casts, we lean on
 * it: the compiler forces every create to name a tenant, and this extension
 * asserts the named tenant is the ambient one. Compiler catches the omission,
 * runtime catches the mismatch. Silently overwriting a supplied tenantId would
 * be worse — it would turn "wrote to the wrong tenant" into a bug with no
 * symptom at all.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * Raw SQL fails CLOSED — see guardRawQuery below.
 *
 * An earlier version of this comment read: "raw SQL ($queryRaw) is currently
 * unguarded and must carry its own tenant filter by hand — see employee-code.ts,
 * exam-code.ts, question-selection.ts."
 *
 * Two of those three did. question-selection.ts never had a tenant predicate at
 * all, and leaked one customer's question bank into another customer's exams.
 * The comment asserting it was handled is a large part of why that survived
 * review: it read as a checklist someone had already ticked.
 *
 * So the rule is no longer "remember to filter". Raw SQL is refused unless the
 * author signs for it with withHandWrittenTenantFilter(), which puts the claim
 * in the diff where a reviewer can check it against the SQL. Do not weaken this
 * back into a comment.
 * ---------------------------------------------------------------------------
 */

/**
 * Derived from the schema, never hand-listed: any model with a `tenantId` field
 * is tenant-scoped. A hardcoded list is a list that goes stale the first time
 * someone adds a model and forgets to update it — and the failure mode of that
 * omission is an unscoped table, which is the exact bug this file exists to
 * prevent.
 */
const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'tenantId'))
    .map((model) => model.name)
)

/** Operations whose `where` should be narrowed to the current tenant. */
const FILTERED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
])

/** Operations that write new rows and must declare a tenant. */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn'])

/**
 * Wraps a client so every tenant-scoped query is guarded.
 *
 * Returns `T` — the same type it was given — via a cast. The cast is deliberate
 * and, unusually, honest: `$extends` changes only *behaviour*, not the surface.
 * Every model and method is still there with the same signature, so callers
 * typed against PrismaClient are not being told a lie about what they can call.
 *
 * The alternative was propagating a distinct ScopedPrismaClient type through
 * ~15 service files, which buys nothing: a service cannot meaningfully choose
 * between a scoped and unscoped client — there is only ever the scoped one.
 */
export function withTenantScope<T extends PrismaClient>(prisma: T): T {
  return prisma.$extends({
    name: 'tenantScope',
    query: {
      /**
       * CLIENT-LEVEL, not nested under $allModels. That one word is the
       * difference between seeing raw SQL and not:
       *
       *   $allModels hook sees:   ["Plan.findMany"]
       *   client-level hook sees: ["Plan.findMany", "<raw>.$queryRawUnsafe"]
       *
       * Nested under $allModels, $queryRaw is invisible — a raw query against a
       * tenant table sailed through completely unguarded. That is not
       * hypothetical: question-selection.ts shipped with no tenant predicate and
       * leaked one customer's question bank into another's exams.
       *
       * Here, raw SQL fails CLOSED. It must be acknowledged by
       * withHandWrittenTenantFilter(), which is a reviewable claim rather than
       * silence.
       */
      async $allOperations({ model, operation, args, query }) {
        // Raw SQL: no model, and nothing here can inspect the statement.
        if (!model) return guardRawQuery(operation, args, query)

        if (!TENANT_SCOPED_MODELS.has(model)) return query(args)

        const scope = currentScope()

        // Fail closed. An unscoped query against a tenant table is not a thing
        // to allow "just this once" — if it were legitimate it would have said
        // runAsPlatform().
        if (!scope) {
          throw new TenantContextError(
            `${model}.${operation} ran with no tenant context. ` +
              `Wrap it in runInTenant(), or runAsPlatform("<reason>") if it is genuinely platform work.`
          )
        }

        if (scope.kind === 'platform') return query(args)

        const { tenantId } = scope
        const typed = (args ?? {}) as Record<string, unknown>

        if (FILTERED_OPERATIONS.has(operation)) {
          typed['where'] = { ...((typed['where'] as object) ?? {}), tenantId }
          return query(typed)
        }

        if (CREATE_OPERATIONS.has(operation)) {
          assertWriteTenant(model, operation, typed['data'], tenantId)
          return query(typed)
        }

        if (operation === 'upsert') {
          typed['where'] = { ...((typed['where'] as object) ?? {}), tenantId }
          assertWriteTenant(model, operation, typed['create'], tenantId)
          return query(typed)
        }

        // An operation we have not classified. Refuse rather than wave it
        // through: a new Prisma verb should fail loudly here once, not leak
        // quietly forever.
        throw new TenantContextError(
          `${model}.${operation} is not handled by the tenant extension; refusing to run it unscoped.`
        )
      },
    },
  }) as unknown as T
}

/**
 * Raw SQL, which this guard is structurally unable to inspect.
 *
 * It cannot parse the statement, so it cannot know whether the query filters by
 * tenant. The only honest options are to refuse it, or to demand that the author
 * says out loud that they filtered. It does both: refuse by default, accept a
 * signed statement via withHandWrittenTenantFilter().
 *
 * This is the guard that did not exist when question-selection.ts leaked one
 * tenant's question bank into another tenant's exams.
 */
function guardRawQuery(
  operation: string,
  args: unknown,
  query: (args: unknown) => Promise<unknown>
): Promise<unknown> {
  const scope = currentScope()

  // Platform work is unscoped by definition, and raw is no different.
  if (scope?.kind === 'platform') return query(args)

  // The author has stated the query carries its own tenant_id predicate.
  if (handWrittenFilterReason()) return query(args)

  // Outside any scope at all — boot checks, migrations, the seed, test
  // fixtures. Those legitimately use the RAW client, which never reaches this
  // extension; anything arriving here without a scope came through the scoped
  // client and is a mistake worth surfacing.
  throw new TenantContextError(
    `Raw SQL (${operation}) cannot be tenant-guarded automatically — this extension cannot read your statement.\n` +
      `If the query filters by tenant_id itself, wrap it in withHandWrittenTenantFilter("<why>", ...).\n` +
      `If it is genuinely platform-wide, use runAsPlatform("<why>", ...).\n` +
      `If neither is true, it is a cross-tenant leak: use the query builder instead.`
  )
}

/**
 * Rejects a write that names a tenant other than the ambient one.
 *
 * The missing case is a bug too, but it is one the compiler already refuses to
 * emit — so if it shows up at runtime it came from an `as any` somewhere, and
 * that is worth an error rather than a silent fix-up.
 */
function assertWriteTenant(
  model: string,
  operation: string,
  data: unknown,
  tenantId: string
): void {
  const rows = Array.isArray(data) ? data : [data]

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const declared = (row as Record<string, unknown>)['tenantId']

    if (declared === undefined) {
      // A nested `tenant: { connect: ... }` is the other legal shape; let it
      // through rather than guess, since it cannot be compared without
      // resolving the connect.
      if ('tenant' in row) continue
      throw new TenantContextError(
        `${model}.${operation} did not declare a tenantId. Pass tenantId: currentTenantId().`
      )
    }

    if (declared !== tenantId) {
      throw new TenantContextError(
        `${model}.${operation} tried to write to tenant ${String(declared)} ` +
          `while scoped to ${tenantId}. Refusing.`
      )
    }
  }
}

/** The set of models this extension guards. Exported for the isolation tests. */
export function tenantScopedModels(): ReadonlySet<string> {
  return TENANT_SCOPED_MODELS
}

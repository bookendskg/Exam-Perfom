import type { PrismaClient } from '@bookends/db'
import { defaultStaffPassword, hashPassword, type Scope } from '@bookends/core'
import type { ZodError } from 'zod'
import type { Principal } from '../../infra/session-store/index.js'
import { assertCreateInScope } from '../../rbac/scope.js'
import { claimEmployeeCode } from '../employee-code.js'
import type { RawRow } from '../../bulk-import/parse.js'
import { importRowSchema, loadOrgLookup, resolveOrgRefs, type RowError } from './row.js'

/** §8.3's required columns. */
export const EMPLOYEE_IMPORT_COLUMNS = [
  'first_name',
  'last_name',
  'phone',
  'outlet_code',
  'department',
  'designation',
  'joining_date',
] as const

export interface RowResult {
  lineNumber: number
  /** Present once the row is valid enough to identify a person. */
  name?: string
  phone?: string
  employeeCode?: string
  temporaryPassword?: string
  errors: RowError[]
}

export interface ImportReport {
  dryRun: boolean
  totalRows: number
  valid: number
  invalid: number
  imported: number
  rows: RowResult[]
}

/**
 * §8.3 bulk import.
 *
 * The flow the spec asks for: validate ALL rows first, show a preview with
 * errors, then allow a partial import that skips the bad rows and reports what
 * happened. Validation never short-circuits — an operator uploading 300 staff
 * needs every problem in one pass, not the first one.
 */
export class BulkImportService {
  constructor(private readonly prisma: PrismaClient) {}

  async run(
    principal: Principal,
    scope: Scope,
    rows: RawRow[],
    options: { dryRun: boolean }
  ): Promise<ImportReport> {
    const lookup = await loadOrgLookup(this.prisma)

    // Phone is the login identifier and must be unique. Two sources of
    // collision: rows against the database, and rows against each other — the
    // second is invisible to a per-row DB check, since neither is inserted yet.
    const phones = rows.map((r) => String(r.values['phone'] ?? '').trim()).filter(Boolean)
    const taken = new Set(
      (
        await this.prisma.user.findMany({
          where: { phone: { in: phones } },
          select: { phone: true },
        })
      ).map((u) => u.phone)
    )

    const seenInFile = new Map<string, number>()

    const results: RowResult[] = []
    const importable: Array<{ result: RowResult; data: PreparedRow }> = []

    for (const raw of rows) {
      const result: RowResult = { lineNumber: raw.lineNumber, errors: [] }

      const parsed = importRowSchema.safeParse(raw.values)
      if (!parsed.success) {
        result.errors.push(...zodRowErrors(parsed.error))
        // Still surface who the row was about, if legible, so the operator can
        // find it in their spreadsheet.
        result.name = joinName(raw.values)
        result.phone = String(raw.values['phone'] ?? '').trim() || undefined
        results.push(result)
        continue
      }

      const row = parsed.data
      result.name = `${row.first_name} ${row.last_name}`
      result.phone = row.phone

      if (taken.has(row.phone)) {
        result.errors.push({ field: 'phone', message: 'Already registered' })
      }

      const firstSeenAt = seenInFile.get(row.phone)
      if (firstSeenAt !== undefined) {
        result.errors.push({
          field: 'phone',
          message: `Duplicated in this file (also on row ${firstSeenAt})`,
        })
      } else {
        seenInFile.set(row.phone, raw.lineNumber)
      }

      const { resolved, errors } = resolveOrgRefs(row, lookup)
      result.errors.push(...errors)

      if (resolved) {
        // An outlet_manager may only import into an outlet they manage.
        // Reported as a row error rather than thrown, so one out-of-scope row
        // does not reject the whole file.
        try {
          assertCreateInScope(scope, principal, { outletId: resolved.outletId })
        } catch {
          result.errors.push({
            field: 'outlet_code',
            message: 'You do not manage this outlet',
          })
        }
      }

      results.push(result)
      if (result.errors.length === 0 && resolved) {
        importable.push({ result, data: { row, ...resolved } })
      }
    }

    const report: ImportReport = {
      dryRun: options.dryRun,
      totalRows: rows.length,
      valid: importable.length,
      invalid: results.length - importable.length,
      imported: 0,
      rows: results,
    }

    if (options.dryRun) return report

    for (const { result, data } of importable) {
      try {
        const created = await this.insertOne(principal, data)
        result.employeeCode = created.employeeCode
        result.temporaryPassword = created.temporaryPassword
        report.imported++
      } catch (err) {
        // §8.3 allows partial import: a row that fails at insert (a phone
        // registered by a concurrent request, say) is reported, not fatal.
        result.errors.push({
          field: 'row',
          message: err instanceof Error ? err.message : 'Failed to import',
        })
        report.valid--
        report.invalid++
      }
    }

    return report
  }

  /** Each row gets its own transaction so one failure cannot roll back the batch. */
  private async insertOne(principal: Principal, prepared: PreparedRow) {
    const { row, outletId, departmentId, designationId } = prepared

    // §7.3 default: last 4 digits + "book". New hires are staff (§3.3), so the
    // staff policy applies and this default is valid for them.
    const temporaryPassword = defaultStaffPassword(row.phone)
    const passwordHash = await hashPassword(temporaryPassword)

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: principal.tenantId,
          phone: row.phone,
          email: row.email || null,
          role: 'staff',
          passwordHash,
          mustChangePassword: true,
        },
      })

      const employeeCode = await claimEmployeeCode(tx, principal.tenantId, outletId)

      const employee = await tx.employee.create({
        data: {
          tenantId: principal.tenantId,
          userId: user.id,
          employeeCode,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          email: row.email || null,
          dateOfBirth: row.date_of_birth ? new Date(row.date_of_birth) : null,
          gender: row.gender || null,
          address: row.address || null,
          city: row.city || null,
          state: row.state || null,
          outletId,
          departmentId,
          designationId,
          joiningDate: new Date(row.joining_date),
          employmentType: row.employment_type || 'full_time',
          preferredLanguage: row.preferred_language,
          emergencyContactName: row.emergency_contact_name || null,
          emergencyContactPhone: row.emergency_contact_phone || null,
          emergencyContactRelation: row.emergency_contact_relation || null,
          createdById: principal.userId,
        },
        select: { id: true, employeeCode: true },
      })

      await tx.employeeTimeline.create({
        data: {
          tenantId: principal.tenantId,
          employeeId: employee.id,
          eventType: 'joined',
          eventDate: new Date(row.joining_date),
          // Was "Joined Bookends" — see employee.service.ts.
          title: 'Joined',
          description: 'Created via bulk import',
          createdById: principal.userId,
        },
      })

      return { employeeCode: employee.employeeCode ?? undefined, temporaryPassword }
    })
  }
}

interface PreparedRow {
  row: ReturnType<typeof importRowSchema.parse>
  outletId: string
  departmentId: string
  designationId: string
}

function zodRowErrors(error: ZodError): RowError[] {
  return error.issues.map((i) => ({
    field: i.path.join('.') || 'row',
    message: i.message,
  }))
}

function joinName(values: Record<string, string>): string | undefined {
  const name = `${values['first_name'] ?? ''} ${values['last_name'] ?? ''}`.trim()
  return name || undefined
}

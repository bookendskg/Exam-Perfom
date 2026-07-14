import { z } from 'zod'
import type { PrismaClient } from '@bookends/db'

/**
 * §8.3's CSV columns reference outlets, departments and designations by
 * human-readable code or name, not UUID — the file comes out of a spreadsheet,
 * not the API. This module resolves those to ids and reports per-row failures.
 */
export const importRowSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(100),
  last_name: z.string().trim().min(1, 'Last name is required').max(100),
  phone: z
    .string()
    .trim()
    .min(6, 'Phone number is required')
    .max(15, 'Phone number is too long')
    // Spreadsheets mangle phone numbers into numbers and scientific notation.
    .refine((v) => !v.includes('e+') && !v.includes('E+'), {
      message: 'Phone looks like a number in scientific notation — format the column as Text',
    }),
  outlet_code: z.string().trim().min(1, 'Outlet code is required'),
  department: z.string().trim().min(1, 'Department is required'),
  designation: z.string().trim().min(1, 'Designation is required'),
  joining_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Joining date must be YYYY-MM-DD')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid date'),

  // Optional (§8.1)
  email: z.union([z.string().trim().email('Not a valid email'), z.literal('')]).optional(),
  preferred_language: z
    .union([z.enum(['en', 'hi', 'gu']), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? 'en' : v)),
  gender: z.union([z.enum(['male', 'female', 'other']), z.literal('')]).optional(),
  date_of_birth: z
    .union([
      z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD'),
      z.literal(''),
    ])
    .optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  address: z.string().trim().max(1000).optional(),
  employment_type: z
    .union([z.enum(['full_time', 'part_time', 'contract', 'trainee']), z.literal('')])
    .optional(),
  emergency_contact_name: z.string().trim().max(200).optional(),
  emergency_contact_phone: z.string().trim().max(15).optional(),
  emergency_contact_relation: z.string().trim().max(50).optional(),
})

export type ImportRow = z.infer<typeof importRowSchema>

/** Lookup tables built once per import rather than per row. */
export interface OrgLookup {
  outletsByCode: Map<string, string>
  departmentsByKey: Map<string, string>
  designationsByKey: Map<string, { id: string; departmentId: string | null }>
}

export async function loadOrgLookup(prisma: PrismaClient): Promise<OrgLookup> {
  const [outlets, departments, designations] = await Promise.all([
    prisma.outlet.findMany({ where: { isActive: true }, select: { id: true, code: true } }),
    prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true },
    }),
    prisma.designation.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, departmentId: true },
    }),
  ])

  const key = (s: string) => s.trim().toLowerCase()

  // Matched on either code or name: the spreadsheet says "Kitchen" in one
  // column and someone else's says "KIT".
  const departmentsByKey = new Map<string, string>()
  for (const d of departments) {
    departmentsByKey.set(key(d.code), d.id)
    departmentsByKey.set(key(d.name), d.id)
  }

  const designationsByKey = new Map<string, { id: string; departmentId: string | null }>()
  for (const d of designations) {
    designationsByKey.set(key(d.code), { id: d.id, departmentId: d.departmentId })
    designationsByKey.set(key(d.name), { id: d.id, departmentId: d.departmentId })
  }

  return {
    outletsByCode: new Map(outlets.map((o) => [key(o.code), o.id])),
    departmentsByKey,
    designationsByKey,
  }
}

export interface RowError {
  field: string
  message: string
}

export interface ResolvedRow {
  outletId: string
  departmentId: string
  designationId: string
}

/**
 * Resolves a row's org references. Returns errors rather than throwing so a
 * single bad row does not abort the whole file — §8.3 requires partial import.
 */
export function resolveOrgRefs(
  row: ImportRow,
  lookup: OrgLookup
): { resolved?: ResolvedRow; errors: RowError[] } {
  const errors: RowError[] = []
  const key = (s: string) => s.trim().toLowerCase()

  const outletId = lookup.outletsByCode.get(key(row.outlet_code))
  if (!outletId) {
    errors.push({
      field: 'outlet_code',
      message: `Unknown outlet code "${row.outlet_code}". Expected one of: ${[...new Set(lookup.outletsByCode.keys())].join(', ').toUpperCase()}`,
    })
  }

  const departmentId = lookup.departmentsByKey.get(key(row.department))
  if (!departmentId) {
    errors.push({ field: 'department', message: `Unknown department "${row.department}"` })
  }

  const designation = lookup.designationsByKey.get(key(row.designation))
  if (!designation) {
    errors.push({ field: 'designation', message: `Unknown designation "${row.designation}"` })
  }

  // The same coherence check the JSON API applies: the FKs would happily accept
  // a Line Cook filed under Housekeeping, because each id is valid on its own.
  if (departmentId && designation?.departmentId && designation.departmentId !== departmentId) {
    errors.push({
      field: 'designation',
      message: `"${row.designation}" does not belong to the "${row.department}" department`,
    })
  }

  if (errors.length > 0 || !outletId || !departmentId || !designation) return { errors }
  return { resolved: { outletId, departmentId, designationId: designation.id }, errors: [] }
}

import { z } from 'zod'

/** §8.1 required + optional employee profile fields. */

const phone = z
  .string()
  .trim()
  .min(6, 'Phone number is required')
  .max(15, 'Phone number is too long')

/** Accepts YYYY-MM-DD; the DB columns are DATE, not timestamp. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid date')

export const createEmployeeSchema = z.object({
  // Required (§8.1)
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  phone,
  outletId: z.string().uuid('Must be a valid outlet id'),
  departmentId: z.string().uuid('Must be a valid department id'),
  designationId: z.string().uuid('Must be a valid designation id'),
  joiningDate: isoDate,
  preferredLanguage: z.enum(['en', 'hi', 'gu']),

  // Optional (§8.1)
  email: z.string().email('Must be a valid email').max(255).optional(),
  photoUrl: z.string().url().optional(),
  dateOfBirth: isoDate.optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  address: z.string().max(1000).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  emergencyContactName: z.string().max(200).optional(),
  emergencyContactPhone: phone.optional(),
  emergencyContactRelation: z.string().max(50).optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'trainee']).optional(),
  // §8.2: auto-generated when absent. Accepted so an existing code can be
  // carried over during onboarding from Manish's spreadsheets.
  employeeCode: z.string().max(20).optional(),
})

/**
 * Updates never touch outlet/department/designation via this route: moving
 * someone between outlets is a transfer, which §4.1 models as a timeline event
 * and which changes RBAC scope. It needs its own endpoint, not a silent PUT.
 */
export const updateEmployeeSchema = createEmployeeSchema
  .omit({ outletId: true, phone: true, employeeCode: true })
  .partial()

export const listEmployeesQuerySchema = z.object({
  outlet_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  status: z.enum(['active', 'on_leave', 'suspended', 'terminated', 'resigned']).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

/** §8.4 status transitions. */
export const changeStatusSchema = z.object({
  status: z.enum(['active', 'on_leave', 'suspended', 'terminated', 'resigned']),
  reason: z.string().trim().max(500).optional(),
})

export const employeeIdParamSchema = z.object({
  id: z.string().uuid('Must be a valid employee id'),
})

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>

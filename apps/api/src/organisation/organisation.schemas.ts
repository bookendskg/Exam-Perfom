import { z } from 'zod'

/** §9 outlets, departments and designations. */

/**
 * Codes are uppercased on the way in. They appear in employee codes
 * (BK-AK-001), so a lowercase "ak" would silently produce BK-ak-001 and break
 * §8.2's format.
 */
const code = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Code is required')
    .max(max, `Code must be at most ${max} characters`)
    .regex(/^[A-Za-z0-9]+$/, 'Code may contain only letters and numbers')
    .transform((v) => v.toUpperCase())

export const createOutletSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: code(10),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(15).optional(),
  email: z.string().trim().email('Not a valid email').max(255).optional(),
  managerId: z.string().uuid('Must be a valid user id').optional(),
})

/**
 * `code` is absent: changing an outlet's code would orphan every employee code
 * already issued under the old one (§8.2 codes are permanent). Renaming the
 * outlet is fine; recoding it is not.
 */
export const updateOutletSchema = createOutletSchema
  .omit({ code: true })
  .partial()
  .extend({
    isActive: z.boolean().optional(),
    // Explicit null clears the assignment; undefined leaves it untouched.
    managerId: z.string().uuid('Must be a valid user id').nullable().optional(),
    /**
     * Users assigned to cover this outlet (§3.1 — a trainer spans several).
     *
     * Declarative: the array replaces the whole set, so `[]` clears it and
     * omitting the field leaves it untouched. This is an authorisation grant,
     * not roster data — it gives `own_outlet` scope over an outlet the user does
     * not manage.
     */
    assignedUserIds: z
      .array(z.string().uuid('Must be a valid user id'))
      .max(100, 'Too many users for one outlet')
      .optional(),
  })

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: code(10),
  description: z.string().trim().max(1000).optional(),
})

export const updateDepartmentSchema = createDepartmentSchema
  .omit({ code: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })

export const createDesignationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: code(10),
  departmentId: z.string().uuid('Must be a valid department id').optional(),
  /** §9.3 hierarchy: 1 = entry, 5 = senior. Drives question targeting (§4.1). */
  level: z.coerce.number().int().min(1, 'Level must be 1-5').max(5, 'Level must be 1-5').default(1),
})

export const updateDesignationSchema = createDesignationSchema
  .omit({ code: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })

export const idParamSchema = z.object({ id: z.string().uuid('Must be a valid id') })

export const listQuerySchema = z.object({
  /** Inactive rows are hidden unless explicitly asked for. */
  include_inactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  department_id: z.string().uuid().optional(),
})

export type CreateOutletInput = z.infer<typeof createOutletSchema>
export type UpdateOutletInput = z.infer<typeof updateOutletSchema>
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>
export type CreateDesignationInput = z.infer<typeof createDesignationSchema>
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>
export type ListQuery = z.infer<typeof listQuerySchema>

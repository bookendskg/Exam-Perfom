import { z } from 'zod'

/**
 * Phone is the login identifier (§7.1). Kept permissive: staff records come
 * from Manish's spreadsheets and may carry country codes or spacing. The
 * database is what enforces uniqueness.
 */
const phone = z
  .string()
  .trim()
  .min(6, 'Phone number is required')
  .max(15, 'Phone number is too long')

export const loginSchema = z.object({
  phone,
  // No length rule here: rejecting a short password at the schema would tell an
  // attacker the policy before authentication, and legitimate short passwords
  // predate any policy change. The stored hash decides.
  password: z.string().min(1, 'Password is required'),
  deviceInfo: z
    .object({
      model: z.string().max(100).optional(),
      osVersion: z.string().max(50).optional(),
      appVersion: z.string().max(50).optional(),
    })
    .optional(),
})

export const refreshSchema = z.object({
  // Optional: the web app sends it as an HttpOnly cookie instead (§7.2).
  refreshToken: z.string().min(1).optional(),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  // Policy depends on the user's role, which is unknown until lookup — the
  // service applies validatePassword(newPassword, role) after loading the user.
  newPassword: z.string().min(1, 'New password is required'),
})

export const forgotPasswordSchema = z.object({ phone })

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(1, 'New password is required'),
})

export type LoginInput = z.infer<typeof loginSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

import type { EmploymentStatus, TimelineEventType } from '@bookends/db'
import { ApiError } from '../http/api-error.js'

/**
 * §8.4 employment status transitions:
 *
 *   active → on_leave → active
 *   active → suspended → active
 *   active → terminated (final)
 *   active → resigned (final)
 *
 * terminated and resigned are terminal — §8.4 marks both "(final)". Rehiring
 * someone is a new employee record, which also preserves §8.2's guarantee that
 * their old code is never reused.
 */
const ALLOWED: Record<EmploymentStatus, readonly EmploymentStatus[]> = {
  active: ['on_leave', 'suspended', 'terminated', 'resigned'],
  on_leave: ['active', 'terminated', 'resigned'],
  suspended: ['active', 'terminated', 'resigned'],
  terminated: [],
  resigned: [],
}

/** §8.4: terminated/resigned employees are soft-deleted — data retained, hidden from active lists. */
export const DEPARTED_STATUSES: readonly EmploymentStatus[] = ['terminated', 'resigned']

export function isDeparted(status: EmploymentStatus): boolean {
  return DEPARTED_STATUSES.includes(status)
}

export function canTransition(from: EmploymentStatus, to: EmploymentStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function assertTransition(from: EmploymentStatus, to: EmploymentStatus): void {
  if (from === to) {
    throw ApiError.validation(`Employee is already ${to}`, [
      { field: 'status', message: `Already ${to}` },
    ])
  }
  if (!canTransition(from, to)) {
    const allowed = ALLOWED[from]
    throw ApiError.validation(
      allowed.length === 0
        ? `An employee who is ${from} cannot change status; ${from} is final`
        : `Cannot change status from ${from} to ${to}`,
      [
        {
          field: 'status',
          message:
            allowed.length === 0
              ? `${from} is a final status`
              : `From ${from}, allowed statuses are: ${allowed.join(', ')}`,
        },
      ]
    )
  }
}

/** §4.1 timeline event type for a status change, so the history reads properly. */
export function timelineEventFor(to: EmploymentStatus): TimelineEventType {
  switch (to) {
    case 'suspended':
      return 'suspension'
    case 'resigned':
      return 'resignation'
    case 'terminated':
      return 'termination'
    case 'on_leave':
    case 'active':
      return 'remark'
  }
}

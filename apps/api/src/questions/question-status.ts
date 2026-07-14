import type { QuestionStatus } from '@bookends/db'
import { ApiError } from '../http/api-error.js'

/**
 * §10.2 question lifecycle:
 *
 *   Trainer/Manager creates → DRAFT
 *     → Admin reviews
 *       → APPROVED  (available for exam selection)
 *       → REJECTED with feedback (back to DRAFT so it can be fixed)
 *
 * §4.1's enum has no `rejected` value — it is draft | pending_review | approved
 * | archived. So a rejection returns the question to `draft`, and the reason
 * lives in question_reviews. That is a better fit anyway: a rejected question is
 * a draft that needs work, and a distinct terminal `rejected` state would need a
 * second transition to become editable again.
 */
const ALLOWED: Record<QuestionStatus, readonly QuestionStatus[]> = {
  draft: ['pending_review', 'archived'],
  pending_review: ['approved', 'draft', 'archived'],
  // §11.3 requires every exam question be APPROVED, so an approved question
  // going back to draft would silently invalidate exams already built on it.
  // Archive it instead: exams keep their reference, new ones cannot select it.
  approved: ['archived'],
  archived: ['draft'],
}

export function canTransition(from: QuestionStatus, to: QuestionStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function assertTransition(from: QuestionStatus, to: QuestionStatus): void {
  if (from === to) {
    throw ApiError.validation(`Question is already ${to}`, [
      { field: 'status', message: `Already ${to}` },
    ])
  }
  if (!canTransition(from, to)) {
    throw ApiError.validation(`Cannot move a question from ${from} to ${to}`, [
      {
        field: 'status',
        message:
          ALLOWED[from].length === 0
            ? `${from} is a final status`
            : `From ${from}, allowed statuses are: ${ALLOWED[from].join(', ')}`,
      },
    ])
  }
}

/**
 * An approved question is live: exams select from approved questions only
 * (§11.3), and editing one would silently change an exam already built on it —
 * or worse, one already sat. Archive, copy, edit the copy.
 */
export function assertEditable(status: QuestionStatus): void {
  if (status === 'approved') {
    throw ApiError.conflict('An approved question cannot be edited', [
      {
        field: 'status',
        message: 'Archive it and create a new version — exams may already reference this one',
      },
    ])
  }
}

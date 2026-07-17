import { useState } from 'react'
import { api, type Paged } from '../lib/api.js'
import { query, useApi } from '../lib/useApi.js'
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  Pager,
  Select,
  Spinner,
  Table,
} from '../components/ui.js'

/**
 * §13 training, §18 recommendations.
 *
 * The recommendations panel is the point. §1.2 says the exam is the input and
 * the performance record is the product — a weak topic that produces no action
 * is just a number, and this is the screen where a number becomes homework.
 *
 * The API proposes; a human assigns. That is §13's model, and it is why this
 * has an "Assign" button rather than an on/off switch.
 */

interface Assignment {
  id: string
  status: 'assigned' | 'in_progress' | 'completed' | 'overdue'
  dueDate: string | null
  completedAt: string | null
  isOverdue: boolean
  isAutoAssigned: boolean
  employee: { id: string; firstName: string; lastName: string }
  topic: { id: string; nameEn: string } | null
  sourceDocument: { id: string; title: string } | null
}

interface Recommendation {
  employeeId: string
  employeeName: string
  topicId: string
  percentage: number
  marksObtained: number
  marksAvailable: number
  topic: { id: string; nameEn: string }
  suggestedSourceDocumentId: string | null
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function Training() {
  const now = new Date()
  const [year, setYear] = useState(now.getUTCFullYear())
  const [month, setMonth] = useState(now.getUTCMonth() + 1)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<unknown>(null)

  const list = useApi<Paged<Assignment>>(`/training${query({ page, limit: 20, status })}`, [page, status])
  const recs = useApi<Recommendation[]>(`/training/recommendations${query({ year, month })}`, [year, month])

  const assign = async (r: Recommendation) => {
    setError(null)
    try {
      await api.post('/training', {
        employeeId: r.employeeId,
        topicId: r.topicId,
        ...(r.suggestedSourceDocumentId ? { sourceDocumentId: r.suggestedSourceDocumentId } : {}),
        reason: `Scored ${r.percentage.toFixed(0)}% on ${r.topic.nameEn} in ${MONTHS[month - 1]} ${year}`,
      })
      // Both change: the assignment appears in the list AND drops out of the
      // recommendations, because the API stops proposing what is already open.
      void recs.refetch()
      void list.refetch()
    } catch (err) {
      setError(err)
    }
  }

  const complete = async (id: string) => {
    setError(null)
    try {
      await api.post(`/training/${id}/complete`, {})
      void list.refetch()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Training</h1>
          <p className="text-sm text-ink-muted">
            {list.data ? `${list.data.meta.total} assignments` : ' '}
          </p>
        </div>
      </header>

      <ErrorNote error={error} />

      <Card
        title="Recommended"
        action={
          <div className="flex gap-2">
            <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="w-32">
              {MONTHS.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </Select>
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-24">
              {[year - 1, year].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        <ErrorNote error={recs.error} />
        {recs.loading && !recs.data ? (
          <Spinner />
        ) : !recs.data?.length ? (
          <Empty
            title="Nothing to recommend"
            hint="Recommendations come from graded exams. Nobody scored below the threshold this month."
          />
        ) : (
          <Table head={['Employee', 'Topic', 'Score', '']}>
            {recs.data.map((r) => (
              <tr key={`${r.employeeId}:${r.topicId}`}>
                <td className="px-4 py-2">{r.employeeName}</td>
                <td className="px-4 py-2 text-ink-muted">{r.topic.nameEn}</td>
                <td className="px-4 py-2">
                  {/* The evidence, not just a verdict. Whoever assigns this
                      should see why it is being suggested. */}
                  <span className="font-medium text-danger">{r.percentage.toFixed(0)}%</span>
                  <span className="ml-2 text-xs text-ink-muted">
                    {r.marksObtained}/{r.marksAvailable}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <Button onClick={() => void assign(r)}>Assign</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Assigned"
        action={
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
            className="w-40"
          >
            <option value="">Any status</option>
            <option value="assigned">Assigned</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
          </Select>
        }
      >
        <ErrorNote error={list.error} />
        {list.loading && !list.data ? (
          <Spinner />
        ) : !list.data?.data.length ? (
          <Empty title="Nothing assigned" hint="Assign from the recommendations above." />
        ) : (
          <>
            <Table head={['Employee', 'Topic', 'Material', 'Due', 'Status', '']}>
              {list.data.data.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-2">
                    {t.employee.firstName} {t.employee.lastName}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{t.topic?.nameEn ?? '—'}</td>
                  <td className="px-4 py-2 text-ink-muted">{t.sourceDocument?.title ?? '—'}</td>
                  <td className="px-4 py-2 text-ink-muted">
                    {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {/* isOverdue is computed by the API from the due date, not
                        stored — nothing runs at midnight to flip a status. */}
                    {t.isOverdue ? (
                      <Badge tone="danger">overdue</Badge>
                    ) : (
                      <Badge tone={t.status === 'completed' ? 'success' : 'neutral'}>
                        {t.status.replace(/_/g, ' ')}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.status !== 'completed' && (
                      <Button variant="secondary" onClick={() => void complete(t.id)}>
                        Mark complete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            <Pager
              page={list.data.meta.page}
              totalPages={list.data.meta.totalPages}
              total={list.data.meta.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  )
}

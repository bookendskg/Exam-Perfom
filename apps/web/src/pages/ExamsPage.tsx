import { useState } from 'react'
import { useApi } from '../lib/useApi'
import { Async, Badge, Button, Card, PageHeader, Table } from '../components/ui'

interface Exam {
  id: string
  examCode: string
  nameEn: string
  status: 'draft' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'archived'
  scheduledDate: string
  startTime: string
  endTime: string
  durationMinutes: number
  totalMarks: string | number
  passingPercentage: string | number
  totalAssigned: number | null
  totalAttempted: number | null
  totalPassed: number | null
  averageScore: string | number | null
}

const STATUS_TONE: Record<Exam['status'], 'good' | 'warn' | 'bad' | 'neutral'> = {
  scheduled: 'good',
  active: 'good',
  draft: 'neutral',
  completed: 'neutral',
  cancelled: 'bad',
  archived: 'neutral',
}

/** The stored DATE and TIMEs are IST wall-clock; render them as written. */
function windowOf(exam: Exam): string {
  const date = new Date(exam.scheduledDate).toISOString().slice(0, 10)
  const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16)
  return `${date} · ${clock(exam.startTime)}–${clock(exam.endTime)} IST`
}

export function ExamsPage() {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const exams = useApi<Exam[]>('/exams', { page, limit: 20, status: status || undefined })

  return (
    <>
      <PageHeader title="Exams" subtitle="§11 — scheduled monthly, on the 15th unless it falls on a weekend" />

      <Card className="mb-4 p-4">
        <label className="text-sm">
          <span className="mr-2 text-stone-500">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
            className="rounded-md border border-stone-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {['draft', 'scheduled', 'active', 'completed', 'cancelled', 'archived'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </Card>

      <Card>
        <Async state={exams} empty="No exams yet. The scheduler creates them on the 1st of each month.">
          {(rows) => (
            <>
              <Table head={['Code', 'Exam', 'Window', 'Marks', 'Assigned', 'Sat', 'Passed', 'Average', 'Status']}>
                {rows.map((x) => (
                  <tr key={x.id} className="hover:bg-stone-50">
                    <td className="px-4 py-3 font-mono text-xs text-stone-500">{x.examCode}</td>
                    <td className="px-4 py-3 font-medium text-stone-900">{x.nameEn}</td>
                    <td className="px-4 py-3 text-xs text-stone-600">{windowOf(x)}</td>
                    <td className="px-4 py-3 text-stone-600">
                      {Number(x.totalMarks)}
                      <span className="text-xs text-stone-400"> · pass {Number(x.passingPercentage)}%</span>
                    </td>
                    <td className="px-4 py-3 text-stone-600">{x.totalAssigned ?? 0}</td>
                    <td className="px-4 py-3 text-stone-600">{x.totalAttempted ?? 0}</td>
                    <td className="px-4 py-3 text-stone-600">{x.totalPassed ?? 0}</td>
                    <td className="px-4 py-3 text-stone-600">
                      {/* Null until something is graded — an exam awaiting
                          grading genuinely has no average yet. */}
                      {x.averageScore == null ? '—' : `${Number(x.averageScore)}%`}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[x.status]}>{x.status}</Badge>
                    </td>
                  </tr>
                ))}
              </Table>

              {exams.meta && exams.meta.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-stone-200 px-4 py-3 text-sm">
                  <span className="text-stone-500">{exams.meta.total} exams</span>
                  <div className="flex gap-2">
                    <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={page >= (exams.meta?.totalPages ?? 1)}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Async>
      </Card>
    </>
  )
}

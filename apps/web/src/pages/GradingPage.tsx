import { Link } from 'react-router-dom'
import { useApi } from '../lib/useApi'
import { Async, Badge, Card, PageHeader, Table } from '../components/ui'

interface QueueRow {
  id: string
  status: string
  submittedAt: string | null
  ungradedResponses: number
  employee: {
    id: string
    employeeCode: string | null
    firstName: string
    lastName: string | null
    outlet: { id: string; name: string; code: string } | null
    department: { id: string; name: string } | null
  }
  exam: {
    id: string
    examCode: string
    nameEn: string
    totalMarks: string | number
    scheduledDate: string
  }
}

/** How long an attempt has been waiting — the thing that makes a queue urgent. */
function waitingFor(since: string | null): string {
  if (!since) return '—'
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return '1 day'
  return `${days} days`
}

export function GradingPage() {
  const queue = useApi<QueueRow[]>('/grading/queue', { pageSize: 50 })

  return (
    <>
      <PageHeader
        title="Grading"
        subtitle="Theory and video answers waiting for a human. Multiple choice is graded automatically."
      />

      <Card>
        <Async
          state={queue}
          empty="Nothing to grade. Every submitted answer has been marked."
        >
          {(rows) => (
            <Table head={['Staff', 'Outlet', 'Exam', 'Submitted', 'Waiting', 'To mark', '']}>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-stone-900">
                      {row.employee.firstName} {row.employee.lastName ?? ''}
                    </div>
                    <div className="font-mono text-xs text-stone-400">
                      {row.employee.employeeCode ?? '—'}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {row.employee.outlet?.name ?? '—'}
                    {row.employee.department && (
                      <div className="text-xs text-stone-400">{row.employee.department.name}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-stone-900">{row.exam.nameEn}</div>
                    <div className="font-mono text-xs text-stone-400">{row.exam.examCode}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-500">
                    {row.submittedAt ? new Date(row.submittedAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={waitingFor(row.submittedAt).includes('day') ? 'warn' : 'neutral'}>
                      {waitingFor(row.submittedAt)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-stone-600">{row.ungradedResponses}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/grading/${row.id}`}
                      className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                    >
                      Grade
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Async>
      </Card>
    </>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, query } from '../lib/useApi.js'
import { Card, Empty, ErrorNote, Select, Spinner, Table } from '../components/ui.js'

interface DashboardData {
  period: { year: number; month: number }
  headcount: number
  examsThisMonth: number
  averageScore: number | null
  examsAssigned: number
  examsAttempted: number
  examsPassed: number
  examsMissed: number
  attendanceRate: number | null
  passRate: number | null
}

interface WeakArea {
  topic: { id: string; nameEn: string }
  percentage: number
  employeesAssessed: number
}

interface LeaderboardRow {
  averageScore: number | null
  examsPassed: number | null
  employee: { id: string; employeeCode: string | null; firstName: string; lastName: string }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function Dashboard() {
  const now = new Date()
  const [year, setYear] = useState(now.getUTCFullYear())
  const [month, setMonth] = useState(now.getUTCMonth() + 1)

  const period = query({ year, month })
  const dash = useApi<DashboardData>(`/analytics/dashboard${period}`, [year, month])
  const weak = useApi<WeakArea[]>(`/analytics/weak-areas${period}`, [year, month])
  const board = useApi<LeaderboardRow[]>(`/analytics/leaderboard${period}&limit=5`, [year, month])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Dashboard</h1>
          <p className="text-sm text-ink-muted">
            {MONTHS[month - 1]} {year}
          </p>
        </div>

        <div className="flex gap-2">
          <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="w-36">
            {MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </Select>
          <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </div>
      </header>

      <ErrorNote error={dash.error} />

      {dash.loading && !dash.data ? (
        <Spinner />
      ) : dash.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Active staff" value={dash.data.headcount} />
          <Stat label="Exams this month" value={dash.data.examsThisMonth} />
          <Stat
            label="Average score"
            value={dash.data.averageScore === null ? '—' : `${dash.data.averageScore.toFixed(1)}%`}
            /* Null is not zero. A month with no graded exams has no average,
               and rendering 0% would say the staff failed everything. */
            hint={dash.data.averageScore === null ? 'No graded exams yet' : undefined}
          />
          <Stat
            label="Attendance"
            value={
              dash.data.attendanceRate === null ? '—' : `${dash.data.attendanceRate.toFixed(0)}%`
            }
            hint={
              dash.data.examsAssigned > 0
                ? `${dash.data.examsAttempted} of ${dash.data.examsAssigned} sat`
                : 'Nothing assigned'
            }
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Weakest topics"
          action={
            <Link to="/training" className="text-xs text-primary underline">
              Assign training
            </Link>
          }
        >
          <ErrorNote error={weak.error} />
          {weak.loading && !weak.data ? (
            <Spinner />
          ) : !weak.data?.length ? (
            <Empty
              title="Nothing below the threshold"
              hint="Weak topics appear here once exams have been graded."
            />
          ) : (
            <ul className="space-y-3">
              {weak.data.slice(0, 6).map((w) => (
                <li key={w.topic.id}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-ink">{w.topic.nameEn}</span>
                    <span className="font-medium text-ink">{w.percentage.toFixed(0)}%</span>
                  </div>
                  {/* A bar, because "48%" and "61%" look the same in a list and
                      the point of this card is to be scannable. */}
                  <div className="mt-1 h-1.5 rounded-full bg-canvas">
                    <div
                      className="h-full rounded-full bg-danger"
                      style={{ width: `${Math.max(2, w.percentage)}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {w.employeesAssessed} assessed
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Top performers"
          action={
            <Link to="/rewards" className="text-xs text-primary underline">
              Award
            </Link>
          }
        >
          <ErrorNote error={board.error} />
          {board.loading && !board.data ? (
            <Spinner />
          ) : !board.data?.length ? (
            <Empty title="No results yet" hint="The leaderboard fills in once exams are graded." />
          ) : (
            <Table head={['#', 'Employee', 'Code', 'Average']}>
              {board.data.map((row, i) => (
                <tr key={row.employee.id}>
                  <td className="px-4 py-2 text-ink-muted">{i + 1}</td>
                  <td className="px-4 py-2">
                    {row.employee.firstName} {row.employee.lastName}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{row.employee.employeeCode ?? '—'}</td>
                  <td className="px-4 py-2 font-medium">
                    {row.averageScore === null ? '—' : `${Number(row.averageScore).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  )
}

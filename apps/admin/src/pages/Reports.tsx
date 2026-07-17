import { useState } from 'react'
import { getAccessToken, type Paged } from '../lib/api.js'
import { query, useApi } from '../lib/useApi.js'
import { Button, Card, Empty, ErrorNote, Field, Select, Spinner, Table } from '../components/ui.js'

/**
 * §11 reports.
 *
 * Two things worth knowing about this screen:
 *
 *  - Export is plan-gated (§4.1: Professional and above). The button is always
 *    shown and the 403 explains the upgrade, rather than hiding it — a feature
 *    a customer cannot see is one they will not buy.
 *  - Only CSV is real. PDF and Excel return 501 from the API because §5.2's
 *    branding assets do not exist, so this offers CSV only rather than a
 *    dropdown where two of three choices fail.
 */

interface Named {
  id: string
  name?: string
  code?: string
}

interface Employee {
  id: string
  firstName: string
  lastName: string
  employeeCode: string | null
}

interface EmployeeReport {
  employee: { firstName: string; lastName: string; employeeCode: string | null }
  current: {
    period: { year: number; month: number }
    averageScore: number | null
    examsAttempted: number | null
    examsPassed: number | null
    outletRank: number | null
  } | null
  trend: Array<{ year: number; month: number; averageScore: number | null }>
  weakTopics: Array<{ topic: { id: string; nameEn: string }; percentage: number }>
  training: { open: number; completed: number }
}

interface OutletReport {
  outlet: { name: string; code: string }
  summary: {
    employeesAssessed: number
    averageScore: number | null
    median: number | null
    examsAttempted: number
    examsPassed: number
  }
  byDepartment: Array<{ departmentId: string; name: string; averageScore: number; employeesAssessed: number }>
  weakTopics: Array<{ topic: { id: string; nameEn: string }; percentage: number }>
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function Reports() {
  const now = new Date()
  const [kind, setKind] = useState<'employee' | 'outlet'>('outlet')
  const [year, setYear] = useState(now.getUTCFullYear())
  const [month, setMonth] = useState(now.getUTCMonth() + 1)
  const [outletId, setOutletId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [exportError, setExportError] = useState<unknown>(null)

  const outlets = useApi<Named[]>('/outlets')
  const employees = useApi<Paged<Employee>>('/employees?limit=100&status=active')

  const employeeReport = useApi<EmployeeReport>(
    kind === 'employee' && employeeId ? `/reports/employee/${employeeId}` : null,
    [kind, employeeId]
  )
  const outletReport = useApi<OutletReport>(
    kind === 'outlet' && outletId ? `/reports/outlet/${outletId}${query({ year, month })}` : null,
    [kind, outletId, year, month]
  )

  /**
   * Export.
   *
   * fetch, not a plain <a href>: the API needs the Authorization header, which
   * a link cannot carry. So the file is fetched, turned into a blob, and handed
   * to a synthetic download — which also means a 403 renders as an explanation
   * rather than the browser navigating to a JSON error page.
   */
  const exportCsv = async () => {
    setExportError(null)
    const id = kind === 'employee' ? employeeId : outletId
    if (!id) return

    try {
      const res = await fetch(
        `/api/v1/reports/export${query({
          type: kind,
          format: 'csv',
          id,
          ...(kind === 'outlet' ? { year, month } : {}),
        })}`,
        { headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` }, credentials: 'include' }
      )

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string; details?: Array<{ message: string }> } }
          | null
        throw new Error(
          body?.error?.details?.[0]?.message ?? body?.error?.message ?? 'Export failed'
        )
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download =
        res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'report.csv'
      link.click()
      // Or the blob leaks for the life of the tab.
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err)
    }
  }

  const report = kind === 'employee' ? employeeReport : outletReport

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Reports</h1>
        <p className="text-sm text-ink-muted">§11 performance records</p>
      </header>

      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Report">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="outlet">Outlet</option>
              <option value="employee">Employee</option>
            </Select>
          </Field>

          {kind === 'outlet' ? (
            <Field label="Outlet">
              <Select value={outletId} onChange={(e) => setOutletId(e.target.value)}>
                <option value="">Choose…</option>
                {(outlets.data ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Employee">
              <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Choose…</option>
                {(employees.data?.data ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.firstName} {e.lastName}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {kind === 'outlet' && (
            <>
              <Field label="Month">
                <Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                  {MONTHS.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Year">
                <Select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {[year - 1, year].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={!(kind === 'employee' ? employeeId : outletId)}
            onClick={() => void exportCsv()}
          >
            Export CSV
          </Button>
          <span className="text-xs text-ink-muted">
            §4.1: export needs Professional or above. PDF and Excel are not built yet.
          </span>
        </div>

        {/* `exportError !== null`, not `exportError &&`: the state is `unknown`,
            and JSX would try to RENDER a truthy non-node rather than treat it as
            a condition. */}
        {exportError !== null && (
          <div className="mt-3">
            <ErrorNote error={exportError} />
          </div>
        )}
      </Card>

      <ErrorNote error={report.error} />

      {report.loading ? (
        <Spinner label="Building report" />
      ) : kind === 'outlet' && outletReport.data ? (
        <OutletView report={outletReport.data} />
      ) : kind === 'employee' && employeeReport.data ? (
        <EmployeeView report={employeeReport.data} />
      ) : (
        <Card>
          <Empty title="Choose what to report on" hint="Pick an outlet or an employee above." />
        </Card>
      )}
    </div>
  )
}

function OutletView({ report }: { report: OutletReport }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Assessed" value={report.summary.employeesAssessed} />
        <Stat
          label="Average"
          value={report.summary.averageScore === null ? '—' : `${report.summary.averageScore.toFixed(1)}%`}
        />
        {/* Median next to mean: one terrible score drags an average in a way
            that misrepresents the group, and the gap between them is the signal. */}
        <Stat
          label="Median"
          value={report.summary.median === null ? '—' : `${report.summary.median.toFixed(1)}%`}
          hint="Half score above this"
        />
        <Stat
          label="Passed"
          value={`${report.summary.examsPassed} / ${report.summary.examsAttempted}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By department">
          {report.byDepartment.length === 0 ? (
            <Empty title="No department data" />
          ) : (
            <Table head={['Department', 'Assessed', 'Average']}>
              {report.byDepartment.map((d) => (
                <tr key={d.departmentId}>
                  <td className="px-4 py-2">{d.name}</td>
                  <td className="px-4 py-2 text-ink-muted">{d.employeesAssessed}</td>
                  <td className="px-4 py-2 font-medium">{d.averageScore.toFixed(1)}%</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Weakest topics">
          {report.weakTopics.length === 0 ? (
            <Empty title="Nothing below the threshold" />
          ) : (
            <ul className="space-y-2">
              {report.weakTopics.map((w) => (
                <li key={w.topic.id} className="flex justify-between text-sm">
                  <span>{w.topic.nameEn}</span>
                  <span className="font-medium text-danger">{w.percentage.toFixed(0)}%</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

function EmployeeView({ report }: { report: EmployeeReport }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat
          label="Average"
          value={
            report.current?.averageScore === null || !report.current
              ? '—'
              : `${report.current.averageScore.toFixed(1)}%`
          }
          hint={
            report.current
              ? `${MONTHS[report.current.period.month - 1]} ${report.current.period.year}`
              : 'No graded exams yet'
          }
        />
        <Stat label="Outlet rank" value={report.current?.outletRank ?? '—'} />
        <Stat
          label="Exams passed"
          value={`${report.current?.examsPassed ?? 0} / ${report.current?.examsAttempted ?? 0}`}
        />
        <Stat
          label="Training"
          value={`${report.training.completed} done`}
          hint={report.training.open > 0 ? `${report.training.open} open` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Trend">
          {report.trend.length === 0 ? (
            <Empty title="No history yet" hint="A trend appears once exams are graded." />
          ) : (
            <Table head={['Period', 'Average']}>
              {report.trend.map((t) => (
                <tr key={`${t.year}-${t.month}`}>
                  <td className="px-4 py-2">
                    {MONTHS[t.month - 1]} {t.year}
                  </td>
                  <td className="px-4 py-2 font-medium">
                    {t.averageScore === null ? '—' : `${t.averageScore.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Weakest topics">
          {report.weakTopics.length === 0 ? (
            <Empty title="Nothing below the threshold" />
          ) : (
            <ul className="space-y-2">
              {report.weakTopics.map((w) => (
                <li key={w.topic.id} className="flex justify-between text-sm">
                  <span>{w.topic.nameEn}</span>
                  <span className="font-medium text-danger">{w.percentage.toFixed(0)}%</span>
                </li>
              ))}
            </ul>
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

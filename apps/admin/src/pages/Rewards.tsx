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
 * §12 rewards and certificates.
 *
 * Same shape as training, and for the same reason: the API suggests from real
 * snapshots, a human awards. Recognition that arrives automatically from a
 * query is worth nothing to the person receiving it — and a wrong one, to
 * someone who left last week, is worse than none.
 */

interface Suggestion {
  employee: { id: string; employeeCode: string | null; firstName: string; lastName: string }
  averageScore: number | null
  examsPassed: number | null
  examsAttempted: number | null
  rank: number
  suggestedType: 'gold' | 'silver' | 'bronze' | null
  reason: string
}

interface Reward {
  id: string
  type: string
  title: string
  month: number | null
  year: number | null
  awardedAt: string
  employee: { id: string; employeeCode: string | null; firstName: string; lastName: string }
}

interface Certificate {
  id: string
  type: string
  title: string
  certificateNumber: string | null
  certificateUrl: string | null
  issuedAt: string
  employee: { id: string; firstName: string; lastName: string }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const MEDAL_TONE = { gold: 'warning', silver: 'neutral', bronze: 'warning' } as const

export function Rewards() {
  const now = new Date()
  const [year, setYear] = useState(now.getUTCFullYear())
  const [month, setMonth] = useState(now.getUTCMonth() + 1)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<unknown>(null)

  const suggestions = useApi<Suggestion[]>(`/rewards/suggestions${query({ year, month })}`, [year, month])
  const rewards = useApi<Paged<Reward>>(`/rewards${query({ page, limit: 10 })}`, [page])
  const certificates = useApi<Paged<Certificate>>('/certificates?limit=10')

  const award = async (s: Suggestion) => {
    setError(null)
    try {
      await api.post('/rewards', {
        employeeId: s.employee.id,
        type: s.suggestedType ?? 'special',
        title: `${MONTHS[month - 1]} ${year} — ${s.suggestedType ?? 'recognition'}`,
        month,
        year,
        // §4.1's "what earned this reward". Recording the basis means the award
        // is answerable later, not just a medal with a name on it.
        criteria: {
          rank: s.rank,
          averageScore: s.averageScore,
          basis: s.reason,
        },
      })
      void suggestions.refetch()
      void rewards.refetch()
    } catch (err) {
      setError(err)
    }
  }

  const certify = async (s: Suggestion) => {
    setError(null)
    try {
      await api.post('/certificates', {
        employeeId: s.employee.id,
        type: 'monthly',
        title: `Top performer — ${MONTHS[month - 1]} ${year}`,
      })
      void certificates.refetch()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Rewards</h1>
        <p className="text-sm text-ink-muted">Recognition, decided by you</p>
      </header>

      <ErrorNote error={error} />

      <Card
        title="Suggested"
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
        <ErrorNote error={suggestions.error} />
        {suggestions.loading && !suggestions.data ? (
          <Spinner />
        ) : !suggestions.data?.length ? (
          <Empty
            title="Nobody to suggest"
            hint="Suggestions come from graded exams. Anyone already recognised this month is left out."
          />
        ) : (
          <Table head={['#', 'Employee', 'Why', 'Suggested', '']}>
            {suggestions.data.map((s) => (
              <tr key={s.employee.id}>
                <td className="px-4 py-2 text-ink-muted">{s.rank}</td>
                <td className="px-4 py-2">
                  {s.employee.firstName} {s.employee.lastName}
                </td>
                {/* The reason, verbatim from the API. An awarder should not have
                    to trust an ordering whose basis they cannot see. */}
                <td className="px-4 py-2 text-ink-muted">{s.reason}</td>
                <td className="px-4 py-2">
                  {s.suggestedType ? (
                    <Badge tone={MEDAL_TONE[s.suggestedType]}>{s.suggestedType}</Badge>
                  ) : (
                    <span className="text-xs text-ink-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => void certify(s)}>
                      Certificate
                    </Button>
                    <Button onClick={() => void award(s)}>Award</Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Awarded">
          <ErrorNote error={rewards.error} />
          {rewards.loading && !rewards.data ? (
            <Spinner />
          ) : !rewards.data?.data.length ? (
            <Empty title="No rewards yet" />
          ) : (
            <>
              <Table head={['Employee', 'Award', 'Period']}>
                {rewards.data.data.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2">
                      {r.employee.firstName} {r.employee.lastName}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">{r.title}</td>
                    <td className="px-4 py-2 text-ink-muted">
                      {r.month ? `${MONTHS[r.month - 1]} ${r.year}` : '—'}
                    </td>
                  </tr>
                ))}
              </Table>
              <Pager
                page={rewards.data.meta.page}
                totalPages={rewards.data.meta.totalPages}
                total={rewards.data.meta.total}
                onPage={setPage}
              />
            </>
          )}
        </Card>

        <Card title="Certificates">
          <ErrorNote error={certificates.error} />
          {certificates.loading && !certificates.data ? (
            <Spinner />
          ) : !certificates.data?.data.length ? (
            <Empty title="None issued yet" />
          ) : (
            <Table head={['Number', 'Employee', 'Title', '']}>
              {certificates.data.data.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2 font-mono text-xs">{c.certificateNumber}</td>
                  <td className="px-4 py-2">
                    {c.employee.firstName} {c.employee.lastName}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{c.title}</td>
                  <td className="px-4 py-2 text-right">
                    {/* The record exists; the PDF does not. Saying so beats a
                        download button that 404s — see rewards.service.ts. */}
                    {c.certificateUrl ? (
                      <a href={c.certificateUrl} className="text-primary underline">
                        Download
                      </a>
                    ) : (
                      <span className="text-xs text-ink-muted">PDF not yet available</span>
                    )}
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

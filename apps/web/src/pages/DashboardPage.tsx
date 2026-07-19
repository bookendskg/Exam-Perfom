import { useApi } from '../lib/useApi'
import { useAuth } from '../lib/auth'
import { Async, Card, PageHeader } from '../components/ui'

interface Outlet {
  id: string
  name: string
  code: string
  city?: string | null
}

interface OutletStats {
  headcount: number
  byDepartment: Array<{ department: { id: string; name: string; code: string }; count: number }>
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="p-5">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-stone-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-stone-400">{hint}</div>}
    </Card>
  )
}

function OutletCard({ outlet }: { outlet: Outlet }) {
  // Each outlet's headcount is its own request: §3.2 gives outlet:stats a
  // narrower scope than outlet:read, so a manager may see the outlet and be
  // refused its figures. Failing one card is better than failing the page.
  const stats = useApi<OutletStats>(`/outlets/${outlet.id}/stats`)

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium text-stone-900">{outlet.name}</h3>
        <span className="text-xs text-stone-400">{outlet.code}</span>
      </div>
      {outlet.city && <div className="mt-1 text-xs text-stone-500">{outlet.city}</div>}

      {stats.error ? (
        <div className="mt-4 text-sm text-stone-400">Figures not available to you</div>
      ) : stats.loading ? (
        <div className="mt-4 text-sm text-stone-400">Loading…</div>
      ) : (
        <>
          <div className="mt-4 text-2xl font-semibold text-stone-900">
            {stats.data?.headcount ?? 0}
            <span className="ml-2 text-sm font-normal text-stone-500">staff</span>
          </div>
          <div className="mt-3 space-y-1">
            {(stats.data?.byDepartment ?? []).map((d) => (
              <div key={d.department.id} className="flex justify-between text-sm">
                <span className="text-stone-600">{d.department.name}</span>
                <span className="text-stone-900">{d.count}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

export function DashboardPage() {
  const { user } = useAuth()
  const outlets = useApi<Outlet[]>('/outlets')
  const grading = useApi<unknown[]>(
    // Only roles that can grade should ask; others would get a 403 banner for
    // a number they were never meant to see.
    user && ['super_admin', 'admin', 'outlet_manager', 'trainer'].includes(user.role)
      ? '/grading/queue'
      : null
  )

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Bookends Hospitality — Aiko, Capiche and Prep"
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Outlets" value={outlets.data?.length ?? '—'} />
        <Stat
          label="Awaiting grading"
          value={grading.meta?.total ?? (grading.loading ? '…' : '—')}
          hint="Theory and video answers"
        />
        <Stat label="Signed in as" value={user?.role.replace('_', ' ') ?? '—'} />
      </div>

      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-stone-500">Outlets</h2>
      <Async state={outlets} empty="No outlets yet">
        {(data) => (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((outlet) => (
              <OutletCard key={outlet.id} outlet={outlet} />
            ))}
          </div>
        )}
      </Async>
    </>
  )
}

import { useState } from 'react'
import { api, ApiError, type Paged } from '../lib/api.js'
import { query, useApi } from '../lib/useApi.js'
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Pager,
  Select,
  Spinner,
  Table,
} from '../components/ui.js'

/**
 * §8 employees.
 *
 * The template every other list follows: filters in the URL-ish state, a paged
 * table, and a create form that surfaces the server's own validation rather
 * than duplicating it.
 */

interface Employee {
  id: string
  employeeCode: string | null
  firstName: string
  lastName: string
  phone: string
  employmentStatus: string
  outletId: string
  departmentId: string
  designationId: string
}

interface Org {
  id: string
  name: string
  code: string
  /** Present on designations: which department the designation belongs to. */
  department?: { id: string; name: string; code: string }
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  on_leave: 'warning',
  suspended: 'warning',
  terminated: 'danger',
  resigned: 'neutral',
}

export function Employees() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [outletId, setOutletId] = useState('')
  const [creating, setCreating] = useState(false)

  const list = useApi<Paged<Employee>>(
    `/employees${query({ page, limit: 20, search, status, outlet_id: outletId })}`,
    [page, search, status, outletId]
  )
  const outlets = useApi<Org[]>('/outlets')

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Employees</h1>
          <p className="text-sm text-ink-muted">
            {list.data ? `${list.data.meta.total} on the books` : ' '}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Add employee</Button>
      </header>

      {creating && (
        <CreateEmployee
          outlets={outlets.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void list.refetch()
          }}
        />
      )}

      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Input
            placeholder="Search name, code or phone"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              // Any filter change invalidates the page number — staying on
              // page 4 of a one-page result shows an empty table.
              setPage(1)
            }}
          />
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="on_leave">On leave</option>
            <option value="suspended">Suspended</option>
            <option value="terminated">Terminated</option>
            <option value="resigned">Resigned</option>
          </Select>
          <Select
            value={outletId}
            onChange={(e) => {
              setOutletId(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Any outlet</option>
            {(outlets.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>

        <ErrorNote error={list.error} />

        {list.loading && !list.data ? (
          <Spinner />
        ) : !list.data?.data.length ? (
          <Empty
            title="No employees match"
            hint={search || status || outletId ? 'Try clearing the filters.' : 'Add your first employee to get started.'}
          />
        ) : (
          <>
            <Table head={['Code', 'Name', 'Phone', 'Status', '']}>
              {list.data.data.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 font-mono text-xs text-ink-muted">
                    {e.employeeCode ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    {e.firstName} {e.lastName}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{e.phone}</td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS_TONE[e.employmentStatus] ?? 'neutral'}>
                      {e.employmentStatus.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <StatusMenu employee={e} onChanged={() => void list.refetch()} />
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

function StatusMenu({ employee, onChanged }: { employee: Employee; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const change = async (status: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/employees/${employee.id}/status`, { status })
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // §8.4's state machine: terminated and resigned are terminal ("rehiring is a
  // new employee record"), so offering a way back would promise something the
  // API refuses.
  const terminal = ['terminated', 'resigned'].includes(employee.employmentStatus)
  if (terminal) return <span className="text-xs text-ink-muted">—</span>

  return (
    <div className="flex items-center justify-end gap-2">
      {error instanceof ApiError && <span className="text-xs text-danger">{error.message}</span>}
      <Select
        value=""
        disabled={busy}
        className="w-36"
        onChange={(e) => e.target.value && void change(e.target.value)}
      >
        <option value="">Change status…</option>
        {employee.employmentStatus !== 'active' && <option value="active">Active</option>}
        {employee.employmentStatus !== 'on_leave' && <option value="on_leave">On leave</option>}
        {employee.employmentStatus !== 'suspended' && <option value="suspended">Suspended</option>}
        <option value="terminated">Terminated</option>
        <option value="resigned">Resigned</option>
      </Select>
    </div>
  )
}

function CreateEmployee({
  outlets,
  onClose,
  onCreated,
}: {
  outlets: Org[]
  onClose: () => void
  onCreated: () => void
}) {
  const departments = useApi<Org[]>('/departments')
  const designations = useApi<Org[]>('/designations')

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    outletId: '',
    departmentId: '',
    designationId: '',
    joiningDate: new Date().toISOString().slice(0, 10),
    preferredLanguage: 'en',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ employeeCode: string; temporaryPassword: string } | null>(
    null
  )

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.post<{
        employee: { employeeCode: string }
        temporaryPassword: string
      }>('/employees', form)

      /**
       * §7.3: the account is created with a derived password and
       * mustChangePassword. This is the ONLY time it is shown — it is not
       * stored anywhere retrievable, so closing this without reading it means
       * a password reset.
       */
      setCreated({
        employeeCode: result.employee.employeeCode,
        temporaryPassword: result.temporaryPassword,
      })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <Card title="Employee added">
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Give these to the new employee. The password is shown once and is not recoverable —
            they will be asked to change it at first sign-in.
          </p>
          <dl className="rounded-md border border-edge bg-canvas p-4 text-sm">
            <div className="flex justify-between py-1">
              <dt className="text-ink-muted">Employee code</dt>
              <dd className="font-mono">{created.employeeCode}</dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-ink-muted">Temporary password</dt>
              <dd className="font-mono">{created.temporaryPassword}</dd>
            </div>
          </dl>
          <Button onClick={onCreated}>Done</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Add employee" action={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <form onSubmit={submit} className="space-y-4">
        {/* The server's validation is the real one — §4.3's plan limit lands
            here too, and this renders its upgrade message rather than a
            generic failure. */}
        <ErrorNote error={error} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required>
            <Input value={form.firstName} onChange={set('firstName')} required />
          </Field>
          <Field label="Last name" required>
            <Input value={form.lastName} onChange={set('lastName')} required />
          </Field>
          <Field label="Phone" required hint="Used to sign in (§7.1)">
            <Input value={form.phone} onChange={set('phone')} inputMode="numeric" required />
          </Field>
          <Field label="Joining date" required>
            <Input type="date" value={form.joiningDate} onChange={set('joiningDate')} required />
          </Field>
          <Field label="Outlet" required>
            <Select value={form.outletId} onChange={set('outletId')} required>
              <option value="">Choose…</option>
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Department" required>
            <Select
              value={form.departmentId}
              // Changing department clears the designation: the API rejects a
              // designation that belongs to another department, and a stale
              // pick left from the previous choice is exactly that mismatch.
              onChange={(e) =>
                setForm((f) => ({ ...f, departmentId: e.target.value, designationId: '' }))
              }
              required
            >
              <option value="">Choose…</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Designation"
            required
            hint={!form.departmentId ? 'Choose a department first' : undefined}
          >
            <Select value={form.designationId} onChange={set('designationId')} required disabled={!form.departmentId}>
              <option value="">Choose…</option>
              {/* Only this department's designations — the API enforces the
                  match, so offering the others just invites a 400. */}
              {(designations.data ?? [])
                .filter((d) => d.department?.id === form.departmentId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Language" hint="§6: the language their app appears in">
            <Select value={form.preferredLanguage} onChange={set('preferredLanguage')}>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
              <option value="gu">ગુજરાતી</option>
            </Select>
          </Field>
        </div>

        <Button type="submit" loading={busy}>
          Add employee
        </Button>
      </form>
    </Card>
  )
}

import { useState } from 'react'
import { api } from '../lib/api.js'
import { useApi } from '../lib/useApi.js'
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Spinner,
  Table,
} from '../components/ui.js'

/**
 * §9 outlets, departments and designations.
 *
 * Rarely touched — a restaurant group does not add an outlet weekly — so this
 * is deliberately plain. It exists because §4.3 gates outlets on the plan, and
 * because a tenant that signed up with one "Main Outlet" needs somewhere to
 * rename it and add the rest.
 */

interface Outlet {
  id: string
  name: string
  code: string
  city: string | null
  isActive: boolean
}

interface Department {
  id: string
  name: string
  code: string
  description: string | null
  isActive: boolean
}

interface Designation {
  id: string
  name: string
  code: string
  level: number
  departmentId: string | null
  isActive: boolean
}

export function Organisation() {
  const outlets = useApi<Outlet[]>('/outlets')
  const departments = useApi<Department[]>('/departments')
  const designations = useApi<Designation[]>('/designations')
  const [addingOutlet, setAddingOutlet] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const toggleOutlet = async (outlet: Outlet) => {
    setError(null)
    try {
      await api.put(`/outlets/${outlet.id}`, { isActive: !outlet.isActive })
      void outlets.refetch()
    } catch (err) {
      // Two real refusals land here, and both are worth reading: §4.3's outlet
      // limit on reactivation, and §9's "cannot deactivate an outlet with
      // active staff".
      setError(err)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Organisation</h1>
        <p className="text-sm text-ink-muted">Outlets, departments and designations</p>
      </header>

      <ErrorNote error={error} />

      <Card
        title="Outlets"
        action={<Button onClick={() => setAddingOutlet(true)}>Add outlet</Button>}
      >
        {addingOutlet && (
          <div className="mb-4">
            <AddOutlet
              onClose={() => setAddingOutlet(false)}
              onCreated={() => {
                setAddingOutlet(false)
                void outlets.refetch()
              }}
            />
          </div>
        )}

        <ErrorNote error={outlets.error} />
        {outlets.loading && !outlets.data ? (
          <Spinner />
        ) : !outlets.data?.length ? (
          <Empty title="No outlets" hint="Add the first one to start assigning staff." />
        ) : (
          <Table head={['Code', 'Name', 'City', 'Status', '']}>
            {outlets.data.map((o) => (
              <tr key={o.id}>
                <td className="px-4 py-2 font-mono text-xs text-ink-muted">{o.code}</td>
                <td className="px-4 py-2">{o.name}</td>
                <td className="px-4 py-2 text-ink-muted">{o.city ?? '—'}</td>
                <td className="px-4 py-2">
                  <Badge tone={o.isActive ? 'success' : 'neutral'}>
                    {o.isActive ? 'active' : 'inactive'}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-right">
                  <Button variant="secondary" onClick={() => void toggleOutlet(o)}>
                    {o.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Departments">
          <ErrorNote error={departments.error} />
          {departments.loading && !departments.data ? (
            <Spinner />
          ) : !departments.data?.length ? (
            <Empty title="No departments" />
          ) : (
            <Table head={['Code', 'Name', 'Status']}>
              {departments.data.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-2 font-mono text-xs text-ink-muted">{d.code}</td>
                  <td className="px-4 py-2">{d.name}</td>
                  <td className="px-4 py-2">
                    <Badge tone={d.isActive ? 'success' : 'neutral'}>
                      {d.isActive ? 'active' : 'inactive'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Designations">
          <ErrorNote error={designations.error} />
          {designations.loading && !designations.data ? (
            <Spinner />
          ) : !designations.data?.length ? (
            <Empty title="No designations" />
          ) : (
            <Table head={['Code', 'Name', 'Level']}>
              {[...designations.data]
                // §4.1: level 1 is entry, 5 is senior. Sorted seniority-first
                // because that is how an org chart reads.
                .sort((a, b) => b.level - a.level)
                .map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2 font-mono text-xs text-ink-muted">{d.code}</td>
                    <td className="px-4 py-2">{d.name}</td>
                    <td className="px-4 py-2 text-ink-muted">{d.level}</td>
                  </tr>
                ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}

function AddOutlet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', code: '', city: '' })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/outlets', {
        name: form.name,
        code: form.code.toUpperCase(),
        ...(form.city ? { city: form.city } : {}),
      })
      onCreated()
    } catch (err) {
      // §4.3's maxOutlets lands here — ErrorNote renders the upgrade message.
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border border-edge p-4">
      <ErrorNote error={error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" required>
          <Input value={form.name} onChange={set('name')} placeholder="Aiko" required />
        </Field>
        <Field label="Code" required hint="Short, unique to you — e.g. AK">
          <Input
            value={form.code}
            onChange={set('code')}
            placeholder="AK"
            maxLength={10}
            className="uppercase"
            required
          />
        </Field>
        <Field label="City">
          <Input value={form.city} onChange={set('city')} placeholder="Ahmedabad" />
        </Field>
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={busy}>
          Add outlet
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

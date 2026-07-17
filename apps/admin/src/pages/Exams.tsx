import { useState } from 'react'
import { api, type Paged } from '../lib/api.js'
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
 * §11 exams.
 *
 * The lifecycle is the screen: draft → scheduled → active → completed. §11.1
 * step 8 says nothing is live until it is published, and publishing is
 * irreversible in effect — staff are notified and can sit it. So the list makes
 * the current state obvious and the publish button explains itself first.
 */

interface Exam {
  id: string
  examCode: string
  nameEn: string
  scheduledDate: string
  startTime: string
  endTime: string
  status: 'draft' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'archived'
  totalMarks: string | number
  totalAssigned: number | null
  totalAttempted: number | null
  totalPassed: number | null
}

interface Named {
  id: string
  name?: string
  nameEn?: string
  code?: string
}

const STATUS_TONE = {
  draft: 'neutral',
  scheduled: 'info',
  active: 'warning',
  completed: 'success',
  cancelled: 'danger',
  archived: 'neutral',
} as const

export function Exams() {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const list = useApi<Paged<Exam>>(`/exams${query({ page, limit: 20, status })}`, [page, status])

  const publish = async (exam: Exam) => {
    setError(null)
    try {
      await api.post(`/exams/${exam.id}/publish`, {})
      void list.refetch()
    } catch (err) {
      // §11.1's publish validation refuses an exam with no questions, no
      // candidates, or marks that do not add up. Those messages are the whole
      // value — they say exactly what is missing.
      setError(err)
    }
  }

  const assign = async (exam: Exam) => {
    setError(null)
    try {
      // No employee_ids: the API then assigns everyone matching the exam's own
      // outlet/department/designation targeting (§11.3), which is what an
      // admin means by "assign this exam".
      await api.post(`/exams/${exam.id}/assign`, {})
      void list.refetch()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Exams</h1>
          <p className="text-sm text-ink-muted">
            {list.data ? `${list.data.meta.total} exams` : ' '}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Schedule exam</Button>
      </header>

      {creating && (
        <CreateExam
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void list.refetch()
          }}
        />
      )}

      <Card>
        <div className="mb-4">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
            className="w-48"
          >
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>

        <ErrorNote error={error ?? list.error} />

        {list.loading && !list.data ? (
          <Spinner />
        ) : !list.data?.data.length ? (
          <Empty
            title="No exams yet"
            hint="Schedule one, or let the auto-scheduler create next month's on the 15th."
          />
        ) : (
          <>
            <Table head={['Code', 'Name', 'Date', 'Status', 'Sat', 'Passed', '']}>
              {list.data.data.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 font-mono text-xs text-ink-muted">{e.examCode}</td>
                  <td className="px-4 py-2">{e.nameEn}</td>
                  <td className="px-4 py-2 text-ink-muted">
                    {new Date(e.scheduledDate).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-ink-muted">
                    {e.totalAttempted ?? 0} / {e.totalAssigned ?? 0}
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{e.totalPassed ?? 0}</td>
                  <td className="px-4 py-2 text-right">
                    {e.status === 'draft' && (
                      <div className="flex justify-end gap-2">
                        {/* Assign before publish: §11.1 refuses to publish an
                            exam nobody is sitting. */}
                        <Button variant="secondary" onClick={() => void assign(e)}>
                          Assign staff
                        </Button>
                        <Button onClick={() => void publish(e)}>Publish</Button>
                      </div>
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

function CreateExam({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const outlets = useApi<Named[]>('/outlets')
  const departments = useApi<Named[]>('/departments')
  const templates = useApi<Paged<Named>>('/exam-templates?limit=100')

  const [form, setForm] = useState({
    templateId: '',
    nameEn: '',
    scheduledDate: '',
    startTime: '10:00',
    endTime: '12:00',
    outletId: '',
    departmentId: '',
    durationMinutes: '60',
    passingPercentage: '40',
    mcqCount: '10',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // `requested`, not `wanted` — the API's ShortfallReport names it that, and the
  // difference rendered as "wanted undefined" in the one message meant to stop
  // an admin publishing an exam shorter than they asked for.
  const [shortfalls, setShortfalls] = useState<
    Array<{ type: string; difficulty?: string; requested: number; found: number }>
  >([])

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setShortfalls([])

    try {
      // The API spreads shortfalls alongside the exam's own fields rather than
      // nesting it under `exam`, so this is Exam & { shortfalls }.
      const result = await api.post<
        Exam & { shortfalls?: Array<{ type: string; difficulty?: string; requested: number; found: number }> }
      >('/exams', {
        ...(form.templateId ? { templateId: form.templateId } : {}),
        nameEn: form.nameEn,
        scheduledDate: form.scheduledDate,
        startTime: form.startTime,
        endTime: form.endTime,
        ...(form.outletId ? { outletId: form.outletId } : {}),
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        durationMinutes: Number(form.durationMinutes),
        passingPercentage: Number(form.passingPercentage),
        // §11.2's auto-selection: ask for N approved MCQs matching the exam's
        // targeting, and the API picks them at random.
        //
        // `total` is not redundant with the distribution's count — the API
        // cross-checks the parts against the stated whole, and omitting it
        // arrives as NaN rather than as missing. totalMarks is deliberately
        // absent: the selected questions' own marks are the exam's total and
        // the API sums them, which is the number §11.3 validates against.
        questionSelection: {
          mcq: {
            total: Number(form.mcqCount),
            distribution: [{ count: Number(form.mcqCount) }],
          },
        },
      })

      /**
       * §11.2 shortfalls: the bank did not have enough questions matching the
       * rules. The exam is still created — it is a draft — but silently
       * creating a 4-question exam when 10 were asked for is how an admin
       * publishes something wrong.
       */
      if (result.shortfalls?.length) {
        setShortfalls(result.shortfalls)
        return
      }
      onCreated()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (shortfalls.length > 0) {
    return (
      <Card title="Exam created — but the question bank came up short">
        <div className="space-y-4">
          <p className="text-sm text-ink">
            The exam is saved as a draft. Fewer questions matched your rules than you asked for, so
            check it before publishing.
          </p>
          <ul className="rounded-md border border-warning/40 bg-warning/5 p-4 text-sm">
            {shortfalls.map((s, i) => (
              <li key={i}>
                {s.type}
                {s.difficulty ? ` (${s.difficulty})` : ''}: asked for {s.requested}, found {s.found}
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">
            Usually this means the bank has too few <em>approved</em> questions for that department.
          </p>
          <Button onClick={onCreated}>Got it</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Schedule exam" action={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <form onSubmit={submit} className="space-y-4">
        {/* §4.3's maxExamsPerMonth lands here. ErrorNote renders which limit and
            what the plan allows. */}
        <ErrorNote error={error} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input
              value={form.nameEn}
              onChange={set('nameEn')}
              placeholder="Monthly Kitchen Exam"
              required
            />
          </Field>
          <Field label="Template" hint="Optional — copies its settings and rules">
            <Select value={form.templateId} onChange={set('templateId')}>
              <option value="">None</option>
              {(templates.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nameEn}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" required>
            <Input type="date" value={form.scheduledDate} onChange={set('scheduledDate')} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts" required>
              <Input type="time" value={form.startTime} onChange={set('startTime')} required />
            </Field>
            <Field label="Ends" required>
              <Input type="time" value={form.endTime} onChange={set('endTime')} required />
            </Field>
          </div>
          <Field label="Outlet" hint="Leave blank for every outlet">
            <Select value={form.outletId} onChange={set('outletId')}>
              <option value="">All outlets</option>
              {(outlets.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Department" hint="Leave blank for every department">
            <Select value={form.departmentId} onChange={set('departmentId')}>
              <option value="">All departments</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Duration (minutes)" required>
            <Input
              type="number"
              min="5"
              max="600"
              value={form.durationMinutes}
              onChange={set('durationMinutes')}
              required
            />
          </Field>
          <Field label="Pass mark (%)" required>
            <Input
              type="number"
              min="0"
              max="100"
              value={form.passingPercentage}
              onChange={set('passingPercentage')}
              required
            />
          </Field>
          <Field label="Number of MCQs" hint="§11.2: picked at random from approved questions">
            <Input type="number" min="1" max="100" value={form.mcqCount} onChange={set('mcqCount')} />
          </Field>
        </div>

        <Button type="submit" loading={busy}>
          Create draft
        </Button>
        <p className="text-xs text-ink-muted">
          Created as a draft. Nothing is visible to staff until you assign and publish it (§11.1).
        </p>
      </form>
    </Card>
  )
}

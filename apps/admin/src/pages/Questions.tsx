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
 * §10 the question bank.
 *
 * The approval workflow is why this is a screen rather than a list: §10.2 says
 * a question goes draft → pending_review → approved, and only approved ones
 * reach an exam. A trainer needs to see what is stuck; an admin needs to clear
 * the queue.
 */

interface Question {
  id: string
  type: 'mcq' | 'theory' | 'video_image'
  difficulty: 'easy' | 'medium' | 'hard'
  status: 'draft' | 'pending_review' | 'approved' | 'archived'
  marks: string | number
  questionTextEn: string
  questionTextHi: string | null
  questionTextGu: string | null
  usageCount: number
}

interface Named {
  id: string
  name?: string
  nameEn?: string
  title?: string
}

const STATUS_TONE = {
  draft: 'neutral',
  pending_review: 'warning',
  approved: 'success',
  archived: 'neutral',
} as const

export function Questions() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [missing, setMissing] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const list = useApi<Paged<Question>>(
    `/questions${query({ page, limit: 20, search, status, type, missing_translation: missing })}`,
    [page, search, status, type, missing]
  )

  const act = async (id: string, action: 'approve' | 'reject') => {
    setError(null)
    try {
      await api.post(
        `/questions/${id}/${action}`,
        action === 'reject' ? { comments: 'Needs revision' } : {}
      )
      void list.refetch()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Question Bank</h1>
          <p className="text-sm text-ink-muted">
            {list.data ? `${list.data.meta.total} questions` : ' '}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Add question</Button>
      </header>

      {creating && (
        <CreateQuestion
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void list.refetch()
          }}
        />
      )}

      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <Input
            placeholder="Search question text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
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
            <option value="draft">Draft</option>
            <option value="pending_review">Pending review</option>
            <option value="approved">Approved</option>
            <option value="archived">Archived</option>
          </Select>
          <Select
            value={type}
            onChange={(e) => {
              setType(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Any type</option>
            <option value="mcq">MCQ</option>
            <option value="theory">Theory</option>
            <option value="video_image">Video / image</option>
          </Select>
          {/* §10.5's own report: "questions without Hindi/Gujarati". §6 makes
              all three languages first-class, so a bank that is 90% English-only
              is a fact the trainer needs surfaced, not buried. */}
          <Select
            value={missing}
            onChange={(e) => {
              setMissing(e.target.value)
              setPage(1)
            }}
          >
            <option value="">Any translation</option>
            <option value="hi">Missing Hindi</option>
            <option value="gu">Missing Gujarati</option>
          </Select>
        </div>

        <ErrorNote error={error ?? list.error} />

        {list.loading && !list.data ? (
          <Spinner />
        ) : !list.data?.data.length ? (
          <Empty
            title="No questions match"
            hint={
              search || status || type || missing
                ? 'Try clearing the filters.'
                : 'Add your first question, or import a spreadsheet.'
            }
          />
        ) : (
          <>
            <Table head={['Question', 'Type', 'Difficulty', 'Languages', 'Used', 'Status', '']}>
              {list.data.data.map((q) => (
                <tr key={q.id}>
                  <td className="max-w-md px-4 py-2">{q.questionTextEn}</td>
                  <td className="px-4 py-2 text-ink-muted">{q.type.replace('_', '/')}</td>
                  <td className="px-4 py-2 text-ink-muted">{q.difficulty}</td>
                  <td className="px-4 py-2">
                    {/* At a glance: which of §6's three languages this exists
                        in. A missing one means staff reading Gujarati get the
                        English fallback. */}
                    <span className="font-mono text-xs text-ink-muted">
                      EN
                      {q.questionTextHi ? ' HI' : ''}
                      {q.questionTextGu ? ' GU' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{q.usageCount}</td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS_TONE[q.status]}>{q.status.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {q.status === 'pending_review' && (
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={() => void act(q.id, 'reject')}>
                          Reject
                        </Button>
                        <Button onClick={() => void act(q.id, 'approve')}>Approve</Button>
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

function CreateQuestion({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const departments = useApi<Named[]>('/departments')
  const topics = useApi<Paged<Named>>('/topics?limit=100')
  const documents = useApi<Paged<Named>>('/source-documents?limit=100')

  const [type, setType] = useState<'mcq' | 'theory' | 'video_image'>('mcq')
  const [form, setForm] = useState({
    difficulty: 'medium',
    departmentId: '',
    topicId: '',
    sourceDocumentId: '',
    questionTextEn: '',
    questionTextHi: '',
    questionTextGu: '',
    marks: '1',
  })
  // §10.1 requires four options on an MCQ. Fixed at four rather than a dynamic
  // list: the API rejects anything else, so an "add option" button would be a
  // path to a guaranteed 400.
  const [options, setOptions] = useState(['', '', '', ''])
  const [correct, setCorrect] = useState('A')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)

    try {
      await api.post('/questions', {
        type,
        difficulty: form.difficulty,
        departmentId: form.departmentId,
        ...(form.topicId ? { topicId: form.topicId } : {}),
        ...(form.sourceDocumentId ? { sourceDocumentId: form.sourceDocumentId } : {}),
        questionTextEn: form.questionTextEn,
        // Empty strings would fail the API's validation; §6's trilingual columns
        // want a real absence, which is what omitting them means.
        ...(form.questionTextHi ? { questionTextHi: form.questionTextHi } : {}),
        ...(form.questionTextGu ? { questionTextGu: form.questionTextGu } : {}),
        marks: Number(form.marks),
        ...(type === 'mcq'
          ? {
              options: options.map((text, i) => ({
                id: String.fromCharCode(65 + i),
                text_en: text,
                is_correct: String.fromCharCode(65 + i) === correct,
              })),
            }
          : {}),
      })
      onCreated()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Add question" action={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <form onSubmit={submit} className="space-y-4">
        {/* §4.3's questionTypes gate lands here: a Starter tenant choosing
            "theory" gets PLAN_FEATURE_LOCKED, and ErrorNote renders the upgrade
            message rather than a bare failure. */}
        <ErrorNote error={error} />

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Type" required>
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="mcq">Multiple choice</option>
              <option value="theory">Theory</option>
              <option value="video_image">Video / image</option>
            </Select>
          </Field>
          <Field label="Difficulty" required>
            <Select value={form.difficulty} onChange={set('difficulty')}>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </Select>
          </Field>
          <Field label="Marks" required>
            <Input
              type="number"
              min="0.5"
              step="0.5"
              value={form.marks}
              onChange={set('marks')}
              required
            />
          </Field>
          <Field label="Department" required>
            <Select value={form.departmentId} onChange={set('departmentId')} required>
              <option value="">Choose…</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Topic">
            <Select value={form.topicId} onChange={set('topicId')}>
              <option value="">None</option>
              {(topics.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nameEn}
                </option>
              ))}
            </Select>
          </Field>
          {/* §10.3: every question cites a source. The API refuses one with
              neither a document nor a chapter reference. */}
          <Field label="Source document" required hint="§10.3: questions cite their source">
            <Select value={form.sourceDocumentId} onChange={set('sourceDocumentId')} required>
              <option value="">Choose…</option>
              {(documents.data?.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Question (English)" required>
          <textarea
            className="w-full rounded-md border border-edge px-3 py-2 text-sm outline-none focus:border-primary"
            rows={2}
            value={form.questionTextEn}
            onChange={set('questionTextEn')}
            required
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Question (हिन्दी)" hint="Optional — falls back to English">
            <textarea
              className="w-full rounded-md border border-edge px-3 py-2 text-sm outline-none focus:border-primary"
              rows={2}
              lang="hi"
              value={form.questionTextHi}
              onChange={set('questionTextHi')}
            />
          </Field>
          <Field label="Question (ગુજરાતી)" hint="Optional — falls back to Hindi, then English">
            <textarea
              className="w-full rounded-md border border-edge px-3 py-2 text-sm outline-none focus:border-primary"
              rows={2}
              lang="gu"
              value={form.questionTextGu}
              onChange={set('questionTextGu')}
            />
          </Field>
        </div>

        {type === 'mcq' && (
          <fieldset className="rounded-md border border-edge p-4">
            <legend className="px-1 text-sm font-medium">Options (§10.1 requires four)</legend>
            <div className="space-y-2">
              {options.map((value, i) => {
                const letter = String.fromCharCode(65 + i)
                return (
                  <div key={letter} className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="correct"
                      checked={correct === letter}
                      onChange={() => setCorrect(letter)}
                      aria-label={`Option ${letter} is correct`}
                    />
                    <span className="w-4 text-sm font-medium text-ink-muted">{letter}</span>
                    <Input
                      value={value}
                      onChange={(e) =>
                        setOptions((o) => o.map((v, j) => (j === i ? e.target.value : v)))
                      }
                      placeholder={`Option ${letter}`}
                      required
                    />
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Select the radio next to the correct answer.
            </p>
          </fieldset>
        )}

        <Button type="submit" loading={busy}>
          Add question
        </Button>
      </form>
    </Card>
  )
}

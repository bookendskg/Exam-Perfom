import { useState } from 'react'
import { api, type Paged } from '../lib/api.js'
import { useApi } from '../lib/useApi.js'
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  Table,
} from '../components/ui.js'

/**
 * §10.3 source documents and topics.
 *
 * These exist because a question cannot be created without them: §10.3 requires
 * every question to cite a source, and the create form's document field is
 * required. Without this screen the question bank is unreachable — an empty
 * dropdown on a required field is a form that cannot be submitted, which is
 * exactly the dead end this closes.
 *
 * Deliberately paired with Questions rather than given its own nav item: nobody
 * sets out to "manage source documents", they set out to add a question and
 * discover they need one first.
 */

interface SourceDocument {
  id: string
  title: string
  type: string
  description: string | null
  fileUrl: string | null
  version: string | null
  isActive: boolean
  departmentId: string | null
}

interface Topic {
  id: string
  nameEn: string
  nameHi: string | null
  nameGu: string | null
  departmentId: string | null
  sourceDocumentId: string | null
  isActive: boolean
}

interface Named {
  id: string
  name: string
  code: string
}

const DOC_TYPES = [
  { value: 'sop', label: 'SOP' },
  { value: 'cookbook', label: 'Cookbook' },
  { value: 'recipe', label: 'Recipe' },
  { value: 'training_manual', label: 'Training manual' },
  { value: 'service_manual', label: 'Service manual' },
  { value: 'hygiene_guide', label: 'Hygiene guide' },
  { value: 'other', label: 'Other' },
]

export function Library() {
  const documents = useApi<Paged<SourceDocument>>('/source-documents?limit=100')
  const topics = useApi<Paged<Topic>>('/topics?limit=100')
  const departments = useApi<Named[]>('/departments')

  const [addingDoc, setAddingDoc] = useState(false)
  const [addingTopic, setAddingTopic] = useState(false)

  const noDocuments = !documents.loading && documents.data?.data.length === 0

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Library</h1>
        <p className="text-sm text-ink-muted">
          The sources and topics your questions are written from
        </p>
      </header>

      {/* The one thing a new tenant needs told. §10.3 makes a source mandatory
          on every question, so an empty library is a locked question bank — and
          the reason is not guessable from the form that rejects you. */}
      {noDocuments && (
        <div className="rounded-md border border-info/40 bg-info/5 px-4 py-3 text-sm">
          <p className="font-medium text-ink">Start here</p>
          <p className="mt-1 text-ink-muted">
            Every question must cite a source document (§10.3), so add one before writing
            questions. A topic is optional but makes weak-area reporting and training
            recommendations work.
          </p>
        </div>
      )}

      <Card
        title="Source documents"
        action={<Button onClick={() => setAddingDoc(true)}>Add document</Button>}
      >
        {addingDoc && (
          <div className="mb-4">
            <AddDocument
              departments={departments.data ?? []}
              onClose={() => setAddingDoc(false)}
              onCreated={() => {
                setAddingDoc(false)
                void documents.refetch()
              }}
            />
          </div>
        )}

        <ErrorNote error={documents.error} />
        {documents.loading && !documents.data ? (
          <Spinner />
        ) : !documents.data?.data.length ? (
          <Empty
            title="No source documents"
            hint="The cookbook, SOP or manual your questions come from."
          />
        ) : (
          <Table head={['Title', 'Type', 'Version', 'File', 'Status']}>
            {documents.data.data.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-2">{d.title}</td>
                <td className="px-4 py-2 text-ink-muted">{d.type.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2 text-ink-muted">{d.version ?? '—'}</td>
                <td className="px-4 py-2">
                  {d.fileUrl ? (
                    <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                      Open
                    </a>
                  ) : (
                    <span className="text-xs text-ink-muted">—</span>
                  )}
                </td>
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

      <Card title="Topics" action={<Button onClick={() => setAddingTopic(true)}>Add topic</Button>}>
        {addingTopic && (
          <div className="mb-4">
            <AddTopic
              departments={departments.data ?? []}
              documents={documents.data?.data ?? []}
              onClose={() => setAddingTopic(false)}
              onCreated={() => {
                setAddingTopic(false)
                void topics.refetch()
              }}
            />
          </div>
        )}

        <ErrorNote error={topics.error} />
        {topics.loading && !topics.data ? (
          <Spinner />
        ) : !topics.data?.data.length ? (
          <Empty
            title="No topics"
            hint="Topics are what weak-area reports and training recommendations are grouped by."
          />
        ) : (
          <Table head={['Topic', 'Languages', 'Source', 'Status']}>
            {topics.data.data.map((t) => {
              const doc = documents.data?.data.find((d) => d.id === t.sourceDocumentId)
              return (
                <tr key={t.id}>
                  <td className="px-4 py-2">{t.nameEn}</td>
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs text-ink-muted">
                      EN{t.nameHi ? ' HI' : ''}
                      {t.nameGu ? ' GU' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{doc?.title ?? '—'}</td>
                  <td className="px-4 py-2">
                    <Badge tone={t.isActive ? 'success' : 'neutral'}>
                      {t.isActive ? 'active' : 'inactive'}
                    </Badge>
                  </td>
                </tr>
              )
            })}
          </Table>
        )}
      </Card>
    </div>
  )
}

function AddDocument({
  departments,
  onClose,
  onCreated,
}: {
  departments: Named[]
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    title: '',
    type: 'sop',
    description: '',
    fileUrl: '',
    version: '1.0',
    departmentId: '',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/source-documents', {
        title: form.title,
        type: form.type,
        ...(form.description ? { description: form.description } : {}),
        // The API validates this as a URL, so an empty string is a 400 rather
        // than an absence.
        ...(form.fileUrl ? { fileUrl: form.fileUrl } : {}),
        ...(form.version ? { version: form.version } : {}),
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
      })
      onCreated()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border border-edge p-4">
      <ErrorNote error={error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Title" required>
          <Input
            value={form.title}
            onChange={set('title')}
            placeholder="Food Safety Manual"
            required
          />
        </Field>
        <Field label="Type" required>
          <Select value={form.type} onChange={set('type')}>
            {DOC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Version">
          <Input value={form.version} onChange={set('version')} placeholder="1.0" />
        </Field>
        <Field label="Department" hint="Leave blank if it applies to everyone">
          <Select value={form.departmentId} onChange={set('departmentId')}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        {/* A link, not an upload: there is no file storage configured, and a
            file picker that silently discarded the file would be worse than
            asking for somewhere it already lives. */}
        <Field label="Link" hint="A URL to the document — uploads are not supported yet">
          <Input
            type="url"
            value={form.fileUrl}
            onChange={set('fileUrl')}
            placeholder="https://drive.google.com/…"
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          className="w-full rounded-md border border-edge px-3 py-2 text-sm outline-none focus:border-primary"
          rows={2}
          value={form.description}
          onChange={set('description')}
        />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" loading={busy}>
          Add document
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function AddTopic({
  departments,
  documents,
  onClose,
  onCreated,
}: {
  departments: Named[]
  documents: SourceDocument[]
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    nameEn: '',
    nameHi: '',
    nameGu: '',
    departmentId: '',
    sourceDocumentId: '',
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/topics', {
        nameEn: form.nameEn,
        ...(form.nameHi ? { nameHi: form.nameHi } : {}),
        ...(form.nameGu ? { nameGu: form.nameGu } : {}),
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        ...(form.sourceDocumentId ? { sourceDocumentId: form.sourceDocumentId } : {}),
      })
      onCreated()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border border-edge p-4">
      <ErrorNote error={error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name (English)" required>
          <Input value={form.nameEn} onChange={set('nameEn')} placeholder="Food Safety" required />
        </Field>
        <Field label="नाम (हिन्दी)">
          <Input lang="hi" value={form.nameHi} onChange={set('nameHi')} placeholder="खाद्य सुरक्षा" />
        </Field>
        <Field label="નામ (ગુજરાતી)">
          <Input lang="gu" value={form.nameGu} onChange={set('nameGu')} placeholder="ખાદ્ય સલામતી" />
        </Field>
        <Field label="Department">
          <Select value={form.departmentId} onChange={set('departmentId')}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Source document"
          hint="Training assigned for this topic points here"
        >
          <Select value={form.sourceDocumentId} onChange={set('sourceDocumentId')}>
            <option value="">None</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={busy}>
          Add topic
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

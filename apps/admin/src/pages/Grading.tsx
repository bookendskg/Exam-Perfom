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
 * §9 the grading queue.
 *
 * MCQs auto-grade; theory and video/image answers wait for a human. This screen
 * is that human's whole job, so it is built around one question: what is the
 * oldest thing waiting, and what does a good answer look like.
 *
 * Two levels, deliberately. The queue lists responses; opening one loads the
 * WHOLE paper (§9's /grading/:id/responses) — because marking question 3 of a
 * candidate's exam without seeing questions 1 and 2 is how a grader loses the
 * thread of what that person actually knows.
 */

interface PendingResponse {
  id: string
  responseType: 'theory' | 'video_image'
  maxMarks: string | number
  examAssignment: {
    id: string
    submittedAt: string | null
    employee: { id: string; employeeCode: string | null; firstName: string; lastName: string }
    exam: { id: string; examCode: string; nameEn: string }
  }
  question: { id: string; type: string; questionTextEn: string; difficulty: string }
}

interface PaperResponse {
  id: string
  responseType: string
  theoryAnswer: string | null
  mediaUrls: string[]
  marksObtained: string | number | null
  maxMarks: string | number
  graderComments: string | null
  question: {
    id: string
    questionTextEn: string
    expectedAnswerEn: string | null
    rubric: Array<{ criterion: string; max_marks: number; description?: string }> | null
  }
}

interface Paper {
  assignment: {
    id: string
    status: string
    employee: { firstName: string; lastName: string; employeeCode: string | null }
    exam: { examCode: string; nameEn: string; totalMarks: string | number }
  }
  responses: PaperResponse[]
}

export function Grading() {
  const [page, setPage] = useState(1)
  const [type, setType] = useState('')
  const [openPaper, setOpenPaper] = useState<string | null>(null)

  const queue = useApi<Paged<PendingResponse>>(
    `/grading/pending${query({ page, limit: 20, type })}`,
    [page, type]
  )

  if (openPaper) {
    return (
      <MarkPaper
        assignmentId={openPaper}
        onClose={() => {
          setOpenPaper(null)
          void queue.refetch()
        }}
      />
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Grading</h1>
          <p className="text-sm text-ink-muted">
            {queue.data ? `${queue.data.meta.total} answers waiting` : ' '}
          </p>
        </div>
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1) }} className="w-48">
          <option value="">Theory and video/image</option>
          <option value="theory">Theory only</option>
          <option value="video_image">Video / image only</option>
        </Select>
      </header>

      <Card>
        <ErrorNote error={queue.error} />

        {queue.loading && !queue.data ? (
          <Spinner />
        ) : !queue.data?.data.length ? (
          // Genuinely good news, so say so rather than showing an empty table.
          <Empty
            title="Nothing to grade"
            hint="Multiple-choice answers mark themselves. Written answers appear here once a candidate submits."
          />
        ) : (
          <>
            <Table head={['Waiting since', 'Candidate', 'Exam', 'Question', 'Type', '']}>
              {queue.data.data.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 text-ink-muted">
                    {r.examAssignment.submittedAt
                      ? new Date(r.examAssignment.submittedAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {r.examAssignment.employee.firstName} {r.examAssignment.employee.lastName}
                    <span className="ml-2 font-mono text-xs text-ink-muted">
                      {r.examAssignment.employee.employeeCode}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{r.examAssignment.exam.examCode}</td>
                  <td className="max-w-xs px-4 py-2">{r.question.questionTextEn}</td>
                  <td className="px-4 py-2">
                    <Badge tone="info">{r.responseType.replace('_', '/')}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button onClick={() => setOpenPaper(r.examAssignment.id)}>Open paper</Button>
                  </td>
                </tr>
              ))}
            </Table>
            <Pager
              page={queue.data.meta.page}
              totalPages={queue.data.meta.totalPages}
              total={queue.data.meta.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  )
}

/** One candidate's whole paper, marked question by question. */
function MarkPaper({ assignmentId, onClose }: { assignmentId: string; onClose: () => void }) {
  const paper = useApi<Paper>(`/grading/${assignmentId}/responses`)
  const [error, setError] = useState<unknown>(null)
  const [finalising, setFinalising] = useState(false)
  const [remarks, setRemarks] = useState('')

  const ungraded = (paper.data?.responses ?? []).filter(
    (r) => r.marksObtained === null && r.responseType !== 'mcq'
  ).length

  const finalize = async () => {
    setFinalising(true)
    setError(null)
    try {
      await api.post(`/grading/${assignmentId}/finalize`, remarks ? { supervisorRemarks: remarks } : {})
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setFinalising(false)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Button variant="ghost" onClick={onClose} className="mb-1 px-0">
            ← Back to queue
          </Button>
          <h1 className="text-xl font-semibold text-ink">
            {paper.data
              ? `${paper.data.assignment.employee.firstName} ${paper.data.assignment.employee.lastName}`
              : 'Paper'}
          </h1>
          <p className="text-sm text-ink-muted">
            {paper.data?.assignment.exam.examCode} · {paper.data?.assignment.exam.nameEn}
          </p>
        </div>
      </header>

      <ErrorNote error={error ?? paper.error} />

      {paper.loading && !paper.data ? (
        <Spinner label="Loading paper" />
      ) : (
        <>
          <div className="space-y-4">
            {(paper.data?.responses ?? []).map((r, i) => (
              <MarkResponse
                key={r.id}
                index={i + 1}
                response={r}
                onGraded={() => void paper.refetch()}
              />
            ))}
          </div>

          <Card title="Finish">
            <div className="space-y-4">
              {/* §9 will not finalise a paper with anything unmarked — it
                  computes the total from every response, and a null would make
                  the grade a lie. Saying so beats a 409 the grader has to
                  interpret. */}
              {ungraded > 0 ? (
                <p className="text-sm text-warning">
                  {ungraded} {ungraded === 1 ? 'answer is' : 'answers are'} still unmarked. Finish
                  them before finalising.
                </p>
              ) : (
                <p className="text-sm text-ink-muted">
                  Every answer is marked. Finalising computes the grade and releases the result.
                </p>
              )}

              <Field label="Supervisor remarks" hint="Optional — appears on the employee's record">
                <textarea
                  className="w-full rounded-md border border-edge px-3 py-2 text-sm outline-none focus:border-primary"
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                />
              </Field>

              <Button loading={finalising} disabled={ungraded > 0} onClick={() => void finalize()}>
                Finalise and release result
              </Button>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

function MarkResponse({
  index,
  response,
  onGraded,
}: {
  index: number
  response: PaperResponse
  onGraded: () => void
}) {
  const graded = response.marksObtained !== null
  const rubric = response.question.rubric

  const [marks, setMarks] = useState(graded ? String(response.marksObtained) : '')
  const [comments, setComments] = useState(response.graderComments ?? '')
  const [scores, setScores] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  // §9: a rubric-scored answer derives its total from the criteria, so showing
  // a marks box as well would invite two different answers to the same question.
  const usesRubric = Boolean(rubric?.length)
  const rubricTotal = usesRubric
    ? Object.values(scores).reduce((sum, v) => sum + (Number(v) || 0), 0)
    : 0

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post(
        `/grading/${response.id}/grade`,
        usesRubric
          ? {
              rubricScores: (rubric ?? []).map((c) => ({
                criterion: c.criterion,
                marks: Number(scores[c.criterion] ?? 0),
              })),
              ...(comments ? { comments } : {}),
            }
          : { marks: Number(marks), ...(comments ? { comments } : {}) }
      )
      onGraded()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title={`Question ${index}`}
      action={
        graded ? (
          <Badge tone="success">
            {String(response.marksObtained)} / {String(response.maxMarks)}
          </Badge>
        ) : (
          <Badge tone="warning">Unmarked</Badge>
        )
      }
    >
      <div className="space-y-4">
        <p className="text-sm font-medium text-ink">{response.question.questionTextEn}</p>

        {/* The candidate's answer. */}
        {response.responseType === 'theory' ? (
          <blockquote className="rounded-md border-l-2 border-primary bg-canvas px-4 py-3 text-sm">
            {response.theoryAnswer || <span className="text-ink-muted">No answer given</span>}
          </blockquote>
        ) : (
          <div className="rounded-md bg-canvas p-4 text-sm">
            {response.mediaUrls.length === 0 ? (
              <span className="text-ink-muted">No media uploaded</span>
            ) : (
              <ul className="space-y-1">
                {response.mediaUrls.map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
                      {url.split('/').pop()}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* §9: the model answer IS shown here — a grader cannot mark a theory
            answer without knowing what a good one looks like. */}
        {response.question.expectedAnswerEn && (
          <details className="rounded-md border border-edge p-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink-muted">Model answer</summary>
            <p className="mt-2 text-ink">{response.question.expectedAnswerEn}</p>
          </details>
        )}

        <ErrorNote error={error} />

        {usesRubric ? (
          <div className="space-y-2">
            {(rubric ?? []).map((c) => (
              <div key={c.criterion} className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-sm text-ink">{c.criterion}</p>
                  {c.description && <p className="text-xs text-ink-muted">{c.description}</p>}
                </div>
                <Input
                  type="number"
                  min="0"
                  max={c.max_marks}
                  step="0.5"
                  className="w-20"
                  value={scores[c.criterion] ?? ''}
                  onChange={(e) => setScores((s) => ({ ...s, [c.criterion]: e.target.value }))}
                />
                <span className="w-12 text-sm text-ink-muted">/ {c.max_marks}</span>
              </div>
            ))}
            <p className="text-right text-sm font-medium">
              Total: {rubricTotal} / {String(response.maxMarks)}
            </p>
          </div>
        ) : (
          <Field label={`Marks (out of ${String(response.maxMarks)})`} required>
            <Input
              type="number"
              min="0"
              max={Number(response.maxMarks)}
              step="0.5"
              className="w-32"
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
            />
          </Field>
        )}

        <Field label="Comments" hint="Shown to the employee with their result">
          <textarea
            className="w-full rounded-md border border-edge px-3 py-2 text-sm outline-none focus:border-primary"
            rows={2}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
          />
        </Field>

        <Button loading={busy} onClick={() => void submit()}>
          {graded ? 'Update mark' : 'Save mark'}
        </Button>
      </div>
    </Card>
  )
}

import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApi } from '../lib/useApi'
import { api, ApiError } from '../lib/api'
import { Async, Badge, Button, Card, Field, Input, PageHeader, Textarea } from '../components/ui'

interface RubricCriterion {
  criterion: string
  maxMarks: number
}

interface GradingResponse {
  examQuestionId: string
  responseType: 'mcq' | 'theory' | 'video_image'
  selectedOptionId: string | null
  theoryAnswer: string | null
  mediaUrls: string[]
  isCorrect: boolean | null
  isSkipped: boolean | null
  marksObtained: string | number | null
  maxMarks: string | number
  isAutoGraded: boolean | null
  graderComments: string | null
  rubricScores: Record<string, number> | null
  question: {
    id: string
    type: string
    questionTextEn: string
    expectedAnswerEn: string | null
    rubric: RubricCriterion[] | null
  }
}

interface AttemptDetail {
  assignment: {
    id: string
    status: string
    submittedAt: string | null
    percentage: string | number | null
    grade: string | null
    passed: boolean | null
    employee: { firstName: string; lastName: string | null; employeeCode: string | null }
    exam: { examCode: string; nameEn: string; totalMarks: string | number }
  }
  responses: GradingResponse[]
  ungraded: number
}

/** One theory answer, with the model answer beside it. */
function TheoryCard({
  response,
  assignmentId,
  onSaved,
}: {
  response: GradingResponse
  assignmentId: string
  onSaved: () => void
}) {
  const max = Number(response.maxMarks)
  const [marks, setMarks] = useState(
    response.marksObtained == null ? '' : String(Number(response.marksObtained))
  )
  const [comments, setComments] = useState(response.graderComments ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.put(`/grading/assignments/${assignmentId}/theory/${response.examQuestionId}`, {
        marksObtained: Number(marks),
        graderComments: comments || null,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this mark')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <h3 className="font-medium text-stone-900">{response.question.questionTextEn}</h3>
        <Badge tone={response.marksObtained == null ? 'warn' : 'good'}>
          {response.marksObtained == null ? 'Not marked' : `${Number(response.marksObtained)} / ${max}`}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">
            Their answer
          </div>
          <div className="rounded-md bg-stone-50 p-3 text-sm text-stone-800">
            {response.isSkipped && !response.theoryAnswer ? (
              <span className="italic text-stone-400">Skipped — no answer given</span>
            ) : (
              response.theoryAnswer
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">
            Model answer
          </div>
          <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
            {response.question.expectedAnswerEn ?? (
              <span className="italic text-emerald-700/60">None recorded</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="w-32">
          <Field label={`Marks (max ${max})`}>
            <Input
              type="number"
              min={0}
              max={max}
              step="0.5"
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
            />
          </Field>
        </div>
        <div className="min-w-[16rem] flex-1">
          <Field label="Comments">
            <Input
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Optional feedback for the candidate"
            />
          </Field>
        </div>
        <Button onClick={save} disabled={busy || marks === ''}>
          {busy ? 'Saving…' : 'Save mark'}
        </Button>
      </div>

      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
    </Card>
  )
}

/** One video/image answer, scored per §10.1 criterion. */
function RubricCard({
  response,
  assignmentId,
  onSaved,
}: {
  response: GradingResponse
  assignmentId: string
  onSaved: () => void
}) {
  const criteria = response.question.rubric ?? []
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      criteria.map((c) => [c.criterion, String(response.rubricScores?.[c.criterion] ?? '')])
    )
  )
  const [comments, setComments] = useState(response.graderComments ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const total = Object.values(scores).reduce((sum, v) => sum + (Number(v) || 0), 0)
  const max = Number(response.maxMarks)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.put(`/grading/assignments/${assignmentId}/rubric/${response.examQuestionId}`, {
        rubricScores: Object.fromEntries(
          Object.entries(scores)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, Number(v)])
        ),
        graderComments: comments || null,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save these scores')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <h3 className="font-medium text-stone-900">{response.question.questionTextEn}</h3>
        <Badge tone={response.marksObtained == null ? 'warn' : 'good'}>
          {response.marksObtained == null ? 'Not marked' : `${Number(response.marksObtained)} / ${max}`}
        </Badge>
      </div>

      {response.mediaUrls.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {response.mediaUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-brand-700 hover:bg-stone-50"
            >
              Open submission ↗
            </a>
          ))}
        </div>
      ) : (
        <div className="mb-4 text-sm italic text-stone-400">Nothing was uploaded</div>
      )}

      <div className="space-y-2">
        {criteria.map((c) => (
          <div key={c.criterion} className="flex items-center gap-3">
            <span className="flex-1 text-sm text-stone-700">{c.criterion}</span>
            <Input
              type="number"
              min={0}
              max={c.maxMarks}
              step="0.5"
              value={scores[c.criterion] ?? ''}
              onChange={(e) => setScores((s) => ({ ...s, [c.criterion]: e.target.value }))}
              className="w-20"
            />
            <span className="w-12 text-sm text-stone-400">/ {c.maxMarks}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 text-right text-sm text-stone-600">
        Total <span className="font-semibold text-stone-900">{total}</span> / {max}
      </div>

      <div className="mt-4">
        <Field label="Comments">
          <Textarea rows={2} value={comments} onChange={(e) => setComments(e.target.value)} />
        </Field>
      </div>

      <div className="mt-3 flex justify-end">
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save scores'}
        </Button>
      </div>

      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
    </Card>
  )
}

/** An MCQ, already settled by Module 7 — shown for context, not editable here. */
function AutoGradedCard({ response }: { response: GradingResponse }) {
  return (
    <Card className="border-stone-100 bg-stone-50/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-stone-700">{response.question.questionTextEn}</div>
          <div className="mt-1 text-xs text-stone-400">
            Multiple choice · graded automatically
            {response.isAutoGraded === false && ' · overridden'}
          </div>
        </div>
        <Badge tone={response.isCorrect ? 'good' : 'bad'}>
          {Number(response.marksObtained ?? 0)} / {Number(response.maxMarks)}
        </Badge>
      </div>
    </Card>
  )
}

export function GradeAttemptPage() {
  const { assignmentId = '' } = useParams()
  const navigate = useNavigate()
  const attempt = useApi<AttemptDetail>(`/grading/assignments/${assignmentId}`)
  const [remarks, setRemarks] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const finalise = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/grading/assignments/${assignmentId}/finalise`, {
        supervisorRemarks: remarks || null,
      })
      navigate('/grading')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not finalise')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Link to="/grading" className="mb-4 inline-block text-sm text-stone-500 hover:text-stone-800">
        ← Back to grading
      </Link>

      <Async state={attempt}>
        {(data) => (
          <>
            <PageHeader
              title={`${data.assignment.employee.firstName} ${data.assignment.employee.lastName ?? ''}`}
              subtitle={`${data.assignment.exam.nameEn} · ${data.assignment.exam.examCode} · ${Number(
                data.assignment.exam.totalMarks
              )} marks`}
            />

            <div className="mb-6 space-y-4">
              {data.responses.map((r) =>
                r.responseType === 'theory' ? (
                  <TheoryCard
                    key={r.examQuestionId}
                    response={r}
                    assignmentId={assignmentId}
                    onSaved={attempt.reload}
                  />
                ) : r.responseType === 'video_image' ? (
                  <RubricCard
                    key={r.examQuestionId}
                    response={r}
                    assignmentId={assignmentId}
                    onSaved={attempt.reload}
                  />
                ) : (
                  <AutoGradedCard key={r.examQuestionId} response={r} />
                )
              )}
            </div>

            <Card className="p-5">
              <h3 className="mb-3 font-medium text-stone-900">Finalise</h3>

              {data.ungraded > 0 ? (
                <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {data.ungraded} answer{data.ungraded === 1 ? '' : 's'} still unmarked. Finalising
                  now will not release the result — an unmarked answer is never scored zero
                  automatically.
                </div>
              ) : (
                <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                  Everything is marked. Finalising releases the result to the candidate.
                </div>
              )}

              <Field label="Supervisor remarks (shown with their result)">
                <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </Field>

              {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

              <div className="mt-4 flex justify-end">
                <Button onClick={finalise} disabled={busy}>
                  {busy ? 'Finalising…' : 'Finalise'}
                </Button>
              </div>
            </Card>
          </>
        )}
      </Async>
    </>
  )
}

import { useState } from 'react'
import { useApi } from '../lib/useApi'
import { Async, Badge, Button, Card, PageHeader, Table } from '../components/ui'

interface Question {
  id: string
  type: 'mcq' | 'theory' | 'video_image'
  difficulty: 'easy' | 'medium' | 'hard'
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived'
  marks: string | number
  questionTextEn: string
  questionTextHi: string | null
  questionTextGu: string | null
  tags: string[]
  usageCount: number
}

const TYPE_LABEL: Record<Question['type'], string> = {
  mcq: 'Multiple choice',
  theory: 'Theory',
  video_image: 'Video / image',
}

const STATUS_TONE: Record<Question['status'], 'good' | 'warn' | 'bad' | 'neutral'> = {
  approved: 'good',
  pending_review: 'warn',
  draft: 'neutral',
  rejected: 'bad',
  archived: 'neutral',
}

/**
 * §6.3: which of the three languages a question actually has.
 *
 * Shown because §11.3 warns at publish time about untranslated questions, and
 * it is far cheaper to notice the gap while writing the bank than when an
 * exam is about to go out to Gujarati-speaking staff.
 */
function Languages({ q }: { q: Question }) {
  const has = [
    ['EN', true],
    ['हि', Boolean(q.questionTextHi?.trim())],
    ['ગુ', Boolean(q.questionTextGu?.trim())],
  ] as const

  return (
    <div className="flex gap-1">
      {has.map(([label, present]) => (
        <span
          key={label}
          className={`rounded px-1.5 py-0.5 text-xs ${
            present ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-400'
          }`}
          title={present ? `${label} available` : `${label} missing`}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

export function QuestionsPage() {
  const [type, setType] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [page, setPage] = useState(1)

  const questions = useApi<Question[]>('/questions', {
    page,
    limit: 20,
    type: type || undefined,
    status: status || undefined,
  })

  const filter = (
    label: string,
    value: string,
    setter: (v: string) => void,
    options: Array<[string, string]>
  ) => (
    <label className="text-sm">
      <span className="mr-2 text-stone-500">{label}</span>
      <select
        value={value}
        onChange={(e) => {
          setter(e.target.value)
          setPage(1)
        }}
        className="rounded-md border border-stone-300 px-2 py-1.5 text-sm"
      >
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <>
      <PageHeader title="Question bank" subtitle="§10 — the source of every exam" />

      <Card className="mb-4 flex flex-wrap gap-6 p-4">
        {filter('Type', type, setType, [
          ['mcq', 'Multiple choice'],
          ['theory', 'Theory'],
          ['video_image', 'Video / image'],
        ])}
        {filter('Status', status, setStatus, [
          ['draft', 'Draft'],
          ['pending_review', 'Pending review'],
          ['approved', 'Approved'],
          ['rejected', 'Rejected'],
          ['archived', 'Archived'],
        ])}
      </Card>

      <Card>
        <Async state={questions} empty="No questions match this filter.">
          {(rows) => (
            <>
              <Table
                head={['Question', 'Type', 'Difficulty', 'Marks', 'Languages', 'Used', 'Status']}
              >
                {rows.map((q) => (
                  <tr key={q.id} className="hover:bg-stone-50">
                    <td className="max-w-md px-4 py-3">
                      <div className="truncate font-medium text-stone-900" title={q.questionTextEn}>
                        {q.questionTextEn}
                      </div>
                      {q.tags.length > 0 && (
                        <div className="mt-1 text-xs text-stone-400">{q.tags.join(' · ')}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-stone-600">{TYPE_LABEL[q.type]}</td>
                    <td className="px-4 py-3 text-stone-600 capitalize">{q.difficulty}</td>
                    <td className="px-4 py-3 text-stone-600">{Number(q.marks)}</td>
                    <td className="px-4 py-3">
                      <Languages q={q} />
                    </td>
                    <td className="px-4 py-3 text-stone-500">{q.usageCount}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[q.status]}>{q.status.replace('_', ' ')}</Badge>
                    </td>
                  </tr>
                ))}
              </Table>

              {questions.meta && questions.meta.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-stone-200 px-4 py-3 text-sm">
                  <span className="text-stone-500">{questions.meta.total} questions</span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={page >= (questions.meta?.totalPages ?? 1)}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Async>
      </Card>
    </>
  )
}

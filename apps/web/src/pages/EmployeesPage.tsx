import { useState } from 'react'
import { useApi } from '../lib/useApi'
import { Async, Badge, Card, Input, PageHeader, Table, Button } from '../components/ui'

interface Employee {
  id: string
  employeeCode: string | null
  firstName: string
  lastName: string | null
  phone: string
  email: string | null
  outletId: string
  departmentId: string
  designationId: string
  joiningDate: string
  employmentType: string
  employmentStatus: string
}

interface NamedRef {
  id: string
  name: string
  code: string
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  active: 'good',
  probation: 'warn',
  on_leave: 'warn',
  suspended: 'bad',
  terminated: 'bad',
  resigned: 'neutral',
}

export function EmployeesPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const employees = useApi<Employee[]>('/employees', { page, limit: 20, search: search || undefined })
  const outlets = useApi<NamedRef[]>('/outlets')
  const departments = useApi<NamedRef[]>('/departments')

  // Ids are resolved to names client-side because the list endpoint returns
  // foreign keys rather than nested objects, and the reference lists are tiny.
  const nameOf = (list: NamedRef[] | null, id: string) => list?.find((r) => r.id === id)?.name ?? '—'

  return (
    <>
      <PageHeader title="Employees" subtitle="Everyone on the books, across all three outlets" />

      <Card className="mb-4 p-4">
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="Search by name, code or phone…"
          className="max-w-sm"
        />
      </Card>

      <Card>
        <Async state={employees} empty="No employees yet. Add them through the API or a bulk import.">
          {(rows) => (
            <>
              <Table head={['Code', 'Name', 'Phone', 'Outlet', 'Department', 'Status']}>
                {rows.map((e) => (
                  <tr key={e.id} className="hover:bg-stone-50">
                    <td className="px-4 py-3 font-mono text-xs text-stone-500">
                      {e.employeeCode ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-medium text-stone-900">
                      {e.firstName} {e.lastName ?? ''}
                    </td>
                    <td className="px-4 py-3 text-stone-600">{e.phone}</td>
                    <td className="px-4 py-3 text-stone-600">{nameOf(outlets.data, e.outletId)}</td>
                    <td className="px-4 py-3 text-stone-600">
                      {nameOf(departments.data, e.departmentId)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[e.employmentStatus] ?? 'neutral'}>
                        {e.employmentStatus.replace('_', ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </Table>

              {employees.meta && employees.meta.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-stone-200 px-4 py-3 text-sm">
                  <span className="text-stone-500">
                    Page {employees.meta.page} of {employees.meta.totalPages} · {employees.meta.total}{' '}
                    total
                  </span>
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
                      disabled={page >= (employees.meta?.totalPages ?? 1)}
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

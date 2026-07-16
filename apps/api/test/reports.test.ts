import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb, testTenantId, TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser, resetOutletManagers, usePlan } from './helpers/factories.js'
import { median, distribution } from '../src/reports/reports.service.js'
import { csvCell, toCsv } from '../src/reports/reports.export.js'

/**
 * Reports (§11) and their plan-gated export (§4.1).
 *
 * The export-tier tests exist because the flags they gate on were false on
 * EVERY plan — including Enterprise — until this module became the first code
 * to read them. Nothing caught it because nothing looked.
 */

let app: Application
let ctx: { topicId: string; otherTopicId: string; aikoId: string }

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp().app

  const tenantId = testTenantId()
  const kitchen = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
  const aiko = await testDb().outlet.findFirstOrThrow({ where: { tenantId, code: 'AK' } })
  const topic = await testDb().topic.create({
    data: { tenantId, nameEn: 'Food Safety', departmentId: kitchen.id },
  })
  const other = await testDb().topic.create({
    data: { tenantId, nameEn: 'Knife Skills', departmentId: kitchen.id },
  })

  ctx = { topicId: topic.id, otherTopicId: other.id, aikoId: aiko.id }
})

afterAll(async () => {
  await disconnectDb()
})

async function tokenFor(over: Parameters<typeof makeUser>[0] = {}) {
  const made = await makeUser({ role: 'admin', mustChangePassword: false, ...over })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

async function employeeWithHistory(
  months: Array<{ month: number; average: number; improvement?: number }>,
  opts: { outlet?: string; topicScores?: Record<string, { score: number; total: number }> } = {}
) {
  const made = await makeUser({
    role: 'staff',
    withEmployee: true,
    mustChangePassword: false,
    employeeOutletCode: opts.outlet ?? 'AK',
  })
  const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })

  for (const m of months) {
    await testDb().performanceSnapshot.create({
      data: {
        tenantId: testTenantId(),
        employeeId: employee.id,
        year: 2026,
        month: m.month,
        averageScore: m.average,
        examsAttempted: 2,
        examsPassed: m.average >= 40 ? 2 : 0,
        ...(m.improvement !== undefined ? { improvementFromLast: m.improvement } : {}),
        ...(opts.topicScores ? { topicScores: opts.topicScores } : {}),
      },
    })
  }

  return { ...made, employee }
}

describe('§11 the arithmetic', () => {
  it('median is robust to the one terrible score a mean cannot survive', () => {
    // Mean 46.5, median 87.5. The gap between them IS the signal that the group
    // is not the disaster the average suggests.
    expect(median([90, 85, 12, 99])).toBe(87.5)
    expect(median([90, 85, 80])).toBe(85)
    expect(median([])).toBeNull()
  })

  it('distribution buckets by decile, with 100 in the top bucket not an eleventh', () => {
    const buckets = distribution([0, 45, 99, 100])
    expect(buckets).toHaveLength(10)
    expect(buckets[0]).toEqual({ range: '0-9', count: 1 })
    expect(buckets[4]).toEqual({ range: '40-49', count: 1 })
    expect(buckets[9]).toEqual({ range: '90-100', count: 2 })
  })
})

describe('§11 CSV escaping — this data has commas and Devanagari in it', () => {
  it('quotes a cell containing a comma, so later columns do not shift', () => {
    expect(csvCell('Patel, Asha')).toBe('"Patel, Asha"')
  })

  it('doubles an embedded quote, per RFC 4180', () => {
    expect(csvCell('The "Grand" Hotel')).toBe('"The ""Grand"" Hotel"')
  })

  it('quotes a newline, which would otherwise end the row early', () => {
    expect(csvCell('Line one\nLine two')).toBe('"Line one\nLine two"')
  })

  it('leaves an ordinary cell unquoted', () => {
    expect(csvCell('Aiko')).toBe('Aiko')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(null)).toBe('')
  })

  it('emits a BOM, or Excel renders §6 Hindi and Gujarati as mojibake', () => {
    const csv = toCsv(['Topic'], [['खाद्य सुरक्षा']])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('खाद्य सुरक्षा')
  })

  it('uses CRLF, which is what Excel on Windows expects', () => {
    expect(toCsv(['A', 'B'], [[1, 2]])).toBe('﻿A,B\r\n1,2\r\n')
  })
})

describe('§11 employee report', () => {
  it('returns the trend oldest-first, because it is charted left to right', async () => {
    const { employee } = await employeeWithHistory([
      { month: 5, average: 60 },
      { month: 6, average: 70 },
      { month: 7, average: 80 },
    ])
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.trend.map((t: { month: number }) => t.month)).toEqual([5, 6, 7])
  })

  it('calls out the current standing rather than burying it in an array', async () => {
    const { employee } = await employeeWithHistory([
      { month: 6, average: 70 },
      { month: 7, average: 82 },
    ])
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))

    expect(res.body.data.current.period).toEqual({ year: 2026, month: 7 })
    expect(res.body.data.current.averageScore).toBe(82)
  })

  it('lists weak topics from the latest snapshot, weakest first', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 50 }], {
      topicScores: { [ctx.topicId]: { score: 2, total: 10 }, [ctx.otherTopicId]: { score: 5, total: 10 } },
    })
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))

    expect(res.body.data.weakTopics).toHaveLength(2)
    expect(res.body.data.weakTopics[0].percentage).toBe(20)
    expect(res.body.data.weakTopics[0].topic.nameEn).toBe('Food Safety')
  })

  it('does not call an untested topic a weakness', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 50 }], {
      topicScores: { [ctx.topicId]: { score: 0, total: 0 } },
    })
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))
    expect(res.body.data.weakTopics).toHaveLength(0)
  })

  it('handles an employee with no history at all', async () => {
    const { employee } = await employeeWithHistory([])
    const { token } = await tokenFor()

    // A new hire. The report must open rather than 500 — this is the state
    // every employee is in on their first day.
    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.current).toBeNull()
    expect(res.body.data.trend).toEqual([])
  })

  it('404s across outlets rather than confirming the employee exists', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }], { outlet: 'CP' })
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))
    expect(res.status).toBe(404)
  })
})

describe('§11 outlet report', () => {
  it('reports by department, because that is how a restaurant is managed', async () => {
    await employeeWithHistory([{ month: 7, average: 40 }], { outlet: 'AK' })
    await employeeWithHistory([{ month: 7, average: 90 }], { outlet: 'AK' })
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/outlet/${ctx.aikoId}?year=2026&month=7`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.summary.employeesAssessed).toBe(2)
    expect(res.body.data.summary.averageScore).toBe(65)
    expect(res.body.data.byDepartment[0].name).toBe('Kitchen')
  })

  it('reports median alongside mean', async () => {
    for (const average of [90, 85, 12, 99]) {
      await employeeWithHistory([{ month: 7, average }], { outlet: 'AK' })
    }
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/outlet/${ctx.aikoId}?year=2026&month=7`)
      .set(auth(token))

    expect(res.body.data.summary.averageScore).toBe(71.5)
    // One 12% drags the mean 16 points below the median. A report showing only
    // the mean would describe a competent outlet as a failing one.
    expect(res.body.data.summary.median).toBe(87.5)
  })

  it('excludes staff who have left', async () => {
    const gone = await employeeWithHistory([{ month: 7, average: 10 }], { outlet: 'AK' })
    await employeeWithHistory([{ month: 7, average: 90 }], { outlet: 'AK' })
    await testDb().employee.update({
      where: { id: gone.employee.id },
      data: { employmentStatus: 'resigned' },
    })
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/outlet/${ctx.aikoId}?year=2026&month=7`)
      .set(auth(token))
    expect(res.body.data.summary.employeesAssessed).toBe(1)
    expect(res.body.data.summary.averageScore).toBe(90)
  })

  it('refuses an outlet_manager another outlet’s figures (§3.2 treats them as sensitive)', async () => {
    const capiche = await testDb().outlet.findFirstOrThrow({
      where: { tenantId: testTenantId(), code: 'CP' },
    })
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/reports/outlet/${capiche.id}?year=2026&month=7`)
      .set(auth(token))
    expect(res.status).toBe(404)
  })
})

describe('§4.1 export is plan-gated', () => {
  /**
   * These flags were false on every tier including Enterprise — the seed never
   * set them, and this module is the first code to read them. Without these
   * tests, export would be locked for every paying customer and nothing would
   * say so.
   */
  it('refuses export on Starter, which is "Basic (in-app)" only', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    await usePlan('starter')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=csv&id=${employee.id}`)
      .set(auth(token))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PLAN_FEATURE_LOCKED')
    expect(res.body.error.details[0].message).toMatch(/Professional or above/)
  })

  it('allows export on Professional', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    await usePlan('professional')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=csv&id=${employee.id}`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
  })

  it('allows export on Enterprise — the tier that was silently locked', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    await usePlan('enterprise')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=csv&id=${employee.id}`)
      .set(auth(token))
    expect(res.status).toBe(200)
  })

  it('says UPGRADE to a Starter tenant asking for PDF, not "not built"', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    await usePlan('starter')
    const { token } = await tokenFor()

    // The plan gate runs first, deliberately: telling a Starter tenant that PDF
    // does not exist would be answering a question they have not earned, and
    // they would then not upgrade.
    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=pdf&id=${employee.id}`)
      .set(auth(token))
    expect(res.status).toBe(403)
  })

  it('says NOT BUILT to a Professional tenant asking for PDF, not "upgrade"', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    await usePlan('professional')
    const { token } = await tokenFor()

    // They have paid for it and it does not exist. Telling them to upgrade
    // would be a lie; serving a CSV named .pdf would be a worse one.
    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=pdf&id=${employee.id}`)
      .set(auth(token))

    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED')
    expect(res.body.error.message).toMatch(/format=csv/)
  })
})

describe('§11 CSV exports', () => {
  it('exports an employee’s history, one row per month', async () => {
    const { employee } = await employeeWithHistory([
      { month: 6, average: 70 },
      { month: 7, average: 80 },
    ])
    await usePlan('professional')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=csv&id=${employee.id}`)
      .set(auth(token))

    const lines = res.text.trim().split('\r\n')
    expect(lines[0]).toContain('Year,Month,Average Score')
    expect(lines).toHaveLength(3) // header + 2 months
    expect(lines[1]).toContain('2026,6,70')
  })

  it('names the file for what it is', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    await usePlan('professional')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=employee&format=csv&id=${employee.id}`)
      .set(auth(token))

    expect(res.headers['content-disposition']).toMatch(/attachment; filename="employee-.*\.csv"/)
  })

  it('exports an outlet roster for a period', async () => {
    await employeeWithHistory([{ month: 7, average: 80 }], { outlet: 'AK' })
    await usePlan('professional')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=outlet&format=csv&id=${ctx.aikoId}&year=2026&month=7`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.text).toContain('Employee Code,Name,Department')
  })

  it('refuses an outlet export with no period rather than guessing one', async () => {
    await usePlan('professional')
    const { token } = await tokenFor()

    const res = await request(app)
      .get(`/api/v1/reports/export?type=outlet&format=csv&id=${ctx.aikoId}`)
      .set(auth(token))
    expect(res.status).toBe(400)
  })

  it('is scoped: an outlet_manager cannot export another outlet', async () => {
    const capiche = await testDb().outlet.findFirstOrThrow({
      where: { tenantId: testTenantId(), code: 'CP' },
    })
    await usePlan('professional')
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/reports/export?type=outlet&format=csv&id=${capiche.id}&year=2026&month=7`)
      .set(auth(token))
    expect(res.status).toBe(404)
  })
})

describe('§3.2 report permissions', () => {
  it('lets hr read reports across outlets', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }], { outlet: 'CP' })
    const { token } = await tokenFor({ role: 'hr' })

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))
    expect(res.status).toBe(200)
  })

  it('refuses a trainer, who has no report permission at all', async () => {
    const { employee } = await employeeWithHistory([{ month: 7, average: 80 }])
    const { token } = await tokenFor({ role: 'trainer' })

    const res = await request(app)
      .get(`/api/v1/reports/employee/${employee.id}`)
      .set(auth(token))
    expect(res.status).toBe(403)
  })
})

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import ExcelJS from 'exceljs'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

let app: Application

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

async function tokenFor(opts: Parameters<typeof makeUser>[0]) {
  const made = await makeUser({ mustChangePassword: false, ...opts })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return res.body.data.accessToken as string
}

const HEADER = 'first_name,last_name,phone,outlet_code,department,designation,joining_date'

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8')
}

const upload = (token: string, buffer: Buffer, filename = 'staff.csv', query = '') =>
  request(app)
    .post(`/api/v1/employees/bulk-import${query}`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, filename)

describe('§8.3 bulk import — file handling', () => {
  it('rejects a request with no file', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/employees/bulk-import')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('file')
  })

  it('rejects an unsupported file type', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, Buffer.from('hello'), 'notes.txt')
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('Unsupported file type')
  })

  it('names every missing required column at once', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, Buffer.from('first_name,last_name\nAsha,Patel'))

    expect(res.status).toBe(400)
    const fields = res.body.error.details.map((d: { field: string }) => d.field)
    // An operator fixing their spreadsheet needs the whole list, not the first.
    expect(fields).toEqual(
      expect.arrayContaining(['phone', 'outlet_code', 'department', 'designation', 'joining_date'])
    )
  })

  it('rejects a file with headers but no rows', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv())
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('no data rows')
  })

  it('tolerates a UTF-8 BOM, which Excel writes on CSV export', async () => {
    const token = await tokenFor({ role: 'admin' })
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      csv('Asha,Patel,9811100001,AK,Kitchen,Line Cook,2026-02-01'),
    ])
    const res = await upload(token, withBom)
    // Without bom:true the first header parses as U+FEFF + "first_name",
    // so the file looks like it is missing first_name entirely.
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
  })

  it('accepts messy header casing and spacing', async () => {
    const token = await tokenFor({ role: 'admin' })
    const messy = Buffer.from(
      [
        'First Name,LAST_NAME, phone ,Outlet Code,Department,Designation,Joining Date',
        'Asha,Patel,9811100002,AK,Kitchen,Line Cook,2026-02-01',
      ].join('\n')
    )
    const res = await upload(token, messy)
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
  })
})

describe('§8.3 bulk import — validation and preview', () => {
  it('dryRun reports without writing anything', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv(
        'Asha,Patel,9811200001,AK,Kitchen,Line Cook,2026-02-01',
        'Ravi,Shah,9811200002,CP,Kitchen,Line Cook,2026-02-01'
      ),
      'staff.csv',
      '?dryRun=true'
    )

    expect(res.status).toBe(200)
    expect(res.body.data.dryRun).toBe(true)
    expect(res.body.data.valid).toBe(2)
    expect(res.body.data.imported).toBe(0)
    expect(await testDb().employee.count()).toBe(0)
  })

  it('reports per-row errors against the file’s own line numbers', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv(
        'Asha,Patel,9811300001,AK,Kitchen,Line Cook,2026-02-01', // line 2, ok
        'Ravi,Shah,9811300002,ZZ,Kitchen,Line Cook,2026-02-01' // line 3, bad outlet
      ),
      'staff.csv',
      '?dryRun=true'
    )

    const bad = res.body.data.rows.find((r: { lineNumber: number }) => r.lineNumber === 3)
    // Line 3, because the header is line 1 — the number must point at a row the
    // operator can actually find in their spreadsheet.
    const outlet = bad.errors.find((e: { field: string }) => e.field === 'outlet_code')
    expect(outlet, `no outlet_code error: ${JSON.stringify(bad.errors)}`).toBeDefined()
    expect(outlet.message).toContain('ZZ')
  })

  it('flags an unknown department and designation', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv('Asha,Patel,9811400001,AK,Wizardry,Archmage,2026-02-01'),
      'staff.csv',
      '?dryRun=true'
    )

    const fields = res.body.data.rows[0].errors.map((e: { field: string }) => e.field)
    expect(fields).toContain('department')
    expect(fields).toContain('designation')
  })

  it('flags a designation that belongs to a different department', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      // Line Cook is Kitchen; Service is not.
      csv('Asha,Patel,9811500001,AK,Service,Line Cook,2026-02-01'),
      'staff.csv',
      '?dryRun=true'
    )

    const err = res.body.data.rows[0].errors.find(
      (e: { field: string }) => e.field === 'designation'
    )
    expect(err.message).toContain('does not belong')
  })

  it('accepts department and designation by code as well as name', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv('Asha,Patel,9811600001,AK,KIT,LCOOK,2026-02-01'))
    expect(res.body.data.imported).toBe(1)
  })

  it('flags a bad date format', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv('Asha,Patel,9811700001,AK,Kitchen,Line Cook,01/02/2026'),
      'staff.csv',
      '?dryRun=true'
    )
    expect(res.body.data.rows[0].errors[0].field).toBe('joining_date')
  })

  it('flags a phone already registered in the database', async () => {
    const token = await tokenFor({ role: 'admin' })
    await makeUser({ phone: '9811800001' })

    const res = await upload(
      token,
      csv('Asha,Patel,9811800001,AK,Kitchen,Line Cook,2026-02-01'),
      'staff.csv',
      '?dryRun=true'
    )
    expect(res.body.data.rows[0].errors[0].message).toBe('Already registered')
  })

  it('flags a phone duplicated WITHIN the file', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv(
        'Asha,Patel,9811900001,AK,Kitchen,Line Cook,2026-02-01',
        'Ravi,Shah,9811900001,AK,Kitchen,Line Cook,2026-02-01'
      ),
      'staff.csv',
      '?dryRun=true'
    )

    // Invisible to a per-row database check: neither row is inserted yet, so
    // both look free.
    // 'Already registered' is pushed immediately before this one and carries
    // the same field, so select on the message rather than the position.
    const second = res.body.data.rows[1]
    const duplicate = second.errors.find((e: { message: string }) =>
      e.message.includes('Duplicated in this file')
    )
    expect(duplicate, `no in-file duplicate error: ${JSON.stringify(second.errors)}`).toBeDefined()
    expect(duplicate.message).toContain('row 2')
    expect(res.body.data.valid).toBe(1)
  })
})

describe('§8.3 bulk import — partial import', () => {
  it('imports the valid rows and skips the bad ones', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv(
        'Asha,Patel,9812000001,AK,Kitchen,Line Cook,2026-02-01', // ok
        'Ravi,Shah,9812000002,ZZ,Kitchen,Line Cook,2026-02-01', // bad outlet
        'Neha,Desai,9812000003,CP,Kitchen,Line Cook,2026-02-01' // ok
      )
    )

    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(2)
    expect(res.body.data.invalid).toBe(1)
    expect(await testDb().employee.count()).toBe(2)

    // The bad row wrote nothing at all — not a partial user record.
    expect(await testDb().user.findUnique({ where: { phone: '9812000002' } })).toBeNull()
  })

  it('reports the code and one-time password for each imported row', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv('Asha,Patel,9812100001,AK,Kitchen,Line Cook,2026-02-01'))

    const row = res.body.data.rows[0]
    expect(row.employeeCode).toBe('BK-AK-001')
    expect(row.temporaryPassword).toBe('0001book') // §7.3: last 4 + "book"
  })

  it('an imported employee can actually log in and is forced to change password', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv('Asha,Patel,9812200042,AK,Kitchen,Line Cook,2026-02-01'))

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: '9812200042', password: '0042book' })

    expect(login.status).toBe(200)
    expect(login.body.data.mustChangePassword).toBe(true)
  })

  it('assigns sequential codes across the batch without gaps', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(
      token,
      csv(
        'A,One,9812300001,AK,Kitchen,Line Cook,2026-02-01',
        'B,Two,9812300002,AK,Kitchen,Line Cook,2026-02-01',
        'C,Three,9812300003,AK,Kitchen,Line Cook,2026-02-01'
      )
    )

    expect(res.body.data.rows.map((r: { employeeCode: string }) => r.employeeCode)).toEqual([
      'BK-AK-001',
      'BK-AK-002',
      'BK-AK-003',
    ])
  })

  it('creates a joined timeline event for imported staff', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv('Asha,Patel,9812400001,AK,Kitchen,Line Cook,2026-02-01'))

    const employee = await testDb().employee.findFirstOrThrow({ where: { phone: '9812400001' } })
    const events = await testDb().employeeTimeline.findMany({ where: { employeeId: employee.id } })
    expect(events[0]!.eventType).toBe('joined')
    expect(events[0]!.description).toContain('bulk import')
  })
})

describe('§8.3 bulk import — Excel', () => {
  async function xlsx(rows: string[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Staff')
    sheet.addRow(HEADER.split(','))
    for (const r of rows) sheet.addRow(r)
    return Buffer.from(await wb.xlsx.writeBuffer())
  }

  it('imports a real .xlsx file', async () => {
    const token = await tokenFor({ role: 'admin' })
    const buffer = await xlsx([
      ['Asha', 'Patel', '9813000001', 'AK', 'Kitchen', 'Line Cook', '2026-02-01'],
    ])

    const res = await upload(token, buffer, 'staff.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
  })

  it('handles a real Date cell, which Excel gives back as a Date not a string', async () => {
    const token = await tokenFor({ role: 'admin' })
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Staff')
    sheet.addRow(HEADER.split(','))
    // A joining_date typed into Excel is a Date object, not "2026-02-01".
    sheet.addRow([
      'Asha',
      'Patel',
      '9813100001',
      'AK',
      'Kitchen',
      'Line Cook',
      new Date('2026-02-01'),
    ])
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())

    const res = await upload(token, buffer, 'staff.xlsx')
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
  })

  it('skips blank rows, which spreadsheets are full of', async () => {
    const token = await tokenFor({ role: 'admin' })
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Staff')
    sheet.addRow(HEADER.split(','))
    sheet.addRow(['Asha', 'Patel', '9813200001', 'AK', 'Kitchen', 'Line Cook', '2026-02-01'])
    sheet.addRow([])
    sheet.addRow(['Ravi', 'Shah', '9813200002', 'AK', 'Kitchen', 'Line Cook', '2026-02-01'])
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())

    const res = await upload(token, buffer, 'staff.xlsx')
    expect(res.body.data.imported).toBe(2)
    expect(res.body.data.invalid).toBe(0)
  })

  it('rejects a file that is not really xlsx', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, Buffer.from('definitely not a spreadsheet'), 'fake.xlsx')
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('Could not read the Excel file')
  })
})

describe('§8.3 bulk import — RBAC', () => {
  it('an outlet_manager cannot import into an outlet it does not manage', async () => {
    const token = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await upload(
      token,
      csv(
        'Asha,Patel,9814000001,AK,Kitchen,Line Cook,2026-02-01', // own outlet
        'Ravi,Shah,9814000002,CP,Kitchen,Line Cook,2026-02-01' // not theirs
      )
    )

    // One bad row must not reject the file — it is reported and skipped.
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
    // The scope error is the last of five push sites; any earlier one displaces it.
    expect(
      res.body.data.rows[1].errors.map((e: { message: string }) => e.message).join(' | ')
    ).toContain('do not manage this outlet')
    expect(await testDb().employee.count({ where: { phone: '9814000002' } })).toBe(0)
  })

  it('a staff member cannot bulk import', async () => {
    const token = await tokenFor({ role: 'staff', withEmployee: true })
    const res = await upload(token, csv('Asha,Patel,9814100001,AK,Kitchen,Line Cook,2026-02-01'))
    expect(res.status).toBe(403)
  })

  it('a trainer cannot bulk import', async () => {
    const token = await tokenFor({ role: 'trainer' })
    const res = await upload(token, csv('Asha,Patel,9814200001,AK,Kitchen,Line Cook,2026-02-01'))
    expect(res.status).toBe(403)
  })

  it('hr can bulk import across outlets', async () => {
    const token = await tokenFor({ role: 'hr' })
    const res = await upload(
      token,
      csv(
        'Asha,Patel,9814300001,AK,Kitchen,Line Cook,2026-02-01',
        'Ravi,Shah,9814300002,CP,Kitchen,Line Cook,2026-02-01'
      )
    )
    expect(res.body.data.imported).toBe(2)
  })

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/employees/bulk-import')
      .attach('file', csv('A,B,9814400001,AK,Kitchen,Line Cook,2026-02-01'), 'staff.csv')
    expect(res.status).toBe(401)
  })
})

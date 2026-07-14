import { parse as parseCsv } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import { ApiError } from '../http/api-error.js'

/**
 * §8.3 accepts "CSV or Excel". Both are normalised to the same shape — an array
 * of string-keyed rows, plus the 1-based spreadsheet line each came from, so
 * error reports point at a row the user can actually find in their file.
 */
export interface RawRow {
  /** 1-based row number as it appears in the file, header included. */
  lineNumber: number
  values: Record<string, string>
}

const MAX_ROWS = 2000

/** Header cells vary wildly in spreadsheets: "First Name", "FIRST_NAME ", "first name". */
export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '_')
}

function assertHeaders(headers: string[], required: readonly string[]): void {
  const present = new Set(headers.map(normaliseHeader))
  const missing = required.filter((c) => !present.has(c))
  if (missing.length > 0) {
    throw ApiError.validation(
      'The file is missing required columns',
      missing.map((c) => ({ field: c, message: `Column "${c}" is required` }))
    )
  }
}

function assertRowCount(count: number): void {
  if (count === 0) throw ApiError.validation('The file contains no data rows')
  if (count > MAX_ROWS) {
    throw ApiError.validation(
      `The file has ${count} rows; the limit is ${MAX_ROWS}. Split it into smaller files.`
    )
  }
}

export function parseCsvBuffer(buffer: Buffer, required: readonly string[]): RawRow[] {
  let records: Array<Record<string, string>>
  try {
    records = parseCsv(buffer, {
      columns: (headers: string[]) => {
        assertHeaders(headers, required)
        return headers.map(normaliseHeader)
      },
      skip_empty_lines: true,
      trim: true,
      bom: true, // Excel prefixes CSV exports with a BOM; without this the
      // first header parses as U+FEFF + "first_name" and looks missing.
      relax_column_count: true,
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw ApiError.validation(
      `Could not read the CSV file: ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }

  assertRowCount(records.length)
  // +2: one for the header row, one because spreadsheet rows are 1-based.
  return records.map((values, i) => ({ lineNumber: i + 2, values }))
}

export async function parseExcelBuffer(
  buffer: Buffer,
  required: readonly string[]
): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook()
  try {
    // Cast: @types/node 22 types Buffer as the generic Buffer<ArrayBufferLike>,
    // while exceljs's declarations predate that and expect the old plain Buffer.
    // The runtime value is identical — this is a typings mismatch only.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch {
    throw ApiError.validation('Could not read the Excel file. Is it a valid .xlsx?')
  }

  const sheet = workbook.worksheets[0]
  if (!sheet) throw ApiError.validation('The Excel file has no sheets')

  const headerRow = sheet.getRow(1)
  const headers: string[] = []
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = String(cell.value ?? '')
  })
  assertHeaders(headers.filter(Boolean), required)

  const rows: RawRow[] = []
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return

    const values: Record<string, string> = {}
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = normaliseHeader(headers[col - 1] ?? '')
      if (!key) return
      values[key] = cellToString(cell.value)
    })

    // Skip rows that are entirely blank — spreadsheets are full of them.
    if (Object.values(values).some((v) => v !== '')) {
      rows.push({ lineNumber: rowNumber, values })
    }
  })

  assertRowCount(rows.length)
  return rows
}

/**
 * Excel cells are not strings. A date column comes back as a Date, a phone
 * number as a number (losing any leading zero), and a formula as an object.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    // Normalise to the YYYY-MM-DD the row schema expects.
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim()
    if ('result' in value) return String(value.result ?? '').trim()
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((r) => r.text)
        .join('')
        .trim()
    }
    return ''
  }
  return String(value).trim()
}

export async function parseUpload(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  required: readonly string[]
): Promise<RawRow[]> {
  const isExcel =
    filename.toLowerCase().endsWith('.xlsx') ||
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  if (isExcel) return parseExcelBuffer(buffer, required)

  const isCsv = filename.toLowerCase().endsWith('.csv') || mimetype.includes('csv')
  if (isCsv) return parseCsvBuffer(buffer, required)

  throw ApiError.validation('Unsupported file type. Upload a .csv or .xlsx file.', [
    { field: 'file', message: `Received "${filename}" (${mimetype})` },
  ])
}

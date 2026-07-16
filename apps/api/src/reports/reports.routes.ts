import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { PlanService } from '../plans/plan.service.js'
import { ReportsService } from './reports.service.js'
import { assertFormatSupported, exportFilename, toCsv } from './reports.export.js'
import {
  employeeReportQuerySchema,
  examReportQuerySchema,
  exportQuerySchema,
  idParamSchema,
  outletReportQuerySchema,
  type EmployeeReportQuery,
  type ExamReportQuery,
  type ExportQuery,
  type OutletReportQuery,
} from './reports.schemas.js'

/** §5.3's /api/v1/reports. */
export function buildReportsRouter(deps: Deps) {
  const reports = new ReportsService(deps.prisma)
  const plans = new PlanService(deps.prisma)
  const router = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  /**
   * GET /api/v1/reports/export — §11, §4.1.
   *
   * Mounted FIRST so "export" is never read as an :id.
   *
   * Gated on the plan's pdfExport/excelExport flags. Those were false on every
   * tier — including Enterprise — until Module 11 became the first code to read
   * them; the seed simply never set them. Nothing caught it because nothing
   * looked.
   */
  router.get(
    '/export',
    requirePermission('report:export'),
    validate({ query: exportQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as ExportQuery
          const principal = requirePrincipal(req)
          const scope = scopeOf(req)

          // Plan gate BEFORE the format check, so the two answers stay
          // distinguishable: Starter asking for PDF is told to upgrade, and
          // Professional asking for PDF is told it does not exist yet.
          const plan = await plans.forTenant(principal.tenantId)
          const allowed = query.format === 'excel' ? plan.excelExport : plan.pdfExport
          if (!allowed) {
            throw ApiError.planFeatureLocked(`Your plan does not include report export`, [
              {
                field: 'format',
                message: `The ${plan.planCode} plan has in-app reports only. Export needs Professional or above.`,
              },
            ])
          }

          assertFormatSupported(query.format)

          const csv = await buildCsv(reports, principal, scope, query)
          res
            .status(200)
            .type('text/csv; charset=utf-8')
            .setHeader(
              'Content-Disposition',
              `attachment; filename="${exportFilename(query.type, query.id, query.format)}"`
            )
            .send(csv)
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/v1/reports/employee/:id
  router.get(
    '/employee/:id',
    requirePermission('report:read'),
    validate({ params: idParamSchema, query: employeeReportQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const query = req.valid!.query as EmployeeReportQuery
          res.json(ok(await reports.employee(requirePrincipal(req), scopeOf(req), id, query)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/v1/reports/exam/:id
  router.get(
    '/exam/:id',
    requirePermission('report:read'),
    validate({ params: idParamSchema, query: examReportQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const query = req.valid!.query as ExamReportQuery
          res.json(ok(await reports.exam(requirePrincipal(req), scopeOf(req), id, query)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/v1/reports/outlet/:id
  router.get(
    '/outlet/:id',
    requirePermission('report:read'),
    validate({ params: idParamSchema, query: outletReportQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const query = req.valid!.query as OutletReportQuery
          res.json(ok(await reports.outlet(requirePrincipal(req), scopeOf(req), id, query)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}

/**
 * The CSV shape per report type.
 *
 * One row per thing, flat — a spreadsheet is not a tree, and the nested JSON
 * the API returns has to be chosen from rather than flattened wholesale. Each
 * export answers the question its reader actually opened it for.
 */
async function buildCsv(
  reports: ReportsService,
  principal: Parameters<ReportsService['employee']>[0],
  scope: Parameters<ReportsService['employee']>[1],
  query: ExportQuery
): Promise<string> {
  switch (query.type) {
    case 'employee': {
      const report = await reports.employee(principal, scope, query.id, {
        months: 12,
        threshold: 60,
      })
      // A performance history: one row per month, which is what someone
      // exporting a person's record is looking at.
      return toCsv(
        ['Year', 'Month', 'Average Score', 'Change From Last', 'Employee', 'Employee Code'],
        report.trend.map((t) => [
          t.year,
          t.month,
          t.averageScore,
          t.improvementFromLast,
          `${report.employee.firstName} ${report.employee.lastName}`,
          report.employee.employeeCode,
        ])
      )
    }

    case 'exam': {
      const report = await reports.exam(principal, scope, query.id, {
        includeDistribution: false,
      })
      // One row per candidate: the mark sheet.
      return toCsv(
        ['Employee Code', 'Name', 'Outlet', 'Status', 'Percentage', 'Grade', 'Passed'],
        report.results.map((r) => [
          r.employee.employeeCode,
          `${r.employee.firstName} ${r.employee.lastName}`,
          r.employee.outlet?.code,
          r.status,
          r.percentage,
          r.grade,
          r.passed === null ? '' : r.passed ? 'Yes' : 'No',
        ])
      )
    }

    case 'outlet': {
      if (!query.year || !query.month) {
        throw ApiError.validation('An outlet export needs a period', [
          { field: 'year', message: 'Provide year and month' },
        ])
      }
      const report = await reports.outlet(principal, scope, query.id, {
        year: query.year,
        month: query.month,
        threshold: 60,
      })
      // One row per employee at the outlet.
      return toCsv(
        ['Employee Code', 'Name', 'Department', 'Average Score', 'Exams Attempted', 'Exams Passed'],
        report.employees.map((e) => [
          e.employeeCode,
          `${e.firstName} ${e.lastName}`,
          e.department?.name,
          e.averageScore,
          e.examsAttempted,
          e.examsPassed,
        ])
      )
    }
  }
}

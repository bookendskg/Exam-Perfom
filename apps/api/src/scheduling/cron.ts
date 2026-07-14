import cron, { type ScheduledTask } from 'node-cron'
import type { PrismaClient } from '@bookends/db'
import type { Logger } from 'pino'
import { SchedulerService } from './scheduler.service.js'
import { BOOKENDS_TIMEZONE } from './exam-date.js'

/**
 * §12.2: "Runs: 1st of every month at 00:00 IST".
 *
 * ── Why node-cron and not BullMQ ──────────────────────────────────────────
 *
 * §2.1 specifies Bull/BullMQ, which hard-requires Redis. This deployment has
 * no Redis (sessions live in Postgres for the same reason), so the job runs
 * in-process instead.
 *
 * What that costs, stated plainly:
 *
 *  - It runs on EVERY API instance. At two instances, two schedulers fire and
 *    both try to schedule the month. The conflict check in §12.2 step 4 makes
 *    that safe rather than catastrophic — the second sees the first's exam and
 *    reports a conflict — but it is a guard, not a design. Scaling out needs a
 *    real lock or BullMQ.
 *  - A missed run is silently missed. If the API is down at 00:00 IST on the
 *    1st, nothing retries; BullMQ would. The trigger-now endpoint is the manual
 *    recovery, and it accepts ?asOf= so a missed month can be re-run.
 *  - No visibility. There is no queue to inspect, only logs.
 *
 * At 300 staff and one exam a month this is proportionate. It stops being so
 * the moment the API runs on more than one instance — and §13's WhatsApp
 * notifications will need a real queue regardless, which is when Redis arrives
 * and this should move to BullMQ.
 */
const FIRST_OF_MONTH_AT_MIDNIGHT = '0 0 1 * *'

export function startExamScheduler(prisma: PrismaClient, logger: Logger): ScheduledTask {
  const scheduler = new SchedulerService(prisma, logger)

  const task = cron.schedule(
    FIRST_OF_MONTH_AT_MIDNIGHT,
    () => {
      void (async () => {
        logger.info('Auto-scheduling job starting (§12.2)')
        try {
          const run = await scheduler.run(new Date())
          if (run.conflicts > 0 || run.failed > 0) {
            // §12.2 step 6: flag for admin review. Until §13's notification
            // channel exists, the log is the only channel there is — so this is
            // logged at error level to make sure it is not missed.
            logger.error(
              { run },
              'Auto-scheduling finished with conflicts or failures; admin review needed'
            )
          }
        } catch (err) {
          // A throw here would take down the cron thread and silently stop
          // every future month.
          logger.error({ err }, 'Auto-scheduling job threw')
        }
      })()
    },
    {
      // Without this, "00:00 on the 1st" means midnight on the SERVER's clock.
      // A UTC-hosted server would fire at 05:30 IST — and, worse, on a date
      // that is still the last day of the previous month in IST.
      timezone: BOOKENDS_TIMEZONE,
    }
  )

  logger.info(
    { cron: FIRST_OF_MONTH_AT_MIDNIGHT, timezone: BOOKENDS_TIMEZONE },
    'Exam auto-scheduler started'
  )
  return task
}

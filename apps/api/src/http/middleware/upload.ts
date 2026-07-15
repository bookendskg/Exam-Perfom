import { AsyncResource } from 'node:async_hooks'
import multer, { MulterError } from 'multer'
import type { RequestHandler } from 'express'
import { ApiError } from '../api-error.js'

/**
 * Single-file upload, translating multer's errors into the §5.2 envelope.
 *
 * ---------------------------------------------------------------------------
 * The AsyncResource.bind() below is load-bearing. Do not remove it.
 *
 * multer consumes the request stream, and calls back from busboy's 'finish'
 * event. Stream events run in the async context of whatever emitted them — the
 * socket — not the context of whoever attached the listener. So without this,
 * everything downstream of an upload runs OUTSIDE the AsyncLocalStorage scope
 * that tenantScope() established, and every query on the route fails with
 * "no tenant context".
 *
 * That failure is the good outcome. The extension fails closed, so this shows
 * up as a loud 500 on the first upload. Had it defaulted to "no filter" instead,
 * bulk import would have quietly run unscoped across every tenant's data.
 *
 * AsyncResource.bind captures the context at the time the callback is created —
 * inside the request, inside the scope — and reinstates it when multer invokes
 * it, which puts the rest of the chain back where it belongs.
 * ---------------------------------------------------------------------------
 */
export function singleFileUpload(field: string, maxBytes = 5 * 1024 * 1024): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  })
  const handler = upload.single(field)

  return (req, res, next) => {
    const done = AsyncResource.bind((err: unknown) => {
      if (err instanceof MulterError) {
        next(
          ApiError.validation(
            err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : 'Could not read the upload',
            [{ field: err.field ?? field, message: err.code }]
          )
        )
        return
      }
      next(err)
    })

    handler(req, res, done)
  }
}

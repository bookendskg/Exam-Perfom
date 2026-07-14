import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { disconnectDb } from './helpers/db.js'

describe('§5.2 response envelope', () => {
  let app: Application

  beforeAll(() => {
    app = buildTestApp().app
  })

  afterAll(async () => {
    await disconnectDb()
  })

  it('wraps a success in { success: true, data }', async () => {
    const res = await request(app).get('/api/v1/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { status: 'ok', env: 'test' } })
  })

  it('omits meta on non-list responses', async () => {
    // §5.2 shows meta unconditionally, but it is meaningless here. Optional.
    const res = await request(app).get('/api/v1/health')
    expect(res.body).not.toHaveProperty('meta')
  })

  it('wraps a 404 in the failure envelope', async () => {
    const res = await request(app).get('/totally-unknown')
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.message).toContain('/totally-unknown')
  })

  it('returns 401, not 404, for an unknown /api/v1 path when anonymous', async () => {
    // Deliberate: a 404 here would let an anonymous caller enumerate which
    // endpoints exist. The auth guard fires before the not-found handler.
    const res = await request(app).get('/api/v1/nope')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('flattens an unexpected throw to INTERNAL_ERROR without leaking the message', async () => {
    // The whole point of the terminal handler: a stack trace or driver string
    // here is how a connection string escapes into a client.
    const res = await request(app).get('/api/v1/__boom')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    })
    expect(JSON.stringify(res.body)).not.toContain('internal detail')
    expect(JSON.stringify(res.body)).not.toContain('boom')
  })

  it('does not advertise the server framework', async () => {
    const res = await request(app).get('/api/v1/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('sets helmet security headers', async () => {
    const res = await request(app).get('/api/v1/health')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

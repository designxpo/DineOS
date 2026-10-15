import type { FastifyError, FastifyInstance } from 'fastify';
import { NoResultError } from 'kysely';
import { ZodError } from 'zod';

/** An error safe to show the caller. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Sign in required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this', code = 'forbidden') =>
  new AppError(403, code, message);
export const notFound = (entity: string) => new AppError(404, 'not_found', `${entity} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const gone = (code: string, message: string) => new AppError(410, code, message);
export const tooMany = (message = 'Too many requests, slow down') => new AppError(429, 'rate_limited', message);

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof NoResultError) {
      // A required row was not there: missing, or hidden by row-level security (another tenant's).
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Some fields are missing or invalid',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    const fe = err as FastifyError;
    if (fe.validation || fe.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'validation_error', message: fe.message } });
    }
    if (fe.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests, slow down' } });
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'bad_request', message: fe.message } });
    }
    const pgErr = err as PgError;
    switch (pgErr.code) {
      case '23505':
        return reply.status(409).send({ error: { code: 'already_exists', message: 'That already exists', details: pgErr.constraint } });
      case '23503':
        return reply.status(400).send({ error: { code: 'invalid_reference', message: 'A referenced record does not exist', details: pgErr.constraint } });
      case '23514':
        return reply.status(400).send({ error: { code: 'invalid_value', message: 'A value is out of range', details: pgErr.constraint } });
      case '22P02':
        return reply.status(400).send({ error: { code: 'invalid_id', message: 'Malformed identifier' } });
      case '42501':
        // Row-level security refused the write: someone is reaching across tenants.
        req.log.warn({ err }, 'row-level security violation');
        return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });
}

// The one error type the services throw: an HTTP status and GitHub's `message`, which the REST
// router turns into a JSON body, GraphQL into an `errors` entry and MCP into a tool error.

export class ApiError extends Error {
  status: number;
  errors: unknown[] | undefined;

  constructor(status: number, message: string, errors?: unknown[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }
}

export function notFound(): ApiError {
  return new ApiError(404, 'Not Found');
}

export function invalid(message: string, resource?: string, field?: string, code = 'invalid'): ApiError {
  return new ApiError(422, message, resource === undefined ? undefined : [{ resource, field, code }]);
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

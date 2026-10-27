export type HttpErrorLike = { status?: number }

export const isHttpError = (error: unknown): error is HttpErrorLike => typeof error === 'object' && error !== null && 'status' in error

export const is404Error = (error: unknown): boolean => isHttpError(error) && error.status === 404

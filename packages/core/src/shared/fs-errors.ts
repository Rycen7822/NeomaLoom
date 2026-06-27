export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isErrnoException(error) && error.code === code;
}

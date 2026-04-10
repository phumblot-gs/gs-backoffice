export class EvtApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(`EVT API error ${status} on ${path}: ${message}`);
    this.name = 'EvtApiError';
    this.status = status;
    this.path = path;
  }
}

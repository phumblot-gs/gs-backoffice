export class JumpCloudApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(`JumpCloud API error ${status} on ${path}: ${message}`);
    this.name = 'JumpCloudApiError';
    this.status = status;
    this.path = path;
  }
}

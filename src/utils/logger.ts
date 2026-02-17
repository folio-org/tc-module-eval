/**
 * Logger interface and singleton for diagnostic/internal logging.
 */

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export class ConsoleLogger implements Logger {
  info(...args: unknown[]): void {
    console.log(...args);
  }
  warn(...args: unknown[]): void {
    console.warn(...args);
  }
  error(...args: unknown[]): void {
    console.error(...args);
  }
  debug(...args: unknown[]): void {
    console.debug(...args);
  }
}

export class NoopLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
}

let currentLogger: Logger = new ConsoleLogger();

export function getLogger(): Logger {
  return currentLogger;
}

export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

export function resetLogger(): void {
  currentLogger = new ConsoleLogger();
}

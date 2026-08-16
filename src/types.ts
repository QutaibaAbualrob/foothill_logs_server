export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

export interface NormalizedLog {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: Attributes;
  readonly attributesJson: string;
  readonly estimatedBytes: number;
}

export interface RejectedLog {
  readonly index: number;
  readonly reason: string;
}

export interface LogResult {
  readonly id: string;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: Attributes;
}

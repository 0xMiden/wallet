import * as fs from 'fs';
import * as path from 'path';

import type { EventCategory, EventSeverity, TimelineEvent } from './types';

/**
 * NDJSON event stream recorder. Streams to disk so partial output survives crashes.
 * Every significant action in the test emits an event through this recorder.
 */
export class TimelineRecorder {
  private events: TimelineEvent[] = [];
  private testStart: number;
  private stream: fs.WriteStream;
  private outputDir: string;

  currentStep = 0;
  currentStepName = 'setup';

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    this.testStart = Date.now();
    fs.mkdirSync(outputDir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(outputDir, 'timeline.ndjson'), { flags: 'a' });
  }

  /**
   * Emit a timeline event. Writes to both the NDJSON file and in-memory buffer.
   * stepIndex, stepName, wallet, data, and durationMs are all optional.
   */
  emit(
    partial: Pick<TimelineEvent, 'category' | 'severity' | 'message'> &
      Partial<Omit<TimelineEvent, 'timestamp' | 'elapsedMs' | 'category' | 'severity' | 'message'>>
  ): void {
    const event: TimelineEvent = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.testStart,
      stepIndex: partial.stepIndex ?? this.currentStep,
      stepName: partial.stepName ?? this.currentStepName,
      category: partial.category,
      severity: partial.severity,
      wallet: partial.wallet,
      message: partial.message,
      data: partial.data,
      durationMs: partial.durationMs,
    };
    this.events.push(event);
    this.stream.write(JSON.stringify(event) + '\n');
  }

  /**
   * Enter a new test step. Increments the step counter and emits a lifecycle event.
   */
  enterStep(name: string): void {
    this.currentStep++;
    this.currentStepName = name;
    this.emit({
      category: 'test_lifecycle',
      severity: 'info',
      message: `Step ${this.currentStep}: ${name}`,
    });
  }

  /**
   * Get the last N events for failure reports.
   */
  getRecentEvents(count: number): TimelineEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Get all recorded events.
   */
  getAllEvents(): TimelineEvent[] {
    return [...this.events];
  }

  /**
   * Get events filtered by category.
   */
  getEventsByCategory(category: EventCategory): TimelineEvent[] {
    return this.events.filter(e => e.category === category);
  }

  /**
   * Get events filtered by severity.
   */
  getEventsBySeverity(severity: EventSeverity): TimelineEvent[] {
    return this.events.filter(e => e.severity === severity);
  }

  /**
   * Get events for a specific wallet.
   */
  getEventsForWallet(wallet: 'A' | 'B'): TimelineEvent[] {
    return this.events.filter(e => e.wallet === wallet);
  }

  /**
   * Get the output directory path.
   */
  getOutputDir(): string {
    return this.outputDir;
  }

  /**
   * Get elapsed time since test start.
   */
  getElapsedMs(): number {
    return Date.now() - this.testStart;
  }

  /**
   * Flush and close the NDJSON stream. Awaits until all data is written.
   */
  close(): Promise<void> {
    return new Promise(resolve => this.stream.end(resolve));
  }
}

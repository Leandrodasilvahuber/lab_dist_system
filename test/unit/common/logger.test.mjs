import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Logger } from '../../../src/common/logger.mjs';

describe('Logger', () => {
  it('should create logger instance', () => {
    const logger = new Logger();
    assert.ok(logger);
    assert.strictEqual(typeof logger.event, 'function');
    assert.strictEqual(typeof logger.status, 'function');
    assert.strictEqual(typeof logger.error, 'function');
    assert.strictEqual(typeof logger.trace, 'function');
  });
});
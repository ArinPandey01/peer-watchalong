import { startTrackerServer } from './server';

const port = readPositiveInteger('TRACKER_PORT', 8080, true);
const maxPayloadBytes = readPositiveInteger(
  'TRACKER_MAX_PAYLOAD_BYTES',
  64 * 1024,
);
const host = process.env.TRACKER_HOST;

const tracker = startTrackerServer({
  port,
  maxPayloadBytes,
  ...(host ? { host } : {}),
});

let shuttingDown = false;
async function shutDown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down tracker`);

  try {
    await tracker.close();
    process.exitCode = 0;
  } catch (error) {
    console.error('Failed to stop tracker cleanly', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutDown('SIGINT'));
process.once('SIGTERM', () => void shutDown('SIGTERM'));

function readPositiveInteger(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

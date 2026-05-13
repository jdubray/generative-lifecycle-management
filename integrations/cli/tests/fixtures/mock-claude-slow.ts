#!/usr/bin/env bun
/** Mock claude that sleeps for a long time — exercises the timeout path. */
await new Promise(() => {
  // Intentionally never resolves. The wrapper's timeout must kill us.
  setTimeout(() => {}, 60_000);
});

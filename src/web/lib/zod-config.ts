import { z } from "zod";

// The SPA CSP has no 'unsafe-eval'. Zod 4 otherwise probes `Function("")` to
// pick its JIT object parser; the throw is caught, but Firefox still reports a
// CSP violation for it. jitless skips the probe and uses the interpreted path.
z.config({ jitless: true });

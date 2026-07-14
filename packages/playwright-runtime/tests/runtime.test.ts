import assert from "node:assert/strict";
import { AttemptClock } from "../src/index.js";

const clock = new AttemptClock();
const first = clock.next();
const second = clock.next();
assert.equal(first.sequence, 1);
assert.equal(second.sequence, 2);
assert.ok(second.monotonicOffsetMs >= first.monotonicOffsetMs);
console.log("playwright runtime tests passed");

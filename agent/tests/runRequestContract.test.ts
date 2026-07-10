import assert from "node:assert/strict";
import { z } from "zod";
import { requireRunnableTarget, runnableTargetShape } from "../src/runRequestContract.js";

const runTargetSchema = z.object(runnableTargetShape).superRefine(requireRunnableTarget);

export function testRunRequestContract() {
  assert.equal(runTargetSchema.parse({ projectId: "customer-portal" }).projectId, "customer-portal");
  assert.equal(runTargetSchema.parse({ appUrl: "http://127.0.0.1:4173" }).appUrl, "http://127.0.0.1:4173");
  assert.equal(
    runTargetSchema.parse({ target: { frontendUrl: "http://127.0.0.1:5173" } }).target?.frontendUrl,
    "http://127.0.0.1:5173"
  );
  assert.throws(
    () => runTargetSchema.parse({}),
    /Provide appUrl, projectId, or target/
  );
}

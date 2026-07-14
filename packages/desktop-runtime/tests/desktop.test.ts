import assert from "node:assert/strict";
import { MacOSWindowDesktopAdapter, UnsupportedDesktopAdapter } from "../src/index.js";

await assert.rejects(() => new UnsupportedDesktopAdapter().execute(), /blocked/);
const adapter = new MacOSWindowDesktopAdapter({ helperPath: "/missing/helper", allowedBundleIds: ["com.example.app"] });
await assert.rejects(() => adapter.execute({ type: "focus-window", bundleId: "com.evil.app", windowId: "1" }, "permission-1"), /not_allowed/);
await assert.rejects(() => adapter.execute({ type: "keyboard-input", bundleId: "com.example.app", windowId: "1", text: "secret", sensitive: true }, "permission-1"), /secure_input/);
console.log("desktop runtime tests passed");

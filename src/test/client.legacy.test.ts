import assert from "node:assert/strict";
import { test } from "node:test";
import * as clientModule from "../provider/client.js";

test("provider/client no longer exports the legacy NvidiaClient alias", () => {
  assert.ok(!("NvidiaClient" in clientModule));
});

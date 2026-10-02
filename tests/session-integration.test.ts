import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexCompactionExtension } from "../src/index.js";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { isObject } from "../src/protocol.js";
import { isolateAgentConfig, sessionFixture } from "./helpers.js";

isolateAgentConfig();

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`real ${api} session saves, restores, and recompacts V2 history`, { timeout: 20_000 }, async () => {
    const fixture = await sessionFixture({ api, extensions: [createCodexCompactionExtension()] });
    try {
      for (let turn = 1; turn <= 3; turn++) {
        await fixture.session.prompt(`Task ${turn}: ${"Preserve the agreed implementation constraints. ".repeat(60)}`);
      }
      const sessionId = fixture.session.sessionManager.getSessionId();
      await fixture.session.compact();
      const firstEntry = fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(firstEntry);
      const first = parseCheckpointDetails(firstEntry.details);
      assert.ok(first, "Real session compaction must save an opaque V2 checkpoint");
      assert.equal(fixture.session.model?.id, fixture.model.id);
      assert.equal(fixture.session.thinkingLevel, "low");

      await fixture.session.prompt("Continue the task after compaction. ".repeat(40));
      const continuation = fixture.requests.at(-1)?.payload;
      assert.ok(continuation && Array.isArray(continuation.input));
      assert.ok(continuation.input.some((item) => isObject(item) && item.type === "compaction"));
      assert.ok(!JSON.stringify(continuation).includes("PI_CODEX_REMOTE_CHECKPOINT"));
      assert.ok(!JSON.stringify(continuation).includes("Fixture reply 1."));

      await fixture.reopen();
      assert.equal(fixture.session.sessionManager.getSessionId(), sessionId);
      await fixture.session.prompt("Resume the saved session and preserve its decisions. ".repeat(40));
      const restored = fixture.requests.at(-1)?.payload;
      assert.ok(restored && Array.isArray(restored.input));
      assert.ok(restored.input.some((item) => isObject(item) && item.type === "compaction"));
      assert.ok(!JSON.stringify(restored).includes("PI_CODEX_REMOTE_CHECKPOINT"));

      await fixture.session.compact();
      const secondEntry = fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(secondEntry);
      const second = parseCheckpointDetails(secondEntry.details);
      assert.ok(second);
      assert.notEqual(second.checkpointId, first.checkpointId);
      const compactRequests = fixture.requests.filter(({ payload }) => Array.isArray(payload.input) && payload.input.some((item) => isObject(item) && item.type === "compaction_trigger"));
      assert.equal(compactRequests.length, 2);
      const secondRequest = compactRequests[1];
      assert.ok(Array.isArray(secondRequest.payload.input));
      assert.ok(secondRequest.payload.input.some((item) => isObject(item) && item.type === "compaction"));
      for (const request of compactRequests) {
        assert.match(request.headers.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);
      }
      await fixture.session.prompt("Continue after the second compaction.");
      assert.deepEqual(fixture.errors, []);
    } finally {
      await fixture.close();
    }
  });
}

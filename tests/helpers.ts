// Build isolated real Pi registries for request-boundary regression tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type AuthResult, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function testRegistry(provider: Provider, resolve: () => Promise<AuthResult | undefined> = async () => ({ auth: { apiKey: "fixture-key" } })): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider({ ...provider, auth: { apiKey: { name: "Fixture", resolve } } });
  return new ModelRegistry(runtime);
}

// Node's test runner isolates each test file in its own process.
export function isolateAgentConfig(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-compaction-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

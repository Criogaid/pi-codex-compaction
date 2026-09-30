// Build isolated real Pi registries for request-boundary regression tests.
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

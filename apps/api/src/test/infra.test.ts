import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { InMemoryEventBus } from "../infra/eventBus.js";
import { LocalFileObjectStorage, OBJECTS_ROOT } from "../infra/objectStorage.js";
import { InMemoryVectorStore, hashEmbedding } from "../infra/vectorStore.js";

test("InMemoryEventBus - subscribers receive published events with the given payload", async () => {
  const bus = new InMemoryEventBus();
  const received: unknown[] = [];
  bus.subscribe("test.event", (event) => { received.push(event.payload); });

  await bus.publish("test.event", { foo: "bar" });
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(received.length, 1);
  assert.deepStrictEqual(received[0], { foo: "bar" });
});

test("InMemoryEventBus - unsubscribe stops further delivery", async () => {
  const bus = new InMemoryEventBus();
  let count = 0;
  const unsubscribe = bus.subscribe("test.event", () => { count++; });

  await bus.publish("test.event", {});
  await new Promise((r) => setImmediate(r));
  unsubscribe();
  await bus.publish("test.event", {});
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(count, 1);
});

test("InMemoryEventBus - a throwing handler does not affect other subscribers", async () => {
  const bus = new InMemoryEventBus();
  let secondCalled = false;
  bus.subscribe("test.event", () => { throw new Error("boom"); });
  bus.subscribe("test.event", () => { secondCalled = true; });

  await bus.publish("test.event", {});
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(secondCalled, true);
});

test("LocalFileObjectStorage - put/get/delete round-trip", async () => {
  const root = `${process.cwd()}/data/objects-test-${Date.now()}`;
  const storage = new LocalFileObjectStorage(root);
  const key = "widget.png";
  const data = Buffer.from("fake-image-bytes");

  try {
    const { url } = await storage.put(key, data);
    assert.strictEqual(url, `/objects/${key}`);

    const fetched = await storage.get(key);
    assert.ok(fetched);
    assert.strictEqual(fetched!.toString(), "fake-image-bytes");

    await storage.delete(key);
    assert.strictEqual(await storage.get(key), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Regression guard. The /objects static route in index.ts serves OBJECTS_ROOT, so a default-constructed
// LocalFileObjectStorage MUST write to that same directory. These were two independent
// __dirname-relative computations at different nesting depths; they agreed in the source tree and
// diverged in the Docker image (which flattens apps/api/dist to /repo/service/dist), so uploads were
// written somewhere the mounted volume wasn't and were destroyed on every rebuild while Postgres kept
// serving the /objects URL. If someone reintroduces a separate path here, this fails.
test("LocalFileObjectStorage - default root is OBJECTS_ROOT, the directory /objects serves", () => {
  assert.strictEqual(new LocalFileObjectStorage().diskRoot, OBJECTS_ROOT);
  assert.ok(path.isAbsolute(OBJECTS_ROOT), "must be absolute — it is handed to express.static and fs");
});

test("LocalFileObjectStorage - get returns null for a missing key", async () => {
  const root = `${process.cwd()}/data/objects-test-${Date.now()}`;
  const storage = new LocalFileObjectStorage(root);
  try {
    assert.strictEqual(await storage.get("does-not-exist.png"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("InMemoryVectorStore - query ranks the closer embedding first", async () => {
  const store = new InMemoryVectorStore();
  await store.upsert([
    { id: "a", embedding: hashEmbedding("wireless bluetooth headphones") },
    { id: "b", embedding: hashEmbedding("organic coffee subscription box") },
  ]);

  const results = await store.query(hashEmbedding("bluetooth wireless earbuds"), 2);
  assert.strictEqual(results[0].id, "a");
});

test("InMemoryVectorStore - delete removes a record from future queries", async () => {
  const store = new InMemoryVectorStore();
  await store.upsert([{ id: "a", embedding: hashEmbedding("test") }]);
  await store.delete(["a"]);
  const results = await store.query(hashEmbedding("test"), 5);
  assert.strictEqual(results.length, 0);
});

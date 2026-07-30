import { test } from "node:test";
import assert from "node:assert";
import { VimeoPictureStorage, isVimeoStorageConfigured } from "../infra/vimeoPictureStorage.js";
import type { ObjectStorage } from "../infra/objectStorage.js";

/** Records what reached the delegate, so the write-through guarantee can be asserted. */
function fakeDelegate(): ObjectStorage & { puts: { key: string; size: number; contentType?: string }[]; deletes: string[] } {
  const puts: { key: string; size: number; contentType?: string }[] = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    async put(key, data, contentType) {
      puts.push({ key, size: data.length, contentType });
      return { url: `/objects/${key}` };
    },
    async get() {
      return Buffer.from("local-bytes");
    },
    async delete(key) {
      deletes.push(key);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("vimeoPictureStorage - isVimeoStorageConfigured follows VIMEO_ACCESS_TOKEN", () => {
  const saved = process.env.VIMEO_ACCESS_TOKEN;
  try {
    delete process.env.VIMEO_ACCESS_TOKEN;
    assert.strictEqual(isVimeoStorageConfigured(), false);
    process.env.VIMEO_ACCESS_TOKEN = "t";
    assert.strictEqual(isVimeoStorageConfigured(), true);
  } finally {
    if (saved === undefined) delete process.env.VIMEO_ACCESS_TOKEN;
    else process.env.VIMEO_ACCESS_TOKEN = saved;
  }
});

// The three-step flow is the whole contract, and step 3 is the one that is easy to omit — a picture
// that is never activated uploads "successfully" and is then invisible.
test("vimeoPictureStorage - runs POST -> PUT -> PATCH(active) and returns the LARGEST size link", async () => {
  process.env.VIMEO_ACCESS_TOKEN = "test-token";
  const original = global.fetch;
  const calls: { method: string; url: string; auth?: string }[] = [];
  global.fetch = (async (url: unknown, init: any) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u, auth: init?.headers?.Authorization });
    if (init?.method === "POST" && u.endsWith("/me/pictures")) {
      return jsonResponse({ uri: "/users/1/pictures/9", link: "https://upload.vimeo.test/slot" });
    }
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    if (init?.method === "PATCH") {
      return jsonResponse({
        link: "https://i.vimeocdn.com/portrait/9_100x100",
        sizes: [
          { width: 100, height: 100, link: "https://i.vimeocdn.com/portrait/9_100x100" },
          { width: 640, height: 640, link: "https://i.vimeocdn.com/portrait/9_640x640" },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${init?.method} ${u}`);
  }) as typeof fetch;

  const delegate = fakeDelegate();
  try {
    const { url } = await new VimeoPictureStorage(delegate).put("ws/a.png", PNG, "image/png");

    assert.deepStrictEqual(calls.map((c) => c.method), ["POST", "PUT", "PATCH"], "all three steps must run, in order");
    assert.strictEqual(url, "https://i.vimeocdn.com/portrait/9_640x640", "must pick the largest variant, not the small avatar crop");
    // The pre-signed upload target must not receive credentials.
    assert.strictEqual(calls[1].auth, undefined, "no Authorization header on the pre-signed PUT");
    // Write-through: the bytes must also be on disk so get/delete keep working.
    assert.deepStrictEqual(delegate.puts, [{ key: "ws/a.png", size: PNG.length, contentType: "image/png" }]);
  } finally {
    global.fetch = original;
    delete process.env.VIMEO_ACCESS_TOKEN;
  }
});

// objectStorage also holds crawled HTML and generated artifacts. Pushing those into a picture gallery
// would fail or corrupt them, so the content type gates the whole path.
test("vimeoPictureStorage - NON-image blobs never touch Vimeo", async () => {
  process.env.VIMEO_ACCESS_TOKEN = "test-token";
  const original = global.fetch;
  let vimeoCalls = 0;
  global.fetch = (async () => {
    vimeoCalls += 1;
    return jsonResponse({});
  }) as typeof fetch;

  const delegate = fakeDelegate();
  try {
    const { url } = await new VimeoPictureStorage(delegate).put("crawl/page.html", Buffer.from("<html>"), "text/html");
    assert.strictEqual(vimeoCalls, 0, "html must not be uploaded to a picture gallery");
    assert.strictEqual(url, "/objects/crawl/page.html", "must return the local URL");
  } finally {
    global.fetch = original;
    delete process.env.VIMEO_ACCESS_TOKEN;
  }
});

// A CDN failure must degrade the URL choice, never lose the user's upload.
test("vimeoPictureStorage - a Vimeo failure still succeeds, returning the local URL", async () => {
  process.env.VIMEO_ACCESS_TOKEN = "test-token";
  const original = global.fetch;
  global.fetch = (async () => new Response("upstream boom", { status: 500 })) as typeof fetch;

  const delegate = fakeDelegate();
  try {
    const { url } = await new VimeoPictureStorage(delegate).put("ws/b.png", PNG, "image/png");
    assert.strictEqual(url, "/objects/ws/b.png", "upload must succeed via the delegate");
    assert.strictEqual(delegate.puts.length, 1, "bytes still written locally");
  } finally {
    global.fetch = original;
    delete process.env.VIMEO_ACCESS_TOKEN;
  }
});

test("vimeoPictureStorage - a thrown fetch is caught, not propagated to the uploader", async () => {
  process.env.VIMEO_ACCESS_TOKEN = "test-token";
  const original = global.fetch;
  global.fetch = (async () => {
    throw new Error("network unreachable (simulated)");
  }) as typeof fetch;

  const delegate = fakeDelegate();
  try {
    const { url } = await new VimeoPictureStorage(delegate).put("ws/c.png", PNG, "image/png");
    assert.strictEqual(url, "/objects/ws/c.png");
  } finally {
    global.fetch = original;
    delete process.env.VIMEO_ACCESS_TOKEN;
  }
});

// Reads come from disk because Vimeo's copy is resized; deletes only remove the local copy because no
// picture URI is persisted, so the gallery entry cannot be identified safely.
test("vimeoPictureStorage - get and delete are delegated to local storage", async () => {
  const delegate = fakeDelegate();
  const storage = new VimeoPictureStorage(delegate);
  assert.strictEqual((await storage.get("ws/a.png"))?.toString(), "local-bytes");
  await storage.delete("ws/a.png");
  assert.deepStrictEqual(delegate.deletes, ["ws/a.png"]);
});

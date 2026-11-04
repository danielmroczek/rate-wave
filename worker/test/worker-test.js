// Testy READ-PROXY (bilet 05) — plain node:test, brak zależności.
// Uruchamianie: node test/worker-test.js (lub npm test w worker/).

import test from "node:test";
import assert from "node:assert/strict";
import worker, { resetInflight, hashToken } from "../src/worker.js";

const ENV = { ALLOWED_ORIGINS: "http://localhost:5173,https://danielmroczek.github.io" };
const ORIGIN = "http://localhost:5173";

// Mockowane fetch: mapowanie URL-prefix → responsy (lub funkcja).
let mockFetch;

test.beforeEach(() => {
  resetInflight();
  mockFetch = undefined;
});

// Podmiana globalnego fetch na czas testu.
const realFetch = globalThis.fetch;
test.afterEach(() => (globalThis.fetch = realFetch));

function installMock() {
  globalThis.fetch = (url, init) => {
    if (!mockFetch) throw new Error("unexpected fetch: " + url);
    return mockFetch(url, init);
  };
}

function req(path, { origin = ORIGIN, headers = {}, method = "GET" } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  return new Request("https://rw-proxy.test" + path, { headers: h, method });
}

test("health odpowiada i dokleja ACAO dla dozwolonego originu", async () => {
  const res = await worker.fetch(req("/health"), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("obcy origin nie dostaje ACAO", async () => {
  const res = await worker.fetch(req("/health", { origin: "https://evil.example" }), ENV);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("preflight OPTIONS → 204 z ACAO i nagłówkami Range", async () => {
  const res = await worker.fetch(req("/stream", { origin: ORIGIN, method: "OPTIONS" }), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Range/);
});

test("getfilelink: brak tokena → 400", async () => {
  installMock();
  const res = await worker.fetch(req("/getfilelink?fileid=123"), ENV);
  assert.equal(res.status, 400);
});

test("getfilelink: niedozwolony host API → 400", async () => {
  installMock();
  const res = await worker.fetch(
    req(`/getfilelink?fileid=1&access_token=t&hostname=evil.example`),
    ENV,
  );
  assert.equal(res.status, 400);
});

test("getfilelink passthrough: JSON pCloud 1:1, token nie w odpowiedzi", async () => {
  installMock();
  const upstream = { result: 0, hosts: ["file-u3.pcloud.com"], path: "/x.mp3", expires: 987654321 };
  mockFetch = (url) => {
    const u = new URL(url);
    assert.equal(u.hostname, "eapi.pcloud.com");
    assert.equal(u.pathname, "/getfilelink");
    assert.equal(u.searchParams.get("access_token"), "tok123");
    assert.equal(u.searchParams.get("fileid"), "42");
    return Promise.resolve(new Response(JSON.stringify(upstream), { status: 200 }));
  };
  const res = await worker.fetch(req("/getfilelink?fileid=42&access_token=tok123"), ENV);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, upstream); // link + expires przelatują; token jest tylko w URL eapi
});

test("getfilelink: błąd pCloud (result!=0) przepuszczany z 200 do decyzji aplikacji", async () => {
  installMock();
  mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ result: 2094, error: "Invalid 'access_token' provided." }), {
        status: 200,
      }),
    );
  const res = await worker.fetch(req("/getfilelink?fileid=1&access_token=bad"), ENV);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 2094);
});

test("rate-limit: 11. zaległy getfilelink → 429, po zwolnieniu 429 znika", async () => {
  installMock();
  const releases = [];
  mockFetch = () =>
    new Promise((resolve) =>
      releases.push(() => resolve(new Response(JSON.stringify({ result: 0 }), { status: 200 }))),
    );

  const pending = [];
  for (let i = 0; i < 10; i++)
    pending.push(worker.fetch(req(`/getfilelink?fileid=${i}&access_token=t`), ENV));
  await new Promise((r) => setTimeout(r, 25));

  const rejected = await worker.fetch(req(`/getfilelink?fileid=99&access_token=t`), ENV);
  assert.equal(rejected.status, 429);
  assert.equal(await rejected.text(), JSON.stringify({ error: "too_many_getfilelink" }));

  releases.forEach((release) => release());
  const done = await Promise.all(pending);
  for (const res of done) {
    assert.equal(res.status, 200);
    await res.text();
  }

  // Po zwolnieniu limitu — mock zwraca od razu.
  mockFetch = () => Promise.resolve(new Response(JSON.stringify({ result: 0 }), { status: 200 }));
  const again = await worker.fetch(req(`/getfilelink?fileid=99&access_token=t`), ENV);
  assert.equal(again.status, 200);
  await again.text();
});

test("stream: brak url / obcy host / token w url pliku → 400", async () => {
  installMock();
  assert.equal((await worker.fetch(req("/stream"), ENV)).status, 400);
  assert.equal(
    (await worker.fetch(req("/stream?url=https://evil.example/a.mp3"), ENV)).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        req("/stream?url=https://file-u3.pcloud.com/a.mp3%3Faccess_token%3Dx"),
        ENV,
      )
    ).status,
    400,
  );
});

test("stream: Range przepisany 1:1, 206 + Content-Range + ACAO w odpowiedzi", async () => {
  installMock();
  mockFetch = (url, init) => {
    assert.equal(new URL(url).hostname, "file-u3.pcloud.com");
    assert.equal(init.headers.get("Range"), "bytes=0-65535");
    return Promise.resolve(
      new Response("HEAD_BYTES_64K", {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-65535/5000000",
          "Content-Type": "audio/mpeg",
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "http://random.upstream/should-be-dropped",
        },
      }),
    );
  };
  const res = await worker.fetch(
    req("/stream?url=https://file-u3.pcloud.com/a.mp3", { headers: { Range: "bytes=0-65535" } }),
    ENV,
  );
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 0-65535/5000000");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(await res.text(), "HEAD_BYTES_64K");
});

test("stream: pełne bajty (200) bez Range też przepływają", async () => {
  installMock();
  mockFetch = () =>
    Promise.resolve(
      new Response("FULL_MP3_BYTES", { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    );
  const res = await worker.fetch(req("/stream?url=https://file-u3.pcloud.com/a.mp3"), ENV);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "FULL_MP3_BYTES");
});

test("stream?fileid: getfilelink i bajty w jednym wywołaniu (IP-binding pCloud)", async () => {
  installMock();
  const calls = [];
  mockFetch = (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === "eapi.pcloud.com") {
      assert.equal(u.searchParams.get("access_token"), "tok");
      assert.equal(u.searchParams.get("fileid"), "7");
      return Promise.resolve(
        new Response(JSON.stringify({ result: 0, hosts: ["file-u3.pcloud.com"], path: "/x.mp3" }), {
          status: 200,
        }),
      );
    }
    assert.equal(u.hostname, "file-u3.pcloud.com");
    return Promise.resolve(
      new Response("BYTES", { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    );
  };
  const res = await worker.fetch(req("/stream?fileid=7&access_token=tok"), ENV);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "BYTES");
  // dwa upstreamy: getfilelink → download; token tylko w wywołaniu eapi
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].includes("access_token"));
});

test("stream?fileid: retry po 410 (IP-binding) aż do 206", async () => {
  installMock();
  let getfilelinkCalls = 0;
  let downloadCalls = 0;
  mockFetch = (url) => {
    const u = new URL(url);
    if (u.hostname === "eapi.pcloud.com") {
      getfilelinkCalls++;
      return Promise.resolve(
        new Response(JSON.stringify({ result: 0, hosts: ["file-u3.pcloud.com"], path: "/x.mp3" }), {
          status: 200,
        }),
      );
    }
    downloadCalls++;
    // dwie pierwsze próby link "wygenerowany dla innego IP" (410), trzecia OK
    if (downloadCalls <= 2) return Promise.resolve(new Response("other-ip", { status: 410 }));
    return Promise.resolve(
      new Response("OK_BYTES", { status: 206, headers: { "Content-Range": "bytes 0-7/10" } }),
    );
  };
  const res = await worker.fetch(
    req("/stream?fileid=7&access_token=tok", { headers: { Range: "bytes=0-65535" } }),
    ENV,
  );
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "OK_BYTES");
  assert.equal(getfilelinkCalls, 3);
  assert.equal(downloadCalls, 3);
});

test("stream?fileid: trwałe 410 po wyczerpaniu retry → 502", async () => {
  installMock();
  mockFetch = (url) => {
    const u = new URL(url);
    if (u.hostname === "eapi.pcloud.com")
      return Promise.resolve(
        new Response(JSON.stringify({ result: 0, hosts: ["file-u3.pcloud.com"], path: "/x.mp3" }), {
          status: 200,
        }),
      );
    return Promise.resolve(new Response("other-ip", { status: 410 }));
  };
  const res = await worker.fetch(req("/stream?fileid=7&access_token=tok"), ENV);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "pcloud_link_unavailable");
});

test("stream?fileid: błąd pCloud przepuszczany jako JSON z result", async () => {
  installMock();
  mockFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ result: 2094, error: "Invalid 'access_token' provided." }), {
        status: 200,
      }),
    );
  const res = await worker.fetch(req("/stream?fileid=7&access_token=bad"), ENV);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 2094);
});

test("stream?fileid: bez tokena → 400", async () => {
  installMock();
  const res = await worker.fetch(req("/stream?fileid=7"), ENV);
  assert.equal(res.status, 400);
});

test("hashToken stabilny i ukrywa token", async () => {
  assert.equal(await hashToken("abc"), await hashToken("abc"));
  assert.notEqual(await hashToken("abc"), await hashToken("abd"));
});

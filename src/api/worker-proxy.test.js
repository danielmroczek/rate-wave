// Testy klienta READ-PROXY (bilet 05) — Vitest, mock fetch.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getTrackLink,
  fetchTrackStream,
  fetchTrackBlob,
  fetchTrackBytes,
  isLinkExpired,
  ProxyError,
} from "./worker-proxy.js";
import { detectProxyMethod, currentProxyMethod, resetProxyMethod } from "./proxy-capability.js";

afterEach(() => {
  resetProxyMethod();
  vi.unstubAllGlobals();
});

/** Ustawia negocjację na QUERY (sonda /health → 200). */
async function negotiateQuery() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
  await detectProxyMethod();
  vi.unstubAllGlobals();
  expect(currentProxyMethod()).toBe("QUERY");
}

describe("getTrackLink", () => {
  it("POSTuje token w body (nie w URL) i zwraca link + expires", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: 0,
          hosts: ["file-u3.pcloud.com"],
          path: "/x.mp3",
          expires: 1234,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", mock);

    const { link, expires } = await getTrackLink({
      token: "tok",
      fileid: 42,
      hostname: "eapi.pcloud.com",
    });
    const [rawUrl, init] = mock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/getfilelink");
    expect(url.searchParams.get("access_token")).toBeNull();
    expect(init.method).toBe("POST");
    const body = /** @type {URLSearchParams} */ (init.body);
    expect(body.get("access_token")).toBe("tok");
    expect(body.get("fileid")).toBe("42");
    expect(body.get("hostname")).toBe("eapi.pcloud.com");
    expect(link).toBe("https://file-u3.pcloud.com/x.mp3");
    expect(expires).toBe(1234);
  });

  it("przekłada 429 i błędy proxy na ProxyError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "too_many_getfilelink" }), { status: 429 }),
        ),
    );
    await expect(getTrackLink({ token: "t", fileid: 1 })).rejects.toBeInstanceOf(ProxyError);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "bad_target_host" }), { status: 400 }),
        ),
    );
    await expect(getTrackLink({ token: "t", fileid: 1 })).rejects.toBeInstanceOf(ProxyError);
  });

  it("przekłada result!=0 pCloud na błąd (z tagiem auth dla 2000–2099)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ result: 2094, error: "Invalid 'access_token' provided." }),
            { status: 200 },
          ),
        ),
    );
    const err = await getTrackLink({ token: "bad", fileid: 1 }).catch((e) => e);
    expect(err.isAuthError).toBe(true);
  });

  it("wymaga fileid albo path", async () => {
    await expect(getTrackLink({ token: "t" })).rejects.toThrow(/fileid or path/);
  });
});

describe("fetchTrackBytes", () => {
  it("przekazuje Range i zwraca 206, nie modyfikuje URL pliku", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response("HEAD", {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/100", "Content-Type": "audio/mpeg" },
      }),
    );
    vi.stubGlobal("fetch", mock);

    const res = await fetchTrackBytes("https://file-u3.pcloud.com/a.mp3", {
      range: "bytes=0-65535",
    });
    const url = new URL(mock.mock.calls[0][0]);
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("url")).toBe("https://file-u3.pcloud.com/a.mp3");
    expect(mock.mock.calls[0][1].headers.Range).toBe("bytes=0-65535");
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("HEAD");
  });
});

describe("fetchTrackStream", () => {
  it("POSTuje /stream z fileid+tokenem w body i przekazuje Range", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response("BYTES", { status: 206, headers: { "Content-Range": "bytes 0-4/10" } }),
      );
    vi.stubGlobal("fetch", mock);

    const res = await fetchTrackStream({ token: "tok", fileid: 9, range: "bytes=0-65535" });
    const [rawUrl, init] = mock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("access_token")).toBeNull();
    expect(init.method).toBe("POST");
    const body = /** @type {URLSearchParams} */ (init.body);
    expect(body.get("access_token")).toBe("tok");
    expect(body.get("fileid")).toBe("9");
    expect(init.headers.Range).toBe("bytes=0-65535");
    expect(res.status).toBe(206);
  });

  it("fetchTrackBlob zwraca cały Utwór z POST /stream", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Blob(["AUDIO_BYTES"], { type: "audio/mpeg" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", mock);
    const blob = await fetchTrackBlob({ token: "tok", fileid: 9 });
    expect(await blob.text()).toBe("AUDIO_BYTES");
    expect(mock.mock.calls[0][1].method).toBe("POST");
  });

  it("200 z JSON pCloud (błąd getfilelink w /stream) → błąd zamiast bajtów JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ result: 2094, error: "Invalid 'access_token' provided." }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const err = await fetchTrackStream({ token: "bad", fileid: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.isAuthError).toBe(true);
    expect(err.message).toMatch(/2094/);
  });

  it("przekłada błędy proxy na ProxyError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "pcloud_link_unavailable" }), { status: 502 }),
        ),
    );
    await expect(fetchTrackStream({ token: "t", fileid: 1 })).rejects.toBeInstanceOf(ProxyError);
  });

  it("wymaga fileid albo path", async () => {
    await expect(fetchTrackStream({ token: "t" })).rejects.toThrow(/fileid or path/);
  });
});

describe("negocjacja metody QUERY → POST (#20)", () => {
  it("po sondzie QUERY wysyła getfilelink metodą QUERY", async () => {
    await negotiateQuery();
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: 0, hosts: ["file-u3.pcloud.com"], path: "/x.mp3", expires: 1 }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", mock);

    await getTrackLink({ token: "tok", fileid: 7 });
    expect(mock.mock.calls[0][1].method).toBe("QUERY");
  });

  it("QUERY odrzucone 405 → ponawia POST-em i zapamiętuje fallback", async () => {
    await negotiateQuery();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 405 }))
      .mockResolvedValueOnce(
        new Response("BYTES", { status: 206, headers: { "Content-Range": "bytes 0-4/10" } }),
      );
    vi.stubGlobal("fetch", mock);

    const res = await fetchTrackStream({ token: "tok", fileid: 9 });
    expect(res.status).toBe(206);
    expect(mock.mock.calls.map((c) => c[1].method)).toEqual(["QUERY", "POST"]);
    expect(currentProxyMethod()).toBe("POST");

    mock.mockClear();
    mock.mockResolvedValue(new Response("BYTES", { status: 200 }));
    await fetchTrackStream({ token: "tok", fileid: 9 });
    expect(mock.mock.calls[0][1].method).toBe("POST");
  });

  it("błąd sieci przy QUERY → POST tylko dla tego żądania, QUERY zostaje", async () => {
    await negotiateQuery();
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValue(new Response("BYTES", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    const res = await fetchTrackStream({ token: "tok", fileid: 9 });
    expect(res.status).toBe(200);
    expect(mock.mock.calls.map((c) => c[1].method)).toEqual(["QUERY", "POST"]);
    expect(currentProxyMethod()).toBe("QUERY");

    // następne żądanie znów próbuje QUERY
    await fetchTrackStream({ token: "tok", fileid: 10 });
    expect(mock.mock.calls.at(-1)[1].method).toBe("QUERY");
  });

  it("403/500 przy QUERY nie degradują sesji (to nie brak metody)", async () => {
    await negotiateQuery();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "x" }), { status: 502 }))
      .mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", mock);

    await fetchTrackStream({ token: "tok", fileid: 9 }).catch(() => {});
    expect(currentProxyMethod()).toBe("QUERY");
  });
});

describe("isLinkExpired", () => {
  it("wygasa, gdy teraz >= expires lub expires nieznany", () => {
    expect(isLinkExpired(100, 100_000)).toBe(true);
    expect(isLinkExpired(9999, 1_000)).toBe(false);
    expect(isLinkExpired(undefined)).toBe(true);
  });
});

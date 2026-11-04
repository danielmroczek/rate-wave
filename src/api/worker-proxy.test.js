// Testy klienta READ-PROXY (bilet 05) — Vitest, mock fetch.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getTrackLink,
  fetchTrackStream,
  fetchTrackBytes,
  isLinkExpired,
  ProxyError,
} from "./worker-proxy.js";

afterEach(() => vi.unstubAllGlobals());

describe("getTrackLink", () => {
  it("buduje wers proxy z tokenem w query i zwraca link + expires", async () => {
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
    const url = new URL(mock.mock.calls[0][0]);
    expect(url.pathname).toBe("/getfilelink");
    expect(url.searchParams.get("access_token")).toBe("tok");
    expect(url.searchParams.get("fileid")).toBe("42");
    expect(url.searchParams.get("hostname")).toBe("eapi.pcloud.com");
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
  it("woła /stream z fileid+tokenem i przekazuje Range", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response("BYTES", { status: 206, headers: { "Content-Range": "bytes 0-4/10" } }),
      );
    vi.stubGlobal("fetch", mock);

    const res = await fetchTrackStream({ token: "tok", fileid: 9, range: "bytes=0-65535" });
    const url = new URL(mock.mock.calls[0][0]);
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("fileid")).toBe("9");
    expect(url.searchParams.get("access_token")).toBe("tok");
    expect(mock.mock.calls[0][1].headers.Range).toBe("bytes=0-65535");
    expect(res.status).toBe(206);
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

describe("isLinkExpired", () => {
  it("wygasa, gdy teraz >= expires lub expires nieznany", () => {
    expect(isLinkExpired(100, 100_000)).toBe(true);
    expect(isLinkExpired(9999, 1_000)).toBe(false);
    expect(isLinkExpired(undefined)).toBe(true);
  });
});

// Kolejka ocen offline (bilet #9): store `pending-ratings`, jeden rekord na
// Utwór (LWW), odczyt w kolejności `createdAt`, usuwanie po potwierdzeniu.
// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, STORES, get } from "../store/db.js";
import {
  enqueuePendingRating,
  listPendingRatings,
  removePendingRating,
} from "./pending-ratings.js";

/** @type {IDBDatabase} */
let db;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openDB();
});

/** @param {Partial<import("./pending-ratings.js").PendingRating> & { key: string }} rec */
function entry(rec) {
  return {
    fingerprint: { size: 100, modified: 10 },
    ratingByte: 128,
    action: /** @type {"set"|"remove"} */ ("set"),
    createdAt: 1,
    ...rec,
  };
}

describe("pending-ratings — kolejka w IDB", () => {
  it("ten sam Utwór nadpisuje rekord (LWW): zostaje ostatni wpis", async () => {
    await enqueuePendingRating(db, entry({ key: "pcloud|7", ratingByte: 1, createdAt: 5 }));
    await enqueuePendingRating(db, entry({ key: "pcloud|7", ratingByte: 255, createdAt: 9 }));

    const all = await listPendingRatings(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ key: "pcloud|7", ratingByte: 255, createdAt: 9 });
    expect(await get(db, STORES.PENDING_RATINGS, "pcloud|7")).toMatchObject({ ratingByte: 255 });
  });

  it("list() zwraca rekordy rosnąco po createdAt (kolejność flushu)", async () => {
    await enqueuePendingRating(db, entry({ key: "pcloud|9", createdAt: 30 }));
    await enqueuePendingRating(db, entry({ key: "pcloud|7", createdAt: 10 }));
    await enqueuePendingRating(db, entry({ key: "pcloud|8", createdAt: 20 }));

    const all = await listPendingRatings(db);
    expect(all.map((r) => r.key)).toEqual(["pcloud|7", "pcloud|8", "pcloud|9"]);
  });

  it("remove() czyści rekord; pusty store → pusta lista", async () => {
    await enqueuePendingRating(db, entry({ key: "pcloud|7" }));
    await removePendingRating(db, "pcloud|7");
    expect(await listPendingRatings(db)).toEqual([]);
  });

  it("remove() z warunkiem createdAt nie kasuje nowszego wpisu", async () => {
    await enqueuePendingRating(db, entry({ key: "pcloud|7", createdAt: 5 }));
    await enqueuePendingRating(db, entry({ key: "pcloud|7", ratingByte: 255, createdAt: 9 }));

    await removePendingRating(db, "pcloud|7", { ifCreatedAt: 5 });
    const all = await listPendingRatings(db);
    expect(all[0]).toMatchObject({ ratingByte: 255, createdAt: 9 });
  });
});

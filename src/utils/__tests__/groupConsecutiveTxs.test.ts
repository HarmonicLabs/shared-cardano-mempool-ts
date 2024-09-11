import { groupConsecutiveTxs } from "../groupConsecutiveTxs";
import { randHash } from "../../__test_utils__/randHash";
import { IndexedHash } from "../../types";

function indexedHash( idx: number ): IndexedHash
{
    return [ randHash(), idx ];
}

describe("groupConsecutiveTxs", () => {

    test("empty", () => {
        expect( groupConsecutiveTxs( [], [] ) ).toEqual([]);
    });
    
    test("single tx", () => {
        const indexedHashes = [ indexedHash( 0 ) ];
        const index = { start: 128, size: 128 };
        expect( groupConsecutiveTxs( indexedHashes, [ index ] ) )
        .toEqual([
            {
                // txs: [ indexedHashes[0][0] ],
                firstIdx: 0,
                txs: 1,
                start: index.start,
                size: index.size
            }
        ]);
    });

    test("two consecutive txs", () => {
        const h0 = indexedHash( 0 );
        const h1 = indexedHash( 1 );
        const i0 = { start: 128, size: 128 };
        const i1 = { start: 256, size: 128 };
        const indexedHashes = [ h0, h1 ];
        const indexes = [ i0, i1 ];
        const grouped = groupConsecutiveTxs( indexedHashes, indexes );
        expect( grouped )
        .toEqual([
            {
                // txs: [ h0[0], h1[0] ],
                firstIdx: 0,
                txs: 2,
                start: i0.start,
                size: i0.size + i1.size
            }
        ]);
    });

    test("two non-consecutive txs", () => {
        const h0 = indexedHash( 0 );
        const h2 = indexedHash( 2 );
        const i0 = { start: 128, size: 128 };
        const i2 = { start: 512, size: 128 };
        const indexedHashes = [ h0, h2 ];
        const indexes = [ i0, i2 ];
        const grouped = groupConsecutiveTxs( indexedHashes, indexes );
        expect( grouped )
        .toEqual([
            {
                // txs: [ h0[0] ],
                firstIdx: 0,
                txs: 1,
                start: i0.start,
                size: i0.size
            },
            {
                // txs: [ h2[0] ],
                firstIdx: 2,
                txs: 1,
                start: i2.start,
                size: i2.size
            }
        ]);
    });

    test("three consecutive txs", () => {
        const h0 = indexedHash( 0 );
        const h1 = indexedHash( 1 );
        const h2 = indexedHash( 2 );
        const i0 = { start: 128, size: 128 };
        const i1 = { start: 256, size: 128 };
        const i2 = { start: 384, size: 128 };
        const indexedHashes = [ h0, h1, h2 ];
        const indexes = [ i0, i1, i2 ];
        const grouped = groupConsecutiveTxs( indexedHashes, indexes );
        expect( grouped )
        .toEqual([
            {
                // txs: [ h0[0], h1[0], h2[0] ],
                firstIdx: 0,
                txs: 3,
                start: i0.start,
                size: i0.size + i1.size + i2.size
            }
        ]);
    });

    test("three non-consecutive txs", () => {
        const h0 = indexedHash( 0 );
        const h2 = indexedHash( 2 );
        const h4 = indexedHash( 4 );
        const i0 = { start: 128, size: 128 };
        const i2 = { start: 384, size: 128 };
        const i4 = { start: 640, size: 128 };
        const indexedHashes = [ h0, h2, h4 ];
        const indexes = [ i0, i2, i4 ];
        const grouped = groupConsecutiveTxs( indexedHashes, indexes );
        expect( grouped )
        .toEqual([
            {
                // txs: [ h0[0] ],
                firstIdx: 0,
                txs: 1,
                start: i0.start,
                size: i0.size
            },
            {
                // txs: [ h2[0] ],
                firstIdx: 2,
                txs: 1,
                start: i2.start,
                size: i2.size
            },
            {
                // txs: [ h4[0] ],
                firstIdx: 4,
                txs: 1,
                start: i4.start,
                size: i4.size
            }
        ]);
    });

    test("three txs, two consecutive", () => {
        const h0 = indexedHash( 0 );
        const h1 = indexedHash( 1 );
        const h3 = indexedHash( 3 );
        const i0 = { start: 128, size: 128 };
        const i1 = { start: 256, size: 128 };
        const i3 = { start: 512, size: 128 };
        const indexedHashes = [ h0, h1, h3 ];
        const indexes = [ i0, i1, i3 ];
        const grouped = groupConsecutiveTxs( indexedHashes, indexes );
        expect( grouped )
        .toEqual([
            {
                // txs: [ h0[0], h1[0] ],
                firstIdx: 0,
                txs: 2,
                start: i0.start,
                size: i0.size + i1.size
            },
            {
                // txs: [ h3[0] ],
                firstIdx: 3,
                txs: 1,
                start: i3.start,
                size: i3.size
            }
        ]);
    });
});
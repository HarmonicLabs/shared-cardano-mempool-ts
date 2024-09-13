import { start } from "repl";
import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { randTx } from "../__test_utils__/randTx";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus, MempoolIndex } from "../types";
import exp from "constants";


describe("memIndexes", () => {
    const mem = new SharedArrayBuffer( 32768 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();
    const maxTxs = mempool.config.maxTxs;
    const txSize = Math.floor( initialAviableSpace / maxTxs ) - 16;

    let expectedAviableSpace = initialAviableSpace;

    function readAllIndexes(): MempoolIndex[]
    {
        const nTxs = mempool._getTxCount();
        const indexes: MempoolIndex[] = [];
        for( let i = 0; i < nTxs; i++ )
        {
            indexes.push( mempool._readTxIndexAt( i ) );
        }
        return indexes;
    }

    function clearTxs()
    {
        mempool._writeTxCount( 0 );
        mempool._writeAviableSpace( initialAviableSpace );
        expectedAviableSpace = initialAviableSpace;
    }

    test("write maxTxs indexes", async () => {
        for( let i = 0; i < maxTxs; i++ )
        {
            mempool._writeTxIndexAt ( i, { start: mempool.config.startTxsU8 + i * txSize, size: txSize } );
            expectedAviableSpace -= txSize;
            mempool._incrementTxCount();
        }
        mempool._writeAviableSpace( expectedAviableSpace );
        expect( readAllIndexes().length ).toBe( maxTxs );
    });

    test("all indexes are correct", async () => {
        const indexes = readAllIndexes();
        for( let i = 0; i < maxTxs; i++ )
        {
            expect( indexes[i] )
            .toEqual({ start: mempool.config.startTxsU8 + i * txSize, size: txSize });
        }
    });
 
    test("clear and _writeConsecutiveMemIndexes", async () => {
        const initialIndexes = readAllIndexes();
        clearTxs();
        expect( readAllIndexes().length ).toBe( 0 );

        mempool._writeConsecutiveMemIndexes( 0, initialIndexes );
        for( let i = 0; i < maxTxs; i++ )
        {
            mempool._incrementTxCount();
        }
        expectedAviableSpace -= txSize * maxTxs;
        mempool._writeAviableSpace( expectedAviableSpace );
        const nextIndexes = readAllIndexes();

        expect( nextIndexes.length ).toBe( maxTxs );
        expect( nextIndexes ).toEqual( initialIndexes );
    });
});


describe("memIndexes but random", () => {
    const mem = new SharedArrayBuffer( 32768 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();
    const maxTxs = mempool.config.maxTxs;
    
    const _txSize = Math.floor( initialAviableSpace / maxTxs ) - 16;
    const _minSize = 128
    function randSize()
    {
        return Math.floor( Math.random() * (_txSize - _minSize) ) + _minSize;
    }

    let expectedAviableSpace = initialAviableSpace;

    function readAllIndexes(): MempoolIndex[]
    {
        const nTxs = mempool._getTxCount();
        const indexes: MempoolIndex[] = [];
        for( let i = 0; i < nTxs; i++ )
        {
            indexes.push( mempool._readTxIndexAt( i ) );
        }
        return indexes;
    }

    function clearTxs()
    {
        mempool._writeTxCount( 0 );
        mempool._writeAviableSpace( initialAviableSpace );
        expectedAviableSpace = initialAviableSpace;
    }

    let allIdxs: MempoolIndex[] = [];

    test("write maxTxs indexes", async () => {
        let prevIdx: MempoolIndex = { start: mempool.config.startTxsU8, size: 0 };
        for( let i = 0; i < maxTxs; i++ )
        {
            const size = randSize();
            prevIdx = { start: prevIdx.start + prevIdx.size, size };
            allIdxs.push( prevIdx );
            mempool._writeTxIndexAt( i, prevIdx );
            expectedAviableSpace -= size;
            mempool._writeAviableSpace( expectedAviableSpace );
            mempool._incrementTxCount();
        }
        mempool._writeAviableSpace( expectedAviableSpace );
        expect( readAllIndexes().length ).toBe( maxTxs );
    });

    test("all indexes are correct", async () => {
        expect( readAllIndexes() ).toEqual( allIdxs );
    });
 
    test("clear and _writeConsecutiveMemIndexes", async () => {
        const initialIndexes = readAllIndexes();
        const realAviableSpace = mempool._readAviableSpace();
        clearTxs();
        expect( readAllIndexes().length ).toBe( 0 );

        mempool._writeConsecutiveMemIndexes( 0, initialIndexes );
        for( let i = 0; i < maxTxs; i++ )
        {
            mempool._incrementTxCount();
        }
        mempool._writeAviableSpace( realAviableSpace );
        expectedAviableSpace = realAviableSpace;
        const nextIndexes = readAllIndexes();

        expect( nextIndexes.length ).toBe( maxTxs );
        expect( nextIndexes ).toEqual( initialIndexes );
    });

    let nTxs = maxTxs;

    test("move indexes (overwrite middle)", async () => {
        const initialIndexes = readAllIndexes();
        const realAviableSpace = mempool._readAviableSpace();

        expect( realAviableSpace ).toBe( expectedAviableSpace );
        expect( mempool._getTxCount() ).toBe( nTxs );

        const to = Math.floor(maxTxs / 2);
        const from = Math.floor(maxTxs * 5 / 6);

        const moved = initialIndexes.slice( from );
        const removed = initialIndexes.slice( to, from );

        const totRemovedSpace = removed.reduce( (acc, idx) => acc + idx.size, 0 );
        nTxs -= removed.length;

        mempool._writeConsecutiveMemIndexes(
            to,
            moved,
            -totRemovedSpace
        );

        mempool._subTxCount( removed.length );
        expectedAviableSpace = expectedAviableSpace + totRemovedSpace;
        mempool._writeAviableSpace ( expectedAviableSpace );

        const nextIndexes = readAllIndexes();
        const expectedNext = initialIndexes.slice( 0, to ).concat( moved );

        expect( nextIndexes.length ).toBe( maxTxs - removed.length );
        expect( nextIndexes.length ).toBe( expectedNext.length );
        expect( nextIndexes ).toEqual( expectedNext );
    });

    test("move indexes (overwrite start)", async () => {
        const initialIndexes = readAllIndexes();
        const realAviableSpace = mempool._readAviableSpace();

        expect( realAviableSpace ).toBe( expectedAviableSpace );
        expect( mempool._getTxCount() ).toBe( nTxs );

        const to = 0;
        const from = Math.floor(nTxs / 2);

        const moved = initialIndexes.slice( from );
        const removed = initialIndexes.slice( to, from );

        const totRemovedSpace = removed.reduce( (acc, idx) => acc + idx.size, 0 );

        mempool._writeConsecutiveMemIndexes(
            to,
            moved,
            -totRemovedSpace
        );

        mempool._subTxCount( removed.length );
        expectedAviableSpace = expectedAviableSpace + totRemovedSpace;
        mempool._writeAviableSpace( expectedAviableSpace );

        const nextIndexes = readAllIndexes();
        const expectedNext = initialIndexes.slice( 0, to ).concat( moved );

        expect( nextIndexes.length ).toBe( nTxs - removed.length );
        expect( nextIndexes.length ).toBe( expectedNext.length );
        expect( nextIndexes ).toEqual( expectedNext );
        expect( mempool._getTxCount() ).toBe( Math.floor(nTxs / 2) );
        nTxs = Math.floor(nTxs / 2);
    });

});
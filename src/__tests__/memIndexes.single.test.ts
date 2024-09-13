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

    test("read indexes", async () => {
        const indexes = readAllIndexes();
        expect( indexes.length ).toBe( 0 );        
    });

    test("write 1 index", async () => {
        mempool._writeTxIndexAt ( 0, { start: mempool.config.startTxsU8, size: txSize } );
        expectedAviableSpace -= txSize;
        mempool._incrementTxCount();
    });

    test("read indexes", async () => {
        const indexes = readAllIndexes();
        expect( indexes.length ).toBe( 1 );
        expect( indexes[0] )
        .toEqual({ start: mempool.config.startTxsU8, size: txSize });        
    });

    function clearTxs()
    {
        mempool._writeTxCount( 0 );
        mempool._writeAviableSpace( initialAviableSpace );
        expectedAviableSpace = initialAviableSpace;
    }

    test("set nTxs to 0 and read indexes", async () => {
        clearTxs();
        const indexes = readAllIndexes();
        expect( indexes.length ).toBe( 0 );        
    });

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
});
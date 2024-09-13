import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { randTx } from "../__test_utils__/randTx";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus } from "../types/MempoolAppendResult";
import { MempoolTx } from "../types/MempoolTx";
import { eqMempoolTxHash, mempoolTxHashFromString, mempoolTxHashToString } from "../types/MempoolTxHash";
import { MempoolSize } from "../types/SupportedMempoolSize";


let MAX_TX_SIZE = 1024;
const MIN_TX_SIZE = 128;

jest.setTimeout( 60_000 );

function randSize()
{
    const MAX_RANDOM_TX_SIZE = MAX_TX_SIZE - MIN_TX_SIZE;
    return Math.floor( Math.random() * MAX_RANDOM_TX_SIZE ) + MIN_TX_SIZE;
}

const knownHashes = new Map<string, MempoolTx>();

function getTx( txSize: number )
{
    let tx: MempoolTx;
    do {
        tx = randTx( txSize );
    } while( knownHashes.has( mempoolTxHashToString( tx.hash ) ) );
    knownHashes.set( mempoolTxHashToString( tx.hash ), tx );
    return tx;
}

describe("append-drop", ()=> {
    const mem = new SharedArrayBuffer( MempoolSize.kb32 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();
    const maxTxsBySpace = Math.max(
        5, // always at least 5 txs
        Math.floor( initialAviableSpace / MAX_TX_SIZE ) - 2
    );

    let nTxs = 0;

    let expectedAviableSpace = initialAviableSpace;

    test("append many", async () => {
        let status = MempoolAppendStatus.Ok;
        let txSize = 0;
        while( nTxs < maxTxsBySpace )
        {
            txSize = randSize();
            const { hash, bytes } = getTx( txSize );
            const appendResult = await mempool.append( hash, bytes );
            status = appendResult.status;

            expect( status ).toBe( MempoolAppendStatus.Ok );
            expect( appendResult.nTxs ).toBe( ++nTxs );
            expect( appendResult.aviableSpace ).toBe( expectedAviableSpace -= bytes.length );
        }
    });

    test("drop inexistent", async () => {
        const { hash } = getTx( randSize() );
        await mempool.drop([ hash ]);
        expect( await mempool.getTxCount() ).toBe( nTxs );
        expect( mempool._readAviableSpace() ).toBe( expectedAviableSpace );
    });

    test("drop last", async () => {
        const hs = await mempool.getTxHashesAndSizes();

        const { hash, size: txSize } = hs[ hs.length - 1 ];

        await mempool.drop([ hash ]);
        expectedAviableSpace -= txSize;
        nTxs--;

        expect( await mempool.getTxCount() ).toBe( nTxs );
        expect( mempool._readAviableSpace() ).toBe( expectedAviableSpace );
        expect( await mempool.getTxHashesAndSizes() ).toEqual( hs.slice( 0, hs.length - 1 ) );
    });

    test("drop middle", async () => {
        const hs = await mempool.getTxHashesAndSizes();
        const hashes = hs.map(({ hash }) => hash );

        // const hashesBefore = hashes.map( mempoolTxHashToString );

        const { hash, size: txSize } = hs[ hs.length >>> 1 ];

        await mempool.drop([ hash ]);
        expectedAviableSpace += txSize;
        nTxs--;

        const filteredBefore = hashes.filter( h => !eqMempoolTxHash( h, hash ) )
        .map( mempoolTxHashToString );

        const hashesAfter = (await mempool.getTxHashes())
        .map( h => mempoolTxHashToString( h ) );


        expect( await mempool.getTxCount() ).toBe( nTxs );
        expect( mempool._readAviableSpace() ).toBe( expectedAviableSpace );
        expect( hashesAfter.length ).toEqual( filteredBefore.length );
        
        expect( hashesAfter ).toEqual( filteredBefore );

        const newSizes = (await mempool.getTxHashesAndSizes()).map?.(({ size }) => size );
        const expectedSizes = (
            hs.filter( ({ hash: h }) => !eqMempoolTxHash( h, hash ) )
            .map(({ size }) => size )
        );

        expect(
            JSON.stringify( newSizes )
        ).toEqual(
            JSON.stringify( expectedSizes )
        );
    });

    test("drop first", async () => {
        const hs = await mempool.getTxHashesAndSizes();

        const { hash, size: txSize } = hs[ 0 ];

        await mempool.drop([ hash ]);
        expectedAviableSpace += txSize;
        nTxs--;

        expect( await mempool.getTxCount() ).toBe( nTxs );
        expect( mempool._readAviableSpace() ).toBe( expectedAviableSpace );
        expect( await mempool.getTxHashesAndSizes() ).toEqual( hs.slice( 1 ) );
    });

    test("drop all", async () => {
        const hashes = await mempool.getTxHashes();

        await mempool.drop( hashes );
        expectedAviableSpace = initialAviableSpace;
        nTxs = 0;

        expect( await mempool.getTxCount() ).toBe( nTxs );
        expect( mempool._readAviableSpace() ).toBe( expectedAviableSpace );
        expect( await mempool.getTxHashesAndSizes() ).toEqual( [] );
    });

    test("append until maxTx", async () => {
        MAX_TX_SIZE = 256;
        let status = MempoolAppendStatus.Ok;
        let txSize = 0;
        while( status === MempoolAppendStatus.Ok )
        {
            txSize = randSize();
            const { hash, bytes } = getTx( txSize );
            const appendResult = await mempool.append( hash, bytes );
            status = appendResult.status;
            if( status === MempoolAppendStatus.Ok )
            {
                expect( appendResult.nTxs ).toBe( ++nTxs );
                expect( appendResult.aviableSpace ).toBe( expectedAviableSpace -= bytes.length );
            }
        }
        expect( await mempool.getTxCount() ).toBe( mempool.config.maxTxs );
    });

    test("drop middle on maxTxs", async () => {
        const hs = await mempool.getTxHashes();

        const hash = hs[ hs.length >>> 1 ];

        await mempool.drop([ hash ]);
        nTxs--;

        expect( await mempool.getTxCount() ).toBe( nTxs );
    })
});
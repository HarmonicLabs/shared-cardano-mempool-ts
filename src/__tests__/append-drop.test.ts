import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { randTx } from "../__test_utils__/randTx";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus } from "../types/MempoolAppendResult";
import { MempoolTx } from "../types/MempoolTx";
import { mempoolTxHashFromString, mempoolTxHashToString } from "../types/MempoolTxHash";
import { MempoolSize } from "../types/SupportedMempoolSize";


const MAX_TX_SIZE = 1024;
const MIN_TX_SIZE = 128;

const MAX_RANDOM_TX_SIZE = MAX_TX_SIZE - MIN_TX_SIZE;

function randSize()
{
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
    let mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

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

    test("drpo first", async () => {
        const hs = await mempool.getTxHashesAndSizes();

        const { hash, size: txSize } = hs[ 0 ];

        await mempool.drop([ hash ]);
        expectedAviableSpace -= txSize;
        nTxs--;

        expect( await mempool.getTxCount() ).toBe( nTxs );
        expect( mempool._readAviableSpace() ).toBe( expectedAviableSpace );
        expect( await mempool.getTxHashesAndSizes() ).toEqual( hs.slice( 1 ) );
    })
});
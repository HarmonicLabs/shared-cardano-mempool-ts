import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus } from "../types/MempoolAppendResult";
import { MempoolTx } from "../types/MempoolTx";
import { mempoolTxHashFromString, mempoolTxHashToString } from "../types/MempoolTxHash";
import { randTx } from "../__test_utils__/randTx";
import exp from "constants";

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

describe("Mempool write and read", () => {

    const mem = new SharedArrayBuffer( 32768 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();
    const maxTxs = mempool.config.maxTxs;
    const txSize = Math.floor( initialAviableSpace / maxTxs ) - 16;


    let expectedAviableSpace = initialAviableSpace;

    test("append maxTx - 1", async () => {

        for( let i = 0; i < maxTxs - 1;  )
        {
            const { hash, bytes } = getTx( txSize );
            const appendResult = await mempool.append( hash, bytes );
    
            expect( appendResult.status ).toBe( MempoolAppendStatus.Ok );
            expect( appendResult.nTxs ).toBe( ++i );
            expect( appendResult.aviableSpace ).toBe( expectedAviableSpace -= bytes.length );
        }

    });

    test("read maxTx - 1", async () => {
        expect( await mempool.getTxCount() ).toBe( maxTxs - 1 );
        expect( await mempool.getAviableSpace() ).toBe( expectedAviableSpace );
        expect( await mempool.getTxHashes() ).toEqual( [ ...knownHashes.keys() ].map( mempoolTxHashFromString ) );

        expect( (await mempool.getTxHashesAndSizes()).map(({ size }) => size) )
        .toEqual( new Array( maxTxs - 1 ).fill( txSize ) );
    });

    test("append last", async () => {

        const { hash, bytes } = getTx( txSize );
        const appendResult = await mempool.append( hash, bytes );

        expect( appendResult.status ).toBe( MempoolAppendStatus.Ok );
        expect( appendResult.nTxs ).toBe( maxTxs );
        expect( appendResult.aviableSpace ).toBe( expectedAviableSpace -= bytes.length );

    });

    test("append on full", async () => {

        const { hash, bytes } = getTx( txSize );
        const appendResult = await mempool.append( hash, bytes );

        expect( appendResult.status ).toBe( MempoolAppendStatus.MaxTxsReached );
        expect( appendResult.nTxs ).toBe( maxTxs );
        expect( appendResult.aviableSpace ).toBe( expectedAviableSpace );

        knownHashes.delete( mempoolTxHashToString( hash ) );
    });

    test("correct nTxs", async () => {
        expect( await mempool.getTxCount() )
        .toBe( maxTxs );
    });

    test("correct aviable space", async () => {
        expect( await mempool.getAviableSpace() )
        .toBe( expectedAviableSpace );
    });

    test("correct tx hashes", async () => {
        const hashes = await mempool.getTxHashes();

        const mapHashes = [ ...knownHashes.keys() ].map( mempoolTxHashFromString );

        expect( hashes ).toEqual( mapHashes );
    })
})
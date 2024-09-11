import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus } from "../types/MempoolAppendResult";
import { MempoolTx } from "../types/MempoolTx";
import { mempoolTxHashFromString, mempoolTxHashToString } from "../types/MempoolTxHash";
import { randTx } from "../__test_utils__/randTx";
import exp from "constants";

const knownHashes = new Map<string, number>();

function getTx( txSize: number )
{
    let tx: MempoolTx;
    do {
        tx = randTx( txSize );
    } while( knownHashes.has( mempoolTxHashToString( tx.hash ) ) );
    return tx;
}

let MAX_TX_SIZE = 256;
let MIN_TX_SIZE = 128;

const MAX_RANDOM_TX_SIZE = MAX_TX_SIZE - MIN_TX_SIZE;

function randSize()
{
    return Math.floor( Math.random() * MAX_RANDOM_TX_SIZE ) + MIN_TX_SIZE;
}

describe("Mempool write and read", () => {
    const mem = new SharedArrayBuffer( 32768 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();
    const maxTxs = mempool.config.maxTxs;

    let expectedAviableSpace = initialAviableSpace;

    describe("InsufficientSpace", () => {
        MAX_TX_SIZE = 16384;
        MIN_TX_SIZE = Math.ceil( mempool.config.size / mempool.config.maxTxs ) + 32;
    
        test("mempool reset", () => {
            expect( mempool._getTxCount() ).toBe( 0 );
            expect( mempool._readAviableSpace() ).toBe( initialAviableSpace );
        });
    
        test("append until Error", async () => {
    
            let i = 0;
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
                    expect( appendResult.nTxs ).toBe( ++i );
                    expect( appendResult.aviableSpace ).toBe( expectedAviableSpace -= bytes.length );
        
                    knownHashes.set( mempoolTxHashToString( hash ), txSize );
                }
                else
                {
                    expect( status ).toBe( MempoolAppendStatus.InsufficientSpace );
                    expect( appendResult.nTxs ).toBe( i );
                    expect( appendResult.aviableSpace ).toBe( expectedAviableSpace );
                }
            }
    
        });
    
        test("read maxTx - 1", async () => {
            expect( await mempool.getTxHashes() ).toEqual( [ ...knownHashes.keys() ].map( mempoolTxHashFromString ) );
    
            expect( (await mempool.getTxHashesAndSizes()).map(({ size }) => size) )
            .toEqual( [ ...knownHashes.values() ] );
        });
    });

});
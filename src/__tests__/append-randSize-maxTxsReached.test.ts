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
    let mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();
    const maxTxs = mempool.config.maxTxs;

    let expectedAviableSpace = initialAviableSpace;

    describe("MaxTxsReached", () => {
        MAX_TX_SIZE = Math.floor( initialAviableSpace / maxTxs ) - 32;
        MIN_TX_SIZE = 128;

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
                    expect( status ).toBe( MempoolAppendStatus.MaxTxsReached );
                    expect( appendResult.nTxs ).toBe( i );
                    expect( appendResult.aviableSpace ).toBe( expectedAviableSpace );
                }
            }
    
        });
    
        test("read maxTx", async () => {
            expect( await mempool.getTxCount() ).toBe( maxTxs );
            expect( await mempool.getAviableSpace() ).toBe( expectedAviableSpace );
            expect( await mempool.getTxHashes() ).toEqual( [ ...knownHashes.keys() ].map( mempoolTxHashFromString ) );
    
            expect( (await mempool.getTxHashesAndSizes()).map(({ size }) => size ))
            .toEqual( [ ...knownHashes.values() ] );
        });
    });

});
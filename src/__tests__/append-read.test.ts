import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus } from "../types/MempoolAppendResult";
import { MempoolTx } from "../types/MempoolTx";
import { MempoolTxHash, U8Arr32 } from "../types/MempoolTxHash";

describe("Mempool write and read", () => {

    const mem = new SharedArrayBuffer( 32768 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    const initialAviableSpace = mempool._readAviableSpace();

    const hash = new Int32Array( 8 ).fill( 0xffffffff );
    const tx = new Uint8Array( 128 ).fill( 0xaa );

    const hash2 = new Int32Array( 8 ).fill( 0xbbbbbbbb );
    const tx2 = new Uint8Array( 128 ).fill( 0xcc );


    test("0 tx in mempool", async () => {
        expect( await mempool.getTxCount() ).toBe( 0 );
    });

    test("append", async () => {

        const appendResult = await mempool.append( hash, tx );

        expect( appendResult.status ).toBe( MempoolAppendStatus.Ok );
        expect( appendResult.nTxs ).toBe( 1 );
        expect( appendResult.aviableSpace ).toBe( initialAviableSpace - tx.length );

    });

    test("1 tx in mempool", async () => {
        expect( await mempool.getTxCount() ).toBe( 1 );
    });

    test("correct tx hashes", async () => {
            
        const hashes = await mempool.getTxHashes();
        
        expect( hashes.length ).toBe( 1 );
        expect( hashes[0] ).toEqual( hash );
    });

    test("read single tx", async () => {

        const txs = await mempool.getTxs([ hash ]);
        
        expect( txs.length ).toBe( 1 );

        expect( txs[0] )
        .toEqual({
            hash: new Uint8Array( hash.buffer ),
            bytes: tx
        } as MempoolTx);

    });

    test("read tx not present", async () => {

        const txs = await mempool.getTxs([ hash2 ]);
        
        expect( txs.length ).toBe( 0 );
    });

    test("append 2", async () => {

        const appendResult = await mempool.append( hash2, tx2 );

        expect( appendResult.status ).toBe( MempoolAppendStatus.Ok );
        expect( appendResult.nTxs ).toBe( 2 );
        expect( appendResult.aviableSpace ).toBe( initialAviableSpace - tx.length - tx2.length );

    });

    test("2  tx in mempool", async () => {
        expect( await mempool.getTxCount() ).toBe( 2 );
    });

    test("correct tx hashes 2", async () => {
        const hashes = await mempool.getTxHashes();
        
        expect( hashes.length ).toBe( 2 );
        expect( hashes[0] ).toEqual( hash );
        expect( hashes[1] ).toEqual( hash2 );
    });

    test("read single tx 2", async () => {

        const txs = await mempool.getTxs([ hash2 ]);
        
        expect( txs.length ).toBe( 1 );

        expect( txs[0] )
        .toEqual({
            hash: new Uint8Array( hash2.buffer ),
            bytes: tx2
        } as MempoolTx);

    });
})
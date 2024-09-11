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

    const size = 512;

    const hash = new Int32Array( 8 ).fill( 0xffffffff );
    const tx = new Uint8Array( size ).fill( 0xaa );

    const hash2 = new Int32Array( 8 ).fill( 0xbbbbbbbb );
    const tx2 = new Uint8Array( size ).fill( 0xcc );

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

    test("correct tx size", async () => {
            
        const hashes = await mempool.getTxHashesAndSizes();
        
        expect( hashes.length ).toBe( 1 );
        expect( hashes[0] ).toEqual({ hash, size });
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

    test("correct 2 sizes", async () => {
        const hashes = await mempool.getTxHashesAndSizes();
        
        expect( hashes.length ).toBe( 2 );
        expect( hashes[0] ).toEqual({ hash, size });
        expect( hashes[1] ).toEqual({ hash: hash2, size });
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

    test("correct tx hashes 2", async () => {
        
        const hashes = await mempool.getTxHashes();
        
        expect( hashes.length ).toBe( 2 );
        expect( hashes ).toEqual([ hash, hash2 ]);
    });

    test("correct sizes", async () => {

        expect( await mempool.getTxCount() ).toBe( 2 );
        
        const hashes = await mempool.getTxHashesAndSizes();
        
        expect( hashes.length ).toBe( 2 );
        // expect( hashes[0] ).toEqual({ hash, size });
        expect( hashes[1] ).toEqual({ hash: hash2, size });
    });

    test("append same", async () => {

        const appendResult = await mempool.append( hash, tx );

        console.log( appendResult );
        expect( appendResult.status ).toBe( MempoolAppendStatus.AlreadyPresent );
        expect( appendResult.nTxs ).toBe( 2 );
        expect( appendResult.aviableSpace ).toBe( initialAviableSpace - tx.length - tx2.length );

    });

    test("same mempool state", async () => {

        expect( await mempool.getTxCount() ).toBe( 2 );
        
        const hashes = await mempool.getTxHashesAndSizes();
        
        expect( hashes.length ).toBe( 2 );
        expect( hashes ).toEqual([ { hash, size }, { hash: hash2, size } ]);

    });

})